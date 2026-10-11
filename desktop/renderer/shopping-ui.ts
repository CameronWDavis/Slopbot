// Shopping tab: deals waiting for Buy / Skip (with the exact item, seller, quantity, price and the
// most checkout may cost), purchases that need you, watches with their status, and history.
import type { DealInfo, MoneyInfo, ShoppingSnapshot, SlopbotApi, WatchDraft, WatchInfo, WatchKind } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const ZERO_DEC = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD"]);
export const money = (m?: MoneyInfo) => {
  if (!m) return "—";
  const d = ZERO_DEC.has(m.currency) ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(m.minor / 10 ** d);
  } catch {
    return `${m.currency} ${(m.minor / 10 ** d).toFixed(d)}`;
  }
};
const major = (m?: MoneyInfo) => (m ? String(m.minor / 10 ** (ZERO_DEC.has(m.currency) ? 0 : 2)) : "");
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const when = (iso?: string, future = false) => {
  if (!iso) return future ? "soon" : "never";
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000) * (future ? 1 : -1);
  if (s < 60) return future ? "in under a minute" : "just now";
  const t = s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
  return future ? `in ${t}` : `${t} ago`;
};

const KIND_LABEL: Record<WatchKind, string> = { product: "Product page", feed: "Deal feed", x_account: "X account", x_search: "X search" };
const STATUS: Record<string, string> = {
  pending: "Waiting for you",
  expired: "Expired",
  skipped: "Skipped",
  queued: "Queued",
  reviewing: "Checking out…",
  paused: "Needs you",
  submitted: "Submitted, checking receipt",
  confirmed: "✅ Confirmed",
  failed: "Not bought",
  uncertain: "⚠️ Check your account",
};

export function createShopping(api: SlopbotApi) {
  let snap: ShoppingSnapshot | undefined;
  let editing: WatchInfo | undefined;
  let kind: WatchKind = "product";
  const checkingNow = new Set<string>();

  function showError(msg: string) {
    $("shopping-error").textContent = msg;
    $("shopping-error").hidden = !msg;
  }
  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (e) {
      showError(cleanError(e));
    }
    load();
  };

  async function load() {
    try {
      snap = await api.shoppingState();
      showError("");
    } catch (e) {
      showError(cleanError(e));
      return;
    }
    render();
    const needs = snap.deals.filter((d) => ["pending", "paused", "uncertain"].includes(d.status)).length;
    const badge = $("shopping-badge");
    badge.textContent = String(needs);
    badge.hidden = !needs;
  }

  function dealCard(d: DealInfo) {
    const card = el("div", `card deal-card status-${d.status}`);
    const head = el("div", "card-head");
    head.append(el("span", "deal-price", money(d.listing.price)), el("span", "connector-name deal-title", d.listing.title), el("span", "tag", STATUS[d.status] ?? d.status));
    card.append(head);
    const facts = el("dl", "deal-facts");
    const fact = (k: string, v: string) => facts.append(el("dt", "", k), el("dd", "", v));
    fact("Seller", d.listing.seller ?? "not shown");
    fact("Store", host(d.listing.url));
    fact("Quantity", String(d.quantity));
    fact("Price", `${money(d.listing.price)} (${d.listing.price.currency})`);
    fact("Max total", `${money(d.cap)} with tax & shipping`);
    if (d.execution?.orderId) fact("Order", d.execution.orderId);
    if (d.execution?.total) fact("Order total", money(d.execution.total));
    card.append(facts);
    const meta = [`${d.watchName}`, `seen on ${d.sources.join(", ")}`, `found ${when(d.foundAt)}`];
    if (d.status === "pending" && d.approval) meta.push(`Buy valid ${when(d.approval.expiresAt, true)}`);
    card.append(el("div", "muted small-text", meta.join(" · ")));
    if (d.note) card.append(el("div", d.status === "uncertain" || d.status === "paused" || d.note.startsWith("Changed") ? "note" : "muted small-text", d.note));

    const actions = el("div", "card-actions");
    const btn = (label: string, cls: string, fn: () => Promise<unknown>) => {
      const b = el("button", `${cls} small`, label);
      b.addEventListener("click", async () => {
        b.disabled = true;
        await run(fn)();
      });
      actions.append(b);
      return b;
    };
    btn("Open deal", "ghost", () => api.shoppingOpenBrowser(d.listing.url));
    if (d.status === "pending") {
      btn("Skip", "ghost", () => api.shoppingSkip(d.id));
      const buy = btn(`Buy · max ${money(d.cap)}`, "primary", () => api.shoppingBuy(d.id, d.approval!.nonce));
      buy.disabled = !!snap?.buying || !d.approval;
      buy.title = "The shopper bot checks out with your saved payment. SlopBot stops it if the store, item, cart or total don't match.";
    } else if (d.status === "paused") {
      btn("Cancel", "ghost", () => api.shoppingCancel(d.id));
      btn("Resume", "primary", () => api.shoppingResume(d.id));
    } else if (d.status === "uncertain") {
      btn("Nothing was ordered", "ghost", () => api.shoppingResolve(d.id, false));
      btn("It was ordered", "primary", () => api.shoppingResolve(d.id, true));
    } else if (["expired", "failed", "skipped"].includes(d.status)) {
      btn("Check again", "ghost", () => api.shoppingRecheck(d.id));
    }
    card.append(actions);
    return card;
  }

  function watchCard(w: WatchInfo) {
    const card = el("div", `card watch-card${w.enabled ? "" : " off"}`);
    const head = el("div", "card-head");
    const sw = el("label", "switch");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = w.enabled;
    cb.addEventListener("change", run(() => api.shoppingSetEnabled(w.id, cb.checked)));
    sw.append(cb, el("span", "slider"));
    sw.title = cb.checked ? "Watching" : "Paused";
    head.append(
      el("span", "skill-icon", w.kind === "product" ? "🏷️" : w.kind === "feed" ? "📰" : "𝕏"),
      el("span", "connector-name", w.name),
      el("span", "connector-where", w.url ? host(w.url) : (w.xQuery ?? "")),
      el("span", "tag", KIND_LABEL[w.kind]),
      sw,
    );
    card.append(head);

    const rules: string[] = [];
    if (w.keywords.length) rules.push(`with ${w.keywords.map((k) => `"${k}"`).join(" + ")}`);
    if (w.variants.length) rules.push(`exactly ${w.variants.map((k) => `"${k}"`).join(" + ")}`);
    if (w.exclude.length) rules.push(`not ${w.exclude.map((k) => `"${k}"`).join(" / ")}`);
    if (w.sellers.length) rules.push(`sold by ${w.sellers.join(" or ")}`);
    rules.push(w.target ? `at ${money(w.target)} or less` : "at any price");
    if (w.maxTotal) rules.push(`max total ${money(w.maxTotal)}`);
    card.append(el("p", "skill-desc", `${w.kind === "product" ? "In stock" : "Posts"} ${rules.join(", ")} · ${w.currency} · every ${w.everyMinutes} min`));

    const status = el("div", "watch-status small-text");
    if (checkingNow.has(w.id)) status.append(el("span", "muted", "Checking…"));
    else {
      if (w.lastError) {
        status.append(el("div", "watch-error", w.lastError));
        if (w.lastHint) status.append(el("div", "muted", w.lastHint));
      } else if (w.lastSummary) status.append(el("div", "", w.lastSummary));
      status.append(el("div", "muted", `Last successful check: ${when(w.lastSuccessAt)} · next: ${w.enabled ? when(w.nextCheckAt, true) : "paused"}${w.failures > 1 ? ` · ${w.failures} failures in a row, checking less often` : ""}`));
    }
    card.append(status);

    const actions = el("div", "card-actions");
    const check = el("button", "ghost small", "Check now");
    check.addEventListener("click", async () => {
      checkingNow.add(w.id);
      render();
      try {
        await api.shoppingCheck(w.id);
      } finally {
        checkingNow.delete(w.id);
        load();
      }
    });
    const edit = el("button", "ghost small", "Edit");
    edit.addEventListener("click", () => openForm(w));
    const del = el("button", "danger small", "Delete");
    del.addEventListener("click", async () => {
      if (!confirm(`Stop watching "${w.name}"?`)) return;
      await run(() => api.shoppingRemoveWatch(w.id))();
    });
    actions.append(check, edit, del);
    card.append(actions);
    return card;
  }

  function historyList(deals: DealInfo[]) {
    const box = el("div", "card history-card");
    for (const d of deals.slice(0, 20)) {
      const row = el("div", "history-row");
      row.append(el("span", `history-status ${d.status}`, STATUS[d.status] ?? d.status), el("span", "history-title", d.listing.title), el("span", "history-price", money(d.execution?.total ?? d.listing.price)));
      if (d.note) row.title = d.note;
      if (["expired", "failed", "skipped"].includes(d.status)) {
        const again = el("button", "ghost small", "Check again");
        again.addEventListener("click", run(() => api.shoppingRecheck(d.id)));
        row.append(again);
      }
      box.append(row);
    }
    return box;
  }

  function settingsCard() {
    const s = snap!.settings;
    const card = el("div", "card shop-settings");
    const head = el("div", "card-head");
    head.append(el("span", "connector-name", "Buying"), el("span", "connector-where", "every purchase waits for your Buy"));
    card.append(head);
    const grid = el("div", "shop-settings-grid");
    const field = (label: string, input: HTMLInputElement) => {
      const l = el("label", "field");
      l.append(el("span", "", label), input);
      return l;
    };
    const pct = Object.assign(el("input"), { type: "number", min: "0", max: "100", step: "1", value: String(s.extraAllowancePct) });
    const mins = Object.assign(el("input"), { type: "number", min: "2", max: "1440", step: "1", value: String(s.approvalMinutes) });
    grid.append(field("Tax & shipping allowance for the max total (%)", pct), field("Buy buttons expire after (minutes)", mins));
    card.append(grid);
    card.append(el("p", "muted small-text", "Checkout is refused if the order total is over the max total shown on the deal. Auto-buy isn't available in this version."));
    const out = el("span", "muted small-text");
    const save = el("button", "primary small", "Save");
    save.addEventListener("click", async () => {
      try {
        await api.shoppingSaveSettings({ extraAllowancePct: Number(pct.value), approvalMinutes: Number(mins.value) });
        out.textContent = "Saved.";
      } catch (e) {
        out.textContent = cleanError(e);
      }
    });
    const clear = el("button", "ghost small", "Clear shopping history");
    clear.addEventListener("click", async () => {
      if (!confirm("Remove finished deals and purchase history? Open deals and ones to check in your account stay.")) return;
      await run(() => api.shoppingClearHistory())();
    });
    const actions = el("div", "card-actions");
    actions.append(out, clear, save);
    card.append(actions);
    return card;
  }

  function render() {
    if (!snap) return;
    const box = $("shopping-list");
    const parts: HTMLElement[] = [];
    const notes = el("div", "shop-notes muted small-text");
    notes.append(el("span", "", "Watches only run while SlopBot is running."));
    if (!snap.model.local) notes.append(el("span", "cloud-note", ` Checkout uses ${snap.model.model}, a cloud model: the cart and checkout summaries it reads (no names, addresses or card details) are sent to that provider.`));
    parts.push(notes);
    const active = snap.deals.filter((d) => ["pending", "queued", "reviewing", "paused", "submitted", "uncertain"].includes(d.status));
    if (active.length) {
      parts.push(el("div", "section-label", "Deals and purchases"));
      for (const d of active) parts.push(dealCard(d));
    }
    if (!snap.watches.length) {
      const intro = el("div", "card shop-intro");
      intro.append(el("p", "connector-name", "Set up deal watching"));
      const ol = el("ol", "shop-steps");
      for (const t of [
        "Open the shopping browser (Deal sources) and sign in to the stores you buy from. Keep your address and card saved in your store account, never in SlopBot.",
        "Add a watch: a product page, a deal feed like r/buildapcsales, or an X account or search (needs your own X API token, in Deal sources).",
        "SlopBot checks the real store listing before alerting you. Link Telegram in Channels to get Buy / Skip / Open on your phone.",
      ])
        ol.append(el("li", "", t));
      intro.append(ol);
      parts.push(intro);
    } else {
      parts.push(el("div", "section-label", "Watches"));
      for (const w of snap.watches) parts.push(watchCard(w));
    }
    const past = snap.deals.filter((d) => !active.includes(d));
    if (past.length) {
      parts.push(el("div", "section-label", "History"));
      parts.push(historyList(past));
    }
    parts.push(el("div", "section-label", "Settings"));
    parts.push(settingsCard());
    box.replaceChildren(...parts);
  }

  // ── watch form ──
  function setKind(k: WatchKind) {
    kind = k;
    document.querySelectorAll<HTMLButtonElement>("#watch-kind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === k));
    const x = k === "x_account" || k === "x_search";
    $("watch-url-row").hidden = x;
    $("watch-x-row").hidden = !x;
    $("watch-feed-presets").hidden = k !== "feed";
    $<HTMLInputElement>("watch-url").placeholder = k === "feed" ? "https://www.reddit.com/r/buildapcsales/new/.rss" : "https://www.newegg.com/p/…";
    $("watch-x-label").textContent = k === "x_account" ? "X account (@handle)" : "Search X for";
    $<HTMLInputElement>("watch-xquery").placeholder = k === "x_account" ? "@SomeDealsAccount" : "rtx 4070 super deal";
    $("watch-url-hint").textContent =
      k === "product"
        ? "The product's own page. SlopBot reads the price, stock and seller the store shows."
        : k === "feed"
          ? "An RSS or Atom feed. New posts matching your keywords are checked against the store listing before you're alerted."
          : "Uses your X API token (Deal sources). New posts matching your keywords are checked against the store listing they link to.";
    $("watch-keywords-label").textContent = k === "product" ? "Keywords the listing must mention (optional)" : "Keywords (all must be in the post)";
    $<HTMLInputElement>("watch-every").min = String(x ? 15 : k === "feed" ? 2 : 1);
    renderFeedChips();
  }

  function renderFeedChips() {
    const box = $("watch-feed-presets");
    const feeds = snap?.settings.savedFeeds ?? [];
    box.replaceChildren(el("span", "chips-label", feeds.length ? "Your feeds" : "No saved feeds (add them in Deal sources)"));
    for (const f of feeds) {
      const b = el("button", "chip", f.label);
      b.type = "button";
      b.title = f.url;
      b.addEventListener("click", () => {
        $<HTMLInputElement>("watch-url").value = f.url;
        if (!$<HTMLInputElement>("watch-name").value) $<HTMLInputElement>("watch-name").value = f.label;
      });
      box.append(b);
    }
  }

  const csv = (id: string) =>
    $<HTMLInputElement>(id)
      .value.split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  function openForm(w?: WatchInfo, preset?: Partial<WatchDraft>) {
    editing = w;
    $("watch-form-title").textContent = w ? `Edit ${w.name}` : "New watch";
    $<HTMLInputElement>("watch-name").value = w?.name ?? preset?.name ?? "";
    $<HTMLInputElement>("watch-url").value = w?.url ?? preset?.url ?? "";
    $<HTMLInputElement>("watch-xquery").value = w?.xQuery ?? "";
    $<HTMLInputElement>("watch-keywords").value = w?.keywords.join(", ") ?? "";
    $<HTMLInputElement>("watch-exclude").value = w?.exclude.join(", ") ?? "";
    $<HTMLInputElement>("watch-variants").value = w?.variants.join(", ") ?? "";
    $<HTMLInputElement>("watch-sellers").value = w?.sellers.join(", ") ?? "";
    $<HTMLInputElement>("watch-target").value = major(w?.target);
    $<HTMLInputElement>("watch-maxtotal").value = major(w?.maxTotal);
    $<HTMLSelectElement>("watch-currency").value = w?.currency ?? "USD";
    $<HTMLInputElement>("watch-every").value = String(w?.everyMinutes ?? 5);
    setKind(w?.kind ?? preset?.kind ?? "product");
    $("watch-form-error").hidden = true;
    $("watch-form").hidden = false;
    (kind.startsWith("x_") ? $<HTMLInputElement>("watch-xquery") : $<HTMLInputElement>("watch-url")).focus();
  }

  async function saveForm() {
    try {
      await api.shoppingSaveWatch({
        id: editing?.id,
        name: $<HTMLInputElement>("watch-name").value,
        kind,
        url: kind.startsWith("x_") ? undefined : $<HTMLInputElement>("watch-url").value.trim(),
        xQuery: kind.startsWith("x_") ? $<HTMLInputElement>("watch-xquery").value.trim() : undefined,
        keywords: csv("watch-keywords"),
        exclude: csv("watch-exclude"),
        variants: csv("watch-variants"),
        sellers: csv("watch-sellers"),
        targetPrice: $<HTMLInputElement>("watch-target").value.trim(),
        maxTotal: $<HTMLInputElement>("watch-maxtotal").value.trim(),
        currency: $<HTMLSelectElement>("watch-currency").value,
        everyMinutes: Number($<HTMLInputElement>("watch-every").value) || 5,
        enabled: editing?.enabled ?? true,
      });
      $("watch-form").hidden = true;
      load();
      setTimeout(load, 5000); // first check result
    } catch (e) {
      $("watch-form-error").textContent = cleanError(e);
      $("watch-form-error").hidden = false;
    }
  }

  document.querySelectorAll<HTMLButtonElement>("#watch-kind button").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind as WatchKind)));
  $("shopping-add").addEventListener("click", () => openForm());
  $("shopping-browser").addEventListener("click", () => api.shoppingOpenBrowser());
  $("watch-save").addEventListener("click", saveForm);
  $("watch-cancel").addEventListener("click", () => ($("watch-form").hidden = true));
  window.addEventListener("keydown", (e) => e.key === "Escape" && !$("watch-form").hidden && ($("watch-form").hidden = true));
  api.onShoppingChanged(() => void load());
  setInterval(() => !$("view-shopping").hidden && void load(), 30_000); // keep "next check" / expiry times fresh

  return { load, openForm, snapshot: () => snap };
}
