// Deal sources: your own X API token and page-rendering service keys (stored in the OS credential
// store, shown masked), saved RSS/Atom feeds, and the shopping browser's sign-ins.
import type { ShoppingSnapshot, SlopbotApi, SourceId, SourceInfo } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const ago = (iso?: string) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

export function createSources(api: SlopbotApi, opts: { watchFeed: (f: { label: string; url: string }) => void }) {
  let sources: SourceInfo[] = [];
  let snap: ShoppingSnapshot | undefined;

  function showError(msg: string) {
    $("sources-error").textContent = msg;
    $("sources-error").hidden = !msg;
  }

  async function load() {
    try {
      [sources, snap] = await Promise.all([api.sourcesList(), api.shoppingState()]);
      showError("");
    } catch (e) {
      showError(cleanError(e));
      return;
    }
    render();
  }

  function sourceCard(s: SourceInfo) {
    const card = el("div", "card source-card");
    const head = el("div", "card-head");
    const dot = el("span", `dot ${s.lastTest ? (s.lastTest.ok ? "" : "err") : s.configured ? "busy" : "off"}`);
    head.append(dot, el("span", "connector-name", s.label), el("span", "connector-where", s.configured ? `${s.keyLabel} saved: ${s.masked}` : "not set up"));
    card.append(head, el("p", "muted small-text", s.note));
    if (s.lastTest) card.append(el("div", s.lastTest.ok ? "test-ok" : "connector-error", `${s.lastTest.ok ? "✓" : "✗"} ${s.lastTest.message} · tested ${ago(s.lastTest.at)}`));
    const row = el("div", "search-key");
    const input = el("input");
    input.type = "password";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = s.configured ? "🔒 saved in your system keychain (paste to replace)" : `Paste your ${s.keyLabel}`;
    input.classList.toggle("has-secret", s.configured);
    const get = el("a", "small-text", "Get a key ↗");
    get.href = s.getKey;
    get.target = "_blank";
    row.append(input, get);
    card.append(row);
    const out = el("span", "muted small-text");
    const actions = el("div", "card-actions");
    const save = el("button", "primary small", s.configured ? "Replace & test" : "Save & test");
    save.addEventListener("click", async () => {
      out.textContent = "Testing…";
      try {
        await api.sourcesSave(s.id, input.value);
        input.value = ""; // don't keep it in the page
      } catch (e) {
        out.textContent = cleanError(e);
        return;
      }
      load();
    });
    actions.append(out);
    if (s.configured) {
      const test = el("button", "ghost small", "Test connection");
      test.addEventListener("click", async () => {
        out.textContent = "Testing…";
        await api.sourcesTest(s.id).catch(() => {});
        load();
      });
      const remove = el("button", "danger small", "Remove");
      remove.addEventListener("click", async () => {
        if (!confirm(`Remove your ${s.label} key from this computer?`)) return;
        await api.sourcesRemove(s.id);
        load();
      });
      actions.append(test, remove);
    }
    actions.append(save);
    card.append(actions);
    if (s.id === "x" && snap) {
      const u = snap.settings.xUsage;
      const limitRow = el("div", "source-limit small-text");
      const lim = Object.assign(el("input"), { type: "number", min: "0", step: "10", value: String(snap.settings.xMonthlyLimit) });
      const saveLim = el("button", "ghost small", "Set limit");
      saveLim.addEventListener("click", async () => {
        await api.shoppingSaveSettings({ xMonthlyLimit: Number(lim.value) });
        load();
      });
      limitRow.append(el("span", "", `Posts read this month: ${u.month === new Date().toISOString().slice(0, 7) ? u.posts : 0}. Stop at`), lim, el("span", "", "per month"), saveLim);
      card.append(limitRow, el("p", "muted small-text", "X watches check at most every 15 minutes and read up to 10 posts per check. Match this limit to your X plan."));
    }
    return card;
  }

  function renderServiceCard() {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.append(el("span", "connector-name", "Reading store pages"), el("span", "connector-where", "plain download → shopping browser → rendering service"));
    card.append(head);
    card.append(el("p", "muted small-text", "Most pages are read directly or with the shopping browser. For stores that still can't be read, SlopBot can use a rendering service with your own key. That service sees the product addresses you watch (never your sign-ins)."));
    const sel = el("select", "bot-select");
    for (const [v, label] of [
      ["none", "Don't use a rendering service"],
      ["scrapingbee", "ScrapingBee"],
      ["scraperapi", "ScraperAPI"],
    ])
      sel.append(Object.assign(el("option", "", label), { value: v, selected: snap?.settings.renderService === v }));
    sel.addEventListener("change", async () => {
      await api.shoppingSaveSettings({ renderService: sel.value as "none" | "scrapingbee" | "scraperapi" });
      load();
    });
    card.append(sel);
    return card;
  }

  function feedsCard() {
    const feeds = snap!.settings.savedFeeds;
    const card = el("div", "card shop-feeds");
    const head = el("div", "card-head");
    head.append(el("span", "connector-name", "RSS / Atom deal feeds"), el("span", "connector-where", "no keys needed"));
    card.append(head);
    const list = el("div", "feed-list");
    if (!feeds.length) list.append(el("p", "muted small-text", "No saved feeds. Add one below."));
    for (const f of feeds) {
      const row = el("div", "feed-row");
      const use = el("button", "ghost small", "Watch");
      use.addEventListener("click", () => opts.watchFeed(f));
      const del = el("button", "ghost small", "Remove");
      del.addEventListener("click", async () => {
        await api.shoppingSaveSettings({ savedFeeds: feeds.filter((x) => x.url !== f.url) });
        load();
      });
      row.append(el("span", "feed-label", f.label), el("span", "feed-url", f.url), use, del);
      list.append(row);
    }
    card.append(list);
    const add = el("div", "feed-add");
    const name = Object.assign(el("input"), { placeholder: "Name, e.g. r/gamedeals", autocomplete: "off" });
    const url = Object.assign(el("input", "mono"), { placeholder: "https://… (RSS or Atom feed)", autocomplete: "off", spellcheck: false });
    const btn = el("button", "primary small", "Add feed");
    const err = el("div", "watch-error small-text");
    btn.addEventListener("click", async () => {
      err.textContent = "";
      try {
        const u = url.value.trim();
        await api.shoppingSaveSettings({ savedFeeds: [...feeds, { label: name.value.trim() || u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0], url: u }] });
        load();
      } catch (e) {
        err.textContent = cleanError(e);
      }
    });
    add.append(name, url, btn);
    card.append(add, err, el("p", "muted small-text", "Tip: subreddits have a feed at reddit.com/r/NAME/new/.rss; many deal sites link one in their footer."));
    return card;
  }

  function browserCard() {
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.append(el("span", "connector-name", "Shopping browser sign-ins"), el("span", "connector-where", "kept on this computer only"));
    card.append(head);
    card.append(
      el(
        "p",
        "muted small-text",
        "Sign in to your stores here and keep your address and card saved in each store account. The shopper bot never types passwords, codes or card details; if a store asks, the purchase pauses for you.",
      ),
    );
    const actions = el("div", "card-actions");
    const open = el("button", "primary small", "Open shopping browser");
    open.addEventListener("click", () => api.shoppingOpenBrowser());
    const clear = el("button", "danger small", "Remove saved sign-ins");
    clear.addEventListener("click", async () => {
      if (!confirm("Sign out of every store in the shopping browser and delete its cookies and cache?")) return;
      await api.shoppingClearSignIns();
      showError("");
      clear.textContent = "Removed";
    });
    actions.append(clear, open);
    card.append(actions);
    return card;
  }

  function render() {
    if (!snap) return;
    const parts: HTMLElement[] = [];
    if (!snap.model.local)
      parts.push(el("div", "note", `Checkout uses ${snap.model.model}, a cloud model. The cart and checkout summaries it reads (with names, addresses and card details removed) are sent to that provider. Use a local model (Models) to keep everything on this computer.`));
    parts.push(el("div", "section-label", "Feeds"), feedsCard());
    parts.push(el("div", "section-label", "Accounts you connect"));
    for (const s of sources) parts.push(sourceCard(s));
    parts.push(renderServiceCard());
    parts.push(el("div", "section-label", "Stores"), browserCard());
    $("sources-list").replaceChildren(...parts);
  }

  return { load };
}

export type { SourceId };
