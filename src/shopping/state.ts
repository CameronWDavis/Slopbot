// Watches, deals, purchases and shopping settings: private per-user data in
// <data>/shopping/state.json (0600). Never inside the repository or a build.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId } from "../store/store.js";
import { formatMoney, fromMajor, type Money } from "./money.js";

export type WatchKind = "product" | "feed" | "x_account" | "x_search";

/** Auto-buy is not part of this release: every purchase waits for your Buy. */
export const AUTO_BUY_ENABLED = false;

export interface Watch {
  id: string;
  name: string;
  kind: WatchKind;
  /** Product page or feed address. */
  url?: string;
  /** X account handle (x_account) or search text (x_search). */
  xQuery?: string;
  /** Every keyword must appear in the post / listing title. */
  keywords: string[];
  /** Skip anything containing one of these. */
  exclude: string[];
  /** Exact phrases the store listing must contain (model number, capacity, color…). */
  variants: string[];
  /** Acceptable sellers ("Newegg", "Amazon.com"). Empty = any seller. */
  sellers: string[];
  /** Alert when the verified store price is at or below this. */
  target?: Money;
  /** Currency the watch works in; prices in other currencies are refused. */
  currency: string;
  /** Highest checkout total you'd approve, tax and shipping included. Default: target + allowance. */
  maxTotal?: Money;
  everyMinutes: number;
  enabled: boolean;
  createdAt: string;
  // status
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  failures: number;
  lastError?: string;
  lastHint?: string;
  lastSummary?: string;
  lastPrice?: Money;
  lastInStock?: boolean;
  lastTitle?: string;
  lastSeller?: string;
  /** Price last announced, so a deal isn't announced again every check. */
  alertedMinor?: number;
  seen?: string[];
  sinceId?: string;
}

export type DealStatus =
  | "pending" // waiting for your Buy / Skip
  | "expired" // approval window passed
  | "skipped"
  | "queued" // you tapped Buy; waiting its turn
  | "reviewing" // re-checking the listing and going through checkout
  | "paused" // needs you: sign-in, CAPTCHA, payment step, or a change to reconfirm
  | "submitted" // an order may have been placed; checking the receipt
  | "confirmed" // receipt seen, with an order number
  | "failed" // stopped before anything was submitted
  | "uncertain"; // may or may not have ordered: check your account; never retried automatically

export const OPEN_STATUSES: DealStatus[] = ["pending", "queued", "reviewing", "paused", "submitted"];

export interface Listing {
  url: string;
  title: string;
  price: Money;
  seller?: string;
  inStock?: boolean;
  checkedAt: string;
}

export interface Deal {
  id: string;
  watchId: string;
  watchName: string;
  /** Same product from any source maps to the same key (deduplication). */
  key: string;
  /** Where it was seen: "product page", "r/buildapcsales", "X @handle"… */
  sources: string[];
  /** Post / page that announced it. */
  postUrl?: string;
  listing: Listing;
  quantity: 1;
  /** Highest checkout total this approval covers, tax and shipping included. */
  cap: Money;
  /** Buy is bound to this exact quote and expires. */
  approval?: { nonce: string; quote: string; expiresAt: string };
  status: DealStatus;
  note?: string;
  foundAt: string;
  updatedAt: string;
  execution?: { id: string; startedAt: string; total?: Money; orderId?: string; submittedAt?: string; finishedAt?: string };
  history: { at: string; status: DealStatus; note?: string }[];
}

export interface Reservation {
  executionId: string;
  dealId: string;
  amount: Money;
  at: string;
  state: "held" | "spent" | "released";
}

export interface SavedFeed {
  label: string;
  url: string;
}

export const DEFAULT_FEEDS: SavedFeed[] = [
  { label: "r/buildapcsales", url: "https://www.reddit.com/r/buildapcsales/new/.rss" },
  { label: "r/hardwareswap", url: "https://www.reddit.com/r/hardwareswap/new/.rss" },
  { label: "Slickdeals frontpage", url: "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1" },
];

export interface ShoppingSettings {
  /** Tax + shipping allowance added to the target to get the default max total, in percent. */
  extraAllowancePct: number;
  /** How long a Buy button stays valid, in minutes. */
  approvalMinutes: number;
  /** The bot that does checkout. */
  bot: string;
  savedFeeds: SavedFeed[];
  /** Rendering service for pages the shopping browser can't read: none | scrapingbee | scraperapi. */
  renderService: "none" | "scrapingbee" | "scraperapi";
  /** X API: posts you allow SlopBot to read per calendar month, and how many it has read. */
  xMonthlyLimit: number;
  xUsage: { month: string; posts: number; requests: number };
  /** Last "Test connection" result per source. */
  sourceTests: Record<string, { ok: boolean; message: string; at: string }>;
  /** Future auto-buy limits (auto-buy is off in this release; kept so budgets are tested). */
  dailyAutoLimit?: Money;
  allowedStores: string[];
}

interface State {
  version: 2;
  watches: Watch[];
  deals: Deal[];
  reservations: Reservation[];
  settings: ShoppingSettings;
}

const DEFAULTS: ShoppingSettings = {
  extraAllowancePct: 15,
  approvalMinutes: 30,
  bot: "shopper",
  savedFeeds: DEFAULT_FEEDS,
  renderService: "none",
  xMonthlyLimit: 100,
  xUsage: { month: "", posts: 0, requests: 0 },
  sourceTests: {},
  allowedStores: [],
};

const now = () => new Date().toISOString();
const month = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** Bring version-1 data (float prices, auto mode, "ordered" status) forward. */
function migrate(s: any): State {
  if (s?.version === 2) return { reservations: [], ...s, settings: { ...DEFAULTS, ...s.settings } };
  const cur = (w: any) => String(w.lastCurrency ?? "USD").toUpperCase();
  const watches: Watch[] = (s?.watches ?? []).map((w: any) => ({
    id: w.id,
    name: w.name,
    kind: w.kind === "feed" ? "feed" : "product",
    url: w.url,
    keywords: w.keywords ?? [],
    exclude: w.exclude ?? [],
    variants: [],
    sellers: [],
    target: typeof w.maxPrice === "number" ? fromMajor(w.maxPrice, cur(w)) : undefined,
    currency: cur(w),
    everyMinutes: w.everyMinutes ?? 5,
    enabled: w.enabled !== false,
    createdAt: w.createdAt ?? now(),
    failures: 0,
    seen: w.seen,
  }));
  return { version: 2, watches, deals: [], reservations: [], settings: { ...DEFAULTS, savedFeeds: s?.settings?.savedFeeds ?? DEFAULT_FEEDS } };
}

export class ShoppingState {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "shopping", "state.json");
  }

  read(): State {
    try {
      return migrate(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return migrate({ version: 2, watches: [], deals: [], reservations: [], settings: {} });
    }
  }

  private write(s: State) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...s, deals: s.deals.slice(-300), reservations: s.reservations.slice(-300) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update<T>(fn: (s: State) => T): T {
    const s = this.read();
    const out = fn(s);
    this.write(s);
    return out;
  }

  // ── watches ──
  watches = () => this.read().watches;

  saveWatch(input: WatchInput): Watch {
    const w = normalizeWatch(input);
    return this.update((s) => {
      const i = s.watches.findIndex((x) => x.id === input.id);
      if (i >= 0) {
        const prev = s.watches[i];
        const reset = prev.url !== w.url || prev.kind !== w.kind || prev.xQuery !== w.xQuery || prev.currency !== w.currency;
        s.watches[i] = {
          ...prev,
          ...w,
          id: prev.id,
          createdAt: prev.createdAt,
          nextCheckAt: undefined, // check soon with the new settings
          failures: 0,
          ...(reset ? { seen: undefined, sinceId: undefined, alertedMinor: undefined, lastPrice: undefined, lastInStock: undefined, lastError: undefined, lastHint: undefined, lastSummary: undefined } : {}),
        };
        return s.watches[i];
      }
      const created: Watch = { ...w, id: newId("w_"), createdAt: now(), failures: 0 };
      s.watches.push(created);
      return created;
    });
  }

  patchWatch(id: string, patch: Partial<Watch>) {
    this.update((s) => {
      const w = s.watches.find((x) => x.id === id);
      if (w) Object.assign(w, patch);
    });
  }

  removeWatch(id: string) {
    this.update((s) => void (s.watches = s.watches.filter((w) => w.id !== id)));
  }

  // ── deals ──
  deals = () => this.read().deals;
  deal = (id: string) => this.read().deals.find((d) => d.id === id);

  addDeal(d: Omit<Deal, "id" | "foundAt" | "updatedAt" | "status" | "history" | "quantity">, approvalMinutes: number): Deal {
    return this.update((s) => {
      const deal: Deal = { ...d, quantity: 1, id: newId("d_"), status: "pending", foundAt: now(), updatedAt: now(), history: [{ at: now(), status: "pending" }] };
      deal.approval = newApproval(deal, approvalMinutes);
      s.deals.push(deal);
      return deal;
    });
  }

  /** Change a deal's status (with a history entry). `from` guards against racing updates. */
  transition(id: string, to: DealStatus, patch: Partial<Deal> = {}, from?: DealStatus[]): Deal {
    return this.update((s) => {
      const d = s.deals.find((x) => x.id === id);
      if (!d) throw new Error("No such deal");
      if (from && !from.includes(d.status)) throw new Error(`That deal is ${d.status} now.`);
      Object.assign(d, patch, { status: to, updatedAt: now() });
      if (patch.note === undefined && to !== d.status) d.note = undefined;
      d.history = [...(d.history ?? []), { at: now(), status: to, note: patch.note }].slice(-30);
      return d;
    });
  }

  patchDeal(id: string, patch: Partial<Deal>) {
    return this.update((s) => {
      const d = s.deals.find((x) => x.id === id);
      if (d) Object.assign(d, patch, { updatedAt: now() });
      return d;
    });
  }

  /** Remove finished deals (keeps anything still open or uncertain). */
  clearHistory() {
    this.update((s) => {
      s.deals = s.deals.filter((d) => OPEN_STATUSES.includes(d.status) || d.status === "uncertain");
      s.reservations = s.reservations.filter((r) => r.state === "held");
    });
  }

  // ── settings ──
  settings = () => this.read().settings;

  saveSettings(patch: Partial<ShoppingSettings>): ShoppingSettings {
    return this.update((s) => {
      const next = { ...s.settings, ...patch };
      next.extraAllowancePct = Math.min(100, Math.max(0, Math.round(Number(next.extraAllowancePct) || 0)));
      next.approvalMinutes = Math.min(24 * 60, Math.max(2, Math.round(Number(next.approvalMinutes) || 30)));
      next.xMonthlyLimit = Math.max(0, Math.round(Number(next.xMonthlyLimit) || 0));
      next.renderService = (["none", "scrapingbee", "scraperapi"] as const).includes(next.renderService) ? next.renderService : "none";
      next.savedFeeds = cleanFeeds(next.savedFeeds);
      next.allowedStores = [...new Set((next.allowedStores ?? []).map(cleanHost).filter(Boolean))];
      s.settings = next;
      return next;
    });
  }

  /** Count X API reads; refuse when this month's limit would be passed. */
  useX(posts: number, requests = 1) {
    return this.update((s) => {
      const m = month();
      if (s.settings.xUsage.month !== m) s.settings.xUsage = { month: m, posts: 0, requests: 0 };
      s.settings.xUsage.posts += posts;
      s.settings.xUsage.requests += requests;
      return s.settings.xUsage;
    });
  }

  xBudgetLeft(): number {
    const s = this.settings();
    return Math.max(0, s.xMonthlyLimit - (s.xUsage.month === month() ? s.xUsage.posts : 0));
  }

  // ── budget reservations (for future auto-buy; tested now) ──
  reservations = () => this.read().reservations;

  /**
   * Hold `amount` against the daily limit before a purchase runs. Spent + held + amount must fit.
   * The amount is the maximum authorized checkout total (tax and shipping included).
   */
  reserve(executionId: string, dealId: string, amount: Money, limit: Money, at = new Date()): Reservation {
    return this.update((s) => {
      if (amount.currency !== limit.currency) throw new Error(`The daily limit is in ${limit.currency}, this purchase is in ${amount.currency}`);
      const midnight = new Date(at);
      midnight.setHours(0, 0, 0, 0);
      const used = s.reservations
        .filter((r) => r.state !== "released" && r.amount.currency === limit.currency && Date.parse(r.at) >= midnight.getTime())
        .reduce((sum, r) => sum + r.amount.minor, 0);
      if (used + amount.minor > limit.minor) throw new Error(`Over today's limit: ${formatMoney({ minor: used, currency: limit.currency })} of ${formatMoney(limit)} already used or held`);
      const r: Reservation = { executionId, dealId, amount, at: at.toISOString(), state: "held" };
      s.reservations.push(r);
      return r;
    });
  }

  settleReservation(executionId: string, state: "spent" | "released", actual?: Money) {
    this.update((s) => {
      const r = s.reservations.find((x) => x.executionId === executionId);
      if (r) {
        r.state = state;
        if (actual && actual.currency === r.amount.currency) r.amount = actual;
      }
    });
  }
}

/** A fresh Buy approval bound to this exact quote. */
export function newApproval(d: Pick<Deal, "listing" | "cap" | "quantity">, minutes: number) {
  return { nonce: crypto.randomBytes(6).toString("hex"), quote: quoteOf(d), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
}

/** What an approval covers: item, seller, price, quantity and cap. Any change needs a new Buy. */
export function quoteOf(d: Pick<Deal, "listing" | "cap" | "quantity">): string {
  const l = d.listing;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([l.url, l.title, l.seller ?? "", l.price.minor, l.price.currency, d.quantity, d.cap.minor, d.cap.currency]))
    .digest("hex")
    .slice(0, 16);
}

export const cleanHost = (s: string) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");

function cleanFeeds(list: unknown): SavedFeed[] {
  const out: SavedFeed[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    const label = String(f?.label ?? "").trim().slice(0, 40);
    let url: URL;
    try {
      url = new URL(String(f?.url ?? "").trim());
    } catch {
      throw new Error(`"${f?.url}" isn't a web address`);
    }
    if (!/^https?:$/.test(url.protocol)) throw new Error("Feeds must be http(s) addresses");
    if (url.username || url.password) throw new Error("Don't put a username or password in a feed address");
    if (!label) throw new Error("Give the feed a name");
    if (!out.some((x) => x.url === url.toString())) out.push({ label, url: url.toString() });
  }
  return out.slice(0, 40);
}

export interface WatchInput {
  id?: string;
  name?: string;
  kind: WatchKind;
  url?: string;
  xQuery?: string;
  keywords?: string[] | string;
  exclude?: string[] | string;
  variants?: string[] | string;
  sellers?: string[] | string;
  /** Major units as typed ("499.99"); converted to minor units here. */
  targetPrice?: number | string;
  maxTotal?: number | string;
  currency?: string;
  everyMinutes?: number;
  enabled?: boolean;
}

const list = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 30);

function amount(v: unknown, currency: string, what: string): Money | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).trim());
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`${what} must be a number above 0`);
  return fromMajor(n, currency);
}

export function normalizeWatch(input: WatchInput): Omit<Watch, "id" | "createdAt" | "failures"> {
  const kind: WatchKind = (["product", "feed", "x_account", "x_search"] as const).includes(input.kind) ? input.kind : "product";
  const currency = String(input.currency || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a 3-letter code like USD or EUR");
  let url: string | undefined;
  let xQuery: string | undefined;
  if (kind === "product" || kind === "feed") {
    let u: URL;
    try {
      u = new URL(String(input.url ?? "").trim());
    } catch {
      throw new Error("Enter the full web address, starting with https://");
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) addresses can be watched");
    if (u.username || u.password) throw new Error("Don't put a username or password in the address");
    url = u.toString();
  } else {
    xQuery = String(input.xQuery ?? "").trim();
    if (!xQuery) throw new Error(kind === "x_account" ? "Enter the X account's @handle" : "Enter what to search for on X");
  }
  const keywords = list(input.keywords);
  if (kind !== "product" && !keywords.length) throw new Error("Add at least one keyword (e.g. 4070), or every post would be a match");
  const target = amount(input.targetPrice, currency, "Target price");
  const maxTotal = amount(input.maxTotal, currency, "Max total");
  if (target && maxTotal && maxTotal.minor < target.minor) throw new Error("Max total (with tax and shipping) can't be below the target price");
  const minEvery = kind.startsWith("x_") ? 15 : kind === "feed" ? 2 : 1;
  const host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
  return {
    name: String(input.name || "").trim() || (kind === "x_account" ? `@${xQuery!.replace(/^@/, "")}` : kind === "x_search" ? `X: ${xQuery}` : host),
    kind,
    url,
    xQuery,
    keywords,
    exclude: list(input.exclude),
    variants: list(input.variants),
    sellers: list(input.sellers),
    target,
    currency,
    maxTotal,
    everyMinutes: Math.min(1440, Math.max(minEvery, Math.round(Number(input.everyMinutes) || Math.max(5, minEvery)))),
    enabled: input.enabled !== false,
  };
}
