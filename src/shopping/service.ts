// Deal watching and buying.
//
//   sources (product pages, RSS/Atom feeds, X) → a matching deal → verify the real store listing
//   (exact item, seller, currency, price, stock) → alert with Buy / Skip / Open → your Buy, bound to
//   that exact quote and cap, expiring → re-check the listing (any material change asks again) →
//   checkout in the shopping browser through PurchaseExecution → confirmed only with a receipt.
//
// Auto-buy is off in this release (AUTO_BUY_ENABLED). Nothing is ever retried after an uncertain
// result, and a restart never re-runs a purchase.
import { loadBot } from "../agent/bot.js";
import { Agent } from "../agent/runtime.js";
import type { Config } from "../config.js";
import type { McpManager } from "../mcp/client.js";
import { openSecretStore, type SecretStore } from "../secrets.js";
import type { Store } from "../store/store.js";
import { guardedFetcher } from "../tools/netguard.js";
import type { ShopBrowser } from "./browser-tools.js";
import { itemPhrases, PurchaseExecution } from "./execution.js";
import { matchesKeywords, parseFeed, parseProductPage, priceFromText, type ProductInfo } from "./extract.js";
import { formatMoney, withAllowance, type Money } from "./money.js";
import { redactPII, sanitizeUrl } from "./pii.js";
import { dealKey, siteOf } from "./site.js";
import { RateLimitError, renderWithService, SourceCredentials, SourceError, XClient, xQueryFor, type SourceId } from "./sources.js";
import { newApproval, quoteOf, ShoppingState, type Deal, type Listing, type Watch } from "./state.js";

export interface ShoppingHooks {
  /** A deal is waiting for Buy / Skip (`reconfirm`: details changed since you approved). */
  onDeal?: (deal: Deal, watch: Watch | undefined, opts: { reconfirm?: boolean }) => void;
  /** A deal moved on: paused (needs you), confirmed, failed, uncertain, expired. */
  onUpdate?: (deal: Deal) => void;
  /** Anything changed (refresh the UI). */
  onChange?: () => void;
  /** Read a product with a real browser when a plain download can't (desktop app). */
  readWithBrowser?: (url: string, currency: string) => Promise<ProductInfo>;
  /** The visible shopping browser used for checkout (desktop app only). */
  getBrowser?: () => ShopBrowser | undefined;
  /** Lock / unlock the shopping browser's navigation to the approved store. */
  beginExecution?: (x: PurchaseExecution) => void;
  endExecution?: () => void;
  secrets?: SecretStore;
  log?: (msg: string) => void;
}

export interface CheckResult {
  ok: boolean;
  summary: string;
  info?: ProductInfo;
  deal?: Deal;
  error?: string;
  hint?: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SlopBot/0.1 (+https://github.com/CameronWDavis/SlopBot)";
const MAX_BYTES = 4 * 1024 * 1024;
const HOST_SPACING_MS = 20_000;
const MAX_BACKOFF_MS = 6 * 3600_000;
const iso = () => new Date().toISOString();
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

class WatchError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

/** Which model does checkout, and does it run on this computer? */
export function checkoutModel(config: Config, botName: string): { model: string; local: boolean } {
  let model = config.defaultModel ?? "";
  try {
    model = loadBot(config, botName).model ?? model;
  } catch {}
  const provider = model.split("/")[0];
  const base = (config.providers?.[provider] as any)?.baseUrl ?? "";
  const local = provider === "ollama" || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
  return { model, local };
}

/** Facts for alerts: listing details only, no personal data. */
export function describeDeal(d: Deal) {
  const l = d.listing;
  return {
    item: l.title,
    seller: l.seller ?? "seller not shown",
    store: siteOf(new URL(l.url).hostname),
    quantity: d.quantity,
    currency: l.price.currency,
    price: formatMoney(l.price),
    cap: formatMoney(d.cap),
    url: sanitizeUrl(l.url),
    expires: d.approval?.expiresAt,
  };
}

export class ShoppingService {
  readonly state: ShoppingState;
  readonly credentials: SourceCredentials;
  /** The purchase in progress, if any. */
  execution?: PurchaseExecution;
  private timer?: NodeJS.Timeout;
  private checking = new Set<string>();
  private hostHits = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private config: Config,
    private store: Store,
    private hooks: ShoppingHooks = {},
    private mcp?: McpManager,
  ) {
    this.state = new ShoppingState(config.dataDir);
    this.credentials = new SourceCredentials(hooks.secrets ?? openSecretStore(config.dataDir));
    this.recoverAfterRestart();
  }

  private log(m: string) {
    this.hooks.log?.(m);
  }
  private changed() {
    this.hooks.onChange?.();
  }

  /** After a restart nothing resumes by itself, and nothing that might have ordered is retried. */
  private recoverAfterRestart() {
    for (const d of this.state.deals()) {
      if (d.status === "submitted" || ((d.status === "reviewing" || d.status === "paused") && d.execution?.submittedAt)) {
        this.state.transition(d.id, "uncertain", { note: "SlopBot closed during checkout after an order step. Check your store account for this order before trying again." });
      } else if (d.status === "queued" || d.status === "reviewing" || d.status === "paused") {
        this.state.transition(d.id, "failed", { note: "SlopBot closed before checkout finished. Nothing was submitted." });
      }
    }
  }

  start(tickMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), tickMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Expire stale approvals, then check every watch that's due (spacing requests to the same site). */
  async tick(now = Date.now()) {
    for (const d of this.state.deals()) {
      if (d.status === "pending" && d.approval && Date.parse(d.approval.expiresAt) < now) {
        const e = this.state.transition(d.id, "expired", { note: "The Buy button expired. Use Check again for a fresh price." }, ["pending"]);
        this.hooks.onUpdate?.(e);
        this.changed();
      }
    }
    const due = this.state.watches().filter((w) => w.enabled && !this.checking.has(w.id) && (!w.nextCheckAt || Date.parse(w.nextCheckAt) <= now));
    for (const w of due.slice(0, 5)) {
      const host = this.hostOf(w);
      if (host && now - (this.hostHits.get(host) ?? 0) < HOST_SPACING_MS) continue; // next tick
      await this.check(w.id).catch(() => {});
    }
  }

  private hostOf(w: Watch) {
    if (w.kind.startsWith("x_")) return "api.x.com";
    try {
      return new URL(w.url!).hostname;
    } catch {
      return "";
    }
  }

  private async download(url: string): Promise<string> {
    const target = new URL(url);
    this.hostHits.set(target.hostname, Date.now());
    const net = guardedFetcher(target, this.config.network?.allowPrivate ?? []);
    try {
      const res = await net.fetch(target, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
        redirect: "follow", // every hop's address is checked at connect time by the guarded agent
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after"));
        throw new WatchError(`${target.hostname} asked SlopBot to slow down`, "Checks resume later on their own; a longer interval avoids this.", Date.now() + (after > 0 ? after * 1000 : 15 * 60_000));
      }
      if (res.status === 403) throw new WatchError(`${target.hostname} refused the automated check (403)`, "Open the page once in the shopping browser, add a page-rendering service in Deal sources, or follow this item through a deal feed.");
      if (!res.ok) throw new WatchError(`${target.hostname} answered ${res.status}`, res.status === 404 ? "Check that the address is still the product's page." : undefined);
      return Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES).toString("utf8");
    } finally {
      net.close();
    }
  }

  /** Read a store listing: plain download, then the shopping browser, then a rendering service. */
  async readListing(url: string, currency: string): Promise<ProductInfo & { url: string }> {
    let info: ProductInfo = { source: "none" };
    let lastErr: unknown;
    try {
      info = parseProductPage(await this.download(url), currency);
    } catch (e) {
      lastErr = e;
      if (e instanceof WatchError && e.retryAt) throw e;
    }
    if (!info.price && !info.priceProblem && this.hooks.readWithBrowser) {
      try {
        info = await this.hooks.readWithBrowser(url, currency);
        lastErr = undefined;
      } catch (e) {
        lastErr = e;
      }
    }
    const svc = this.state.settings().renderService;
    if (!info.price && !info.priceProblem && svc !== "none") {
      const key = this.credentials.get(svc);
      if (key) {
        try {
          info = { ...parseProductPage(await renderWithService(svc, key, url, { allowPrivate: this.config.network?.allowPrivate }), currency), source: "service" };
          lastErr = undefined;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (!info.price) {
      if (info.priceProblem) throw new WatchError(`Can't use this price: ${info.priceProblem}`, "Set the watch's currency to the store's currency, or watch the store's page for your country.");
      if (lastErr instanceof WatchError || lastErr instanceof SourceError) throw lastErr;
      throw new WatchError(lastErr instanceof Error ? lastErr.message : "Couldn't find a price on this page", "Use the product's own page (not search results). Stores that block automated checks can be read with a page-rendering service (Deal sources).");
    }
    return { ...info, url };
  }

  /** Why a verified listing doesn't satisfy the watch (empty = it does). */
  mismatches(w: Watch, info: ProductInfo): string[] {
    const why: string[] = [];
    const title = norm(info.title ?? "");
    if (!info.price) return ["no price"];
    if (info.price.currency !== w.currency) why.push(`priced in ${info.price.currency}, not ${w.currency}`);
    if (info.inStock === false) why.push("sold out");
    if (w.target && info.price.minor > w.target.minor) why.push(`${formatMoney(info.price)} is above your ${formatMoney(w.target)}`);
    for (const v of w.variants) if (!title.includes(norm(v))) why.push(`listing doesn't say "${v}"`);
    if (w.kind === "product") for (const k of w.keywords) if (!title.includes(norm(k))) why.push(`listing doesn't mention "${k}"`);
    for (const x of w.exclude) if (title.includes(norm(x))) why.push(`listing mentions "${x}"`);
    if (w.sellers.length) {
      const s = norm(info.seller ?? "");
      if (!s) why.push("the seller isn't shown, so it can't be confirmed");
      else if (!w.sellers.some((ok) => s.includes(norm(ok)) || norm(ok).includes(s))) why.push(`sold by ${info.seller}, not ${w.sellers.join(" / ")}`);
    }
    return why;
  }

  /** Check one watch now. */
  async check(id: string): Promise<CheckResult> {
    const watch = this.state.watches().find((w) => w.id === id);
    if (!watch) throw new Error("No such watch");
    this.checking.add(id);
    const started = Date.now();
    try {
      const r = watch.kind === "product" ? await this.checkProduct(watch) : watch.kind === "feed" ? await this.checkFeed(watch) : await this.checkX(watch);
      this.state.patchWatch(id, { lastCheckedAt: iso(), lastSuccessAt: iso(), failures: 0, lastError: undefined, lastHint: undefined, lastSummary: r.summary, nextCheckAt: new Date(started + watch.everyMinutes * 60_000).toISOString() });
      return r;
    } catch (e: any) {
      const failures = (watch.failures ?? 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, watch.everyMinutes * 60_000 * 2 ** Math.min(failures - 1, 8));
      const retryAt = e instanceof RateLimitError ? e.retryAt : e instanceof WatchError && e.retryAt ? e.retryAt : started + backoff;
      const error = e?.message ?? String(e);
      const hint = e instanceof WatchError || e instanceof SourceError ? e.hint : undefined;
      this.state.patchWatch(id, { lastCheckedAt: iso(), lastError: error, lastHint: hint, failures, nextCheckAt: new Date(Math.max(retryAt, started + 60_000)).toISOString() });
      return { ok: false, summary: error, error, hint };
    } finally {
      this.checking.delete(id);
      this.changed();
    }
  }

  private async checkProduct(watch: Watch): Promise<CheckResult> {
    const info = await this.readListing(watch.url!, watch.currency);
    const why = this.mismatches(watch, info);
    const patch: Partial<Watch> = { lastPrice: info.price, lastInStock: info.inStock, lastTitle: info.title, lastSeller: info.seller };
    if (info.inStock === false || (watch.target && info.price!.minor > watch.target.minor)) patch.alertedMinor = undefined;
    let deal: Deal | undefined;
    if (!why.length && (watch.alertedMinor === undefined || info.price!.minor < watch.alertedMinor)) {
      deal = this.found(watch, { url: watch.url!, title: info.title ?? watch.name, price: info.price!, seller: info.seller, inStock: info.inStock, checkedAt: iso() }, "product page");
      if (deal) patch.alertedMinor = info.price!.minor;
    }
    this.state.patchWatch(watch.id, patch);
    const stock = info.inStock === true ? "in stock" : info.inStock === false ? "sold out" : "stock not shown";
    return { ok: true, summary: `${formatMoney(info.price)}, ${stock}${info.seller ? `, sold by ${info.seller}` : ""}${deal ? " → deal!" : why.length ? ` (${why[0]})` : ""}`, info, deal };
  }

  /** Verify posts that look like deals against their store listing. */
  private async verifyCandidates(watch: Watch, cands: { title: string; url?: string; price?: Money; source: string; postUrl?: string }[]) {
    let deal: Deal | undefined;
    const notes: string[] = [];
    for (const c of cands.slice(0, 3)) {
      if (!c.url) {
        notes.push("a matching post had no store link");
        continue;
      }
      try {
        const info = await this.readListing(c.url, watch.currency);
        const why = this.mismatches(watch, info);
        if (why.length) {
          notes.push(`store check: ${why[0]}`);
          continue;
        }
        deal = this.found(watch, { url: c.url, title: info.title ?? c.title, price: info.price!, seller: info.seller, inStock: info.inStock, checkedAt: iso() }, c.source, c.postUrl) ?? deal;
      } catch (e: any) {
        notes.push(`couldn't check the store page (${e.message})`);
      }
    }
    return { deal, notes };
  }

  private prefilter(watch: Watch, title: string, price?: Money) {
    return matchesKeywords(title, watch.keywords, watch.exclude) && (!watch.target || !price || (price.currency === watch.currency && price.minor <= watch.target.minor));
  }

  private async checkFeed(watch: Watch): Promise<CheckResult> {
    const items = parseFeed(await this.download(watch.url!), watch.url!, watch.currency);
    if (!items.length) throw new WatchError("That address isn't an RSS/Atom feed (or it's empty)", "For Reddit use e.g. https://www.reddit.com/r/buildapcsales/new/.rss");
    const first = watch.seen === undefined;
    const seen = new Set(watch.seen ?? []);
    const fresh = items.filter((i) => !seen.has(i.id));
    this.state.patchWatch(watch.id, { seen: [...items.map((i) => i.id), ...(watch.seen ?? [])].slice(0, 500) });
    if (first) return { ok: true, summary: `Watching ${items.length} posts; new matching posts will be checked against the store` };
    let label = "feed";
    try {
      const u = new URL(watch.url!);
      label = u.pathname.match(/\/r\/[^/]+/)?.[0]?.slice(1) ?? u.hostname;
    } catch {}
    const matches = fresh.filter((i) => this.prefilter(watch, i.title, i.price));
    const { deal, notes } = await this.verifyCandidates(
      watch,
      matches.map((m) => ({ title: m.title, url: m.dealUrl, price: m.price, source: label, postUrl: m.link })),
    );
    return { ok: true, summary: `${fresh.length} new post${fresh.length === 1 ? "" : "s"}, ${matches.length} matched${deal ? " → deal!" : notes.length ? ` (${notes[0]})` : ""}`, deal };
  }

  private async checkX(watch: Watch): Promise<CheckResult> {
    const token = this.credentials.get("x");
    if (!token) throw new WatchError("No X API token saved", "Add your X bearer token in Deal sources, or watch an RSS feed instead.");
    const left = this.state.xBudgetLeft();
    if (left < 10) throw new WatchError("This month's X read limit is used up", "Raise the monthly limit in Deal sources if your X plan allows more.", Date.now() + 24 * 3600_000);
    const client = new XClient(token, undefined, this.config.network?.allowPrivate ?? []);
    const posts = await client.search(xQueryFor(watch.kind as "x_account" | "x_search", watch.xQuery!), watch.sinceId, Math.min(10, left));
    this.state.useX(posts.length);
    const newest = posts.reduce((m, p) => (BigInt(p.id) > BigInt(m || "0") ? p.id : m), watch.sinceId ?? "");
    const first = watch.sinceId === undefined;
    this.state.patchWatch(watch.id, { sinceId: newest || watch.sinceId || "0" });
    if (first) return { ok: true, summary: "Connected; new posts from now on will be checked against the store" };
    const matches = posts.filter((p) => this.prefilter(watch, p.text, priceFromText(p.text, watch.currency)));
    const source = watch.kind === "x_account" ? `X ${watch.name}` : "X search";
    const { deal, notes } = await this.verifyCandidates(
      watch,
      matches.map((p) => ({ title: p.text.slice(0, 200), url: p.urls[0], price: priceFromText(p.text, watch.currency), source, postUrl: p.url })),
    );
    return { ok: true, summary: `${posts.length} new post${posts.length === 1 ? "" : "s"}, ${matches.length} matched${deal ? " → deal!" : notes.length ? ` (${notes[0]})` : ""}`, deal };
  }

  /** Record a verified deal (deduplicated across sources) and ask the user. */
  private found(watch: Watch, listing: Listing, source: string, postUrl?: string): Deal | undefined {
    const key = dealKey(listing.url);
    const deals = this.state.deals();
    const open = deals.find((d) => d.key === key && ["pending", "queued", "reviewing", "paused", "submitted", "uncertain"].includes(d.status));
    if (open) {
      if (!open.sources.includes(source)) this.state.patchDeal(open.id, { sources: [...open.sources, source] });
      return undefined;
    }
    const recent = deals.find((d) => d.key === key && Date.now() - Date.parse(d.foundAt) < 24 * 3600_000 && d.listing.price.minor <= listing.price.minor && d.status !== "failed");
    if (recent) return undefined; // same or better price already announced today
    const s = this.state.settings();
    const cap = watch.maxTotal ?? withAllowance(listing.price, s.extraAllowancePct);
    const deal = this.state.addDeal({ watchId: watch.id, watchName: watch.name, key, sources: [source], postUrl: postUrl ? sanitizeUrl(postUrl) : undefined, listing, cap }, s.approvalMinutes);
    this.store.audit({ bot: "shopping", session: watch.id, type: "tool", tool: "shopping.deal", watch: watch.name, title: listing.title, price: formatMoney(listing.price), url: sanitizeUrl(listing.url) });
    this.log(`🛒 ${watch.name}: ${listing.title} ${formatMoney(listing.price)}`);
    this.hooks.onDeal?.(deal, watch, {});
    return deal;
  }

  // ── decisions ───────────────────────────────────────
  skip(dealId: string) {
    const d = this.state.transition(dealId, "skipped", {}, ["pending", "expired"]);
    this.changed();
    return d;
  }

  /** Your Buy. Only valid for this deal's current quote, before it expires. */
  approve(dealId: string, nonce: string): Promise<Deal> {
    const d = this.state.deal(dealId);
    if (!d) return Promise.reject(new Error("No such deal"));
    if (d.status !== "pending") return Promise.reject(new Error(`That deal is ${d.status}, not waiting for Buy.`));
    if (!d.approval || d.approval.nonce !== nonce) return Promise.reject(new Error("That Buy button is out of date. Use the latest alert for this deal."));
    if (Date.parse(d.approval.expiresAt) < Date.now()) {
      this.state.transition(dealId, "expired", { note: "The Buy button expired. Use Check again for a fresh price." }, ["pending"]);
      this.changed();
      return Promise.reject(new Error("That Buy button expired. Check the deal again for a fresh price."));
    }
    if (d.approval.quote !== quoteOf(d)) return Promise.reject(new Error("This deal changed since the alert. Check it again."));
    this.state.transition(dealId, "queued", {}, ["pending"]);
    this.changed();
    return this.enqueue(dealId);
  }

  private enqueue(dealId: string): Promise<Deal> {
    const run = this.queue.then(() => this.runPurchase(dealId));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Re-check an expired, failed or skipped deal's listing and offer a fresh Buy. */
  async recheck(dealId: string): Promise<Deal> {
    const d = this.state.deal(dealId);
    if (!d) throw new Error("No such deal");
    if (!["expired", "failed", "skipped"].includes(d.status)) throw new Error(`Can't re-check a deal that is ${d.status}.`);
    const watch = this.state.watches().find((w) => w.id === d.watchId);
    const info = await this.readListing(d.listing.url, d.listing.price.currency);
    const why = watch ? this.mismatches(watch, info) : info.inStock === false ? ["sold out"] : [];
    if (why.length) throw new Error(`No longer a match: ${why.join("; ")}.`);
    const listing: Listing = { url: d.listing.url, title: info.title ?? d.listing.title, price: info.price!, seller: info.seller, inStock: info.inStock, checkedAt: iso() };
    const cap = watch?.maxTotal ?? withAllowance(listing.price, this.state.settings().extraAllowancePct);
    const next = this.state.transition(dealId, "pending", { listing, cap, approval: newApproval({ listing, cap, quantity: 1 }, this.state.settings().approvalMinutes) });
    this.hooks.onDeal?.(next, watch, {});
    this.changed();
    return next;
  }

  /** After "uncertain": you checked your account. Never retried automatically. */
  resolveUncertain(dealId: string, ordered: boolean) {
    const d = this.state.transition(dealId, ordered ? "confirmed" : "failed", { note: ordered ? "You confirmed this order in your account." : "You confirmed nothing was ordered." }, ["uncertain"]);
    if (d.execution?.id) this.state.settleReservation(d.execution.id, ordered ? "spent" : "released");
    this.changed();
    return d;
  }

  /** A paused purchase (sign-in, CAPTCHA, code, payment step): continue after you've done that step. */
  resume(dealId: string): Promise<Deal> {
    const d = this.state.deal(dealId);
    if (!d || d.status !== "paused") return Promise.reject(new Error("That purchase isn't paused."));
    if (d.execution?.submittedAt) return Promise.reject(new Error("An order step already happened; check your account instead of resuming."));
    if (!d.approval || Date.parse(d.approval.expiresAt) < Date.now()) {
      this.state.transition(dealId, "expired", { note: "Your approval expired while paused. Check the deal again for a fresh price." }, ["paused"]);
      this.changed();
      return Promise.reject(new Error("Your approval expired while paused. Check the deal again."));
    }
    this.state.transition(dealId, "queued", {}, ["paused"]);
    this.changed();
    return this.enqueue(dealId);
  }

  cancel(dealId: string) {
    const d = this.state.transition(dealId, "failed", { note: "You cancelled this purchase." }, ["paused", "queued", "pending"]);
    this.changed();
    return d;
  }

  /** What changed in a way that needs a new Buy. */
  private materialChanges(old: Listing, info: ProductInfo, watch?: Watch): string[] {
    const why: string[] = [];
    if (info.inStock === false) why.push("it's sold out now");
    if (!info.price || info.price.currency !== old.price.currency) why.push("the price can't be confirmed in the same currency");
    else if (info.price.minor > old.price.minor) why.push(`the price went up from ${formatMoney(old.price)} to ${formatMoney(info.price)}`);
    if (old.seller && info.seller && norm(old.seller) !== norm(info.seller)) why.push(`the seller changed from ${old.seller} to ${info.seller}`);
    if (old.seller && !info.seller && watch?.sellers.length) why.push("the seller can't be confirmed any more");
    if (info.title && norm(info.title) !== norm(old.title)) {
      const phrases = itemPhrases(old.title, watch?.variants ?? []);
      if (!phrases.every((p) => norm(info.title!).includes(norm(p)))) why.push("the listing's item changed");
    }
    return why;
  }

  private finish(dealId: string, status: Deal["status"], patch: Partial<Deal>) {
    const d = this.state.transition(dealId, status, patch);
    if (d.execution?.id && (status === "failed" || status === "confirmed")) this.state.settleReservation(d.execution.id, status === "confirmed" ? "spent" : "released", d.execution.total);
    this.store.audit({ bot: this.state.settings().bot, session: dealId, type: "tool", tool: "shopping.buy", title: d.listing.title, status, total: d.execution?.total ? formatMoney(d.execution.total) : undefined, order: d.execution?.orderId, note: d.note });
    this.hooks.onUpdate?.(d);
    this.changed();
    return d;
  }

  private async runPurchase(dealId: string): Promise<Deal> {
    let deal = this.state.transition(dealId, "reviewing", {}, ["queued"]);
    this.changed();
    const watch = this.state.watches().find((w) => w.id === deal.watchId);
    const settings = this.state.settings();
    const browser = this.hooks.getBrowser?.();
    if (!browser) return this.finish(dealId, "failed", { note: "Buying needs the SlopBot desktop app (its shopping browser is where you're signed in). Nothing was bought." });

    // 1. Re-check the real listing right before buying. Any material change asks you again.
    let info: ProductInfo;
    try {
      info = await this.readListing(deal.listing.url, deal.listing.price.currency);
    } catch (e: any) {
      return this.finish(dealId, "failed", { note: `Couldn't re-check the price right before buying (${e.message}). Nothing was bought.` });
    }
    const changes = this.materialChanges(deal.listing, info, watch);
    if (changes.length) {
      const listing: Listing = { url: deal.listing.url, title: info.title ?? deal.listing.title, price: info.price ?? deal.listing.price, seller: info.seller, inStock: info.inStock, checkedAt: iso() };
      if (info.inStock === false || !info.price) return this.finish(dealId, "failed", { note: `Not bought: ${changes.join("; ")}.`, listing });
      const cap = watch?.maxTotal ?? withAllowance(listing.price, settings.extraAllowancePct);
      deal = this.state.transition(dealId, "pending", { listing, cap, approval: newApproval({ listing, cap, quantity: 1 }, settings.approvalMinutes), note: `Changed since you approved: ${changes.join("; ")}. Buy again to confirm.` });
      this.hooks.onDeal?.(deal, watch, { reconfirm: true });
      this.changed();
      return deal;
    }

    // 2. Checkout, bound to this purchase only.
    let bot;
    try {
      bot = loadBot(this.config, settings.bot);
      if (!bot.tools.some((t) => t.startsWith("browser"))) throw new Error(`the "${bot.name}" bot can't use the shopping browser`);
    } catch (e: any) {
      return this.finish(dealId, "failed", { note: `Checkout bot unavailable: ${e.message}. Nothing was bought.` });
    }
    const x = new PurchaseExecution({ dealId, listingUrl: deal.listing.url, cap: deal.cap, phrases: itemPhrases(deal.listing.title, watch?.variants ?? []), allPhrases: !!watch?.variants.length });
    // Persist the moment an order step happens, so a crash right after can't be mistaken for "nothing submitted".
    x.onSubmitted = () => this.state.patchDeal(dealId, { execution: { id: x.id, startedAt: iso(), submittedAt: iso(), total: x.submitted?.total } });
    this.execution = x;
    this.state.patchDeal(dealId, { execution: { id: x.id, startedAt: iso() } });
    this.hooks.beginExecution?.(x);
    let report = "";
    try {
      await browser.open(deal.listing.url);
      const agent = new Agent(this.config, this.store, bot, "interactive", { approve: async () => "no" }, this.mcp);
      const task = [
        "Buy this item for me now: exactly one unit.",
        `Item: ${deal.listing.title}`,
        `Seller: ${deal.listing.seller ?? "as listed"} · Price: ${formatMoney(deal.listing.price)} · Maximum order total (tax and shipping included): ${formatMoney(deal.cap)}`,
        "The product page is already open in the shopping browser. Call browser.read, add one to the cart, go to checkout, keep the saved address, standard shipping and saved payment, then place the order.",
        "SlopBot checks the store, item, cart and total before every click and refuses anything outside this purchase. If it pauses for a sign-in, CAPTCHA, code or payment step, or anything looks different, stop and say what you see.",
        "When done, report whether the order was placed and the order number shown.",
      ].join("\n");
      report = (await agent.send(task)).text;
    } catch (e: any) {
      report = e?.message ?? String(e);
    } finally {
      this.hooks.endExecution?.();
      this.execution = undefined;
    }

    // 3. Decide the result from the page, not from the click or the bot's words. Look once more
    //    in case a confirmation appeared after the bot's last step.
    let receipt = x.orderId;
    try {
      const facts = x.analyze(await browser.snapshot());
      if (facts.confirmation && x.checkoutActions > 0) {
        if (!x.submitted) {
          x.submitted = { at: iso(), total: x.lastTotal, url: facts.url };
          x.onSubmitted?.();
        }
        receipt = facts.confirmation.orderId ?? receipt;
      }
    } catch {}
    const exec = { id: x.id, startedAt: this.state.deal(dealId)?.execution?.startedAt ?? iso(), total: x.submitted?.total ?? x.lastTotal, orderId: receipt, submittedAt: x.submitted?.at, finishedAt: iso() };
    const summary = redactPII(report).slice(0, 600);
    if (x.submitted && receipt) return this.finish(dealId, "confirmed", { execution: exec, note: `Order ${receipt} confirmed${exec.total ? ` · ${formatMoney(exec.total)}` : ""}.` });
    if (x.submitted) {
      return this.finish(dealId, "uncertain", {
        execution: exec,
        note: `An order may have been placed, but no order number was shown. Check your ${x.site} account before doing anything else. SlopBot won't retry this.`,
      });
    }
    if (x.state === "paused") return this.finish(dealId, "paused", { execution: exec, note: `Needs you: ${x.pausedFor}. Do it in the shopping browser, then Resume (or Cancel). ${summary}` });
    return this.finish(dealId, "failed", { execution: exec, note: `Not bought. ${summary || "The bot stopped before ordering."}` });
  }

  // ── sources ─────────────────────────────────────────
  async testSource(id: SourceId): Promise<{ ok: boolean; message: string }> {
    const key = this.credentials.get(id);
    let result: { ok: boolean; message: string };
    if (!key) result = { ok: false, message: "No key saved" };
    else {
      try {
        if (id === "x") result = { ok: true, message: await new XClient(key, undefined, this.config.network?.allowPrivate ?? []).test() };
        else {
          const html = await renderWithService(id, key, "https://example.com/", { allowPrivate: this.config.network?.allowPrivate });
          result = /Example Domain/i.test(html) ? { ok: true, message: "Rendered a test page" } : { ok: false, message: "The service answered, but not with the test page" };
        }
      } catch (e: any) {
        result = { ok: false, message: `${e.message}${e.hint ? ` ${e.hint}` : ""}` };
      }
    }
    this.state.update((s) => void (s.settings.sourceTests = { ...s.settings.sourceTests, [id]: { ...result, at: iso() } }));
    this.changed();
    return result;
  }
}
