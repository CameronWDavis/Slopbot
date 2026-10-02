// Vault tab (credentials bots can use but never see) and the Web search settings card.
import type { SearchProvider, SearchSettings, SlopbotApi, VaultEntryInfo } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const ago = (iso?: string) => {
  if (!iso) return "never used";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "used just now";
  if (s < 5400) return `used ${Math.round(s / 60)} min ago`;
  if (s < 129600) return `used ${Math.round(s / 3600)} h ago`;
  return `used ${Math.round(s / 86400)} days ago`;
};

export function createVault(api: SlopbotApi, getBots: () => string[]) {
  let entries: VaultEntryInfo[] = [];
  let editing: VaultEntryInfo | undefined;
  let kind: "api_key" | "login" = "api_key";

  async function load() {
    try {
      entries = await api.vaultList();
      $("vault-error").hidden = true;
    } catch (e) {
      $("vault-error").textContent = cleanError(e);
      $("vault-error").hidden = false;
      entries = [];
    }
    render();
  }

  function render() {
    const box = $("vault-list");
    if (!entries.length) {
      box.replaceChildren(
        el("p", "muted", "Nothing saved yet. Add an API key (GitHub, Notion, Stripe…) or a login, and choose which websites it's for. Bots can then use it on those sites without ever seeing it."),
      );
      return;
    }
    box.replaceChildren(
      ...entries.map((e) => {
        const card = el("div", "card vault-card");
        const head = el("div", "card-head");
        head.append(el("span", "vault-lock", "🔒"), el("span", "connector-name", e.name), el("span", "tag", e.kind === "login" ? "login" : "API key"));
        card.append(head);
        const meta = el("div", "vault-meta");
        const sites = el("div", "chips");
        sites.append(el("span", "chips-label", "Only for"), ...e.domains.map((d) => el("span", "chip on", d)));
        meta.append(sites);
        const info = [
          e.username ? `user ${e.username}` : "",
          e.kind === "api_key" ? (e.sendAs === "header" ? `sent as ${e.field} header` : e.sendAs === "query" ? `sent as ?${e.field}=` : "sent as Bearer token") : "sent as Basic auth",
          e.bots.includes("*") ? "all bots" : `bots: ${e.bots.join(", ")}`,
          ago(e.lastUsedAt),
        ].filter(Boolean);
        meta.append(el("div", "muted small-text", info.join(" · ")));
        card.append(meta);
        const actions = el("div", "card-actions");
        const edit = el("button", "ghost small", "Edit");
        edit.addEventListener("click", () => openForm(e));
        const del = el("button", "danger small", "Delete");
        del.addEventListener("click", async () => {
          if (!confirm(`Delete "${e.name}" from the vault? Bots will no longer be able to use it.`)) return;
          await api.vaultRemove(e.id);
          load();
        });
        actions.append(edit, del);
        card.append(actions);
        return card;
      }),
    );
  }

  function setKind(k: "api_key" | "login") {
    kind = k;
    document.querySelectorAll<HTMLButtonElement>("#vault-kind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === k));
    $("vault-login-fields").hidden = k !== "login";
    $("vault-key-fields").hidden = k !== "api_key";
    $("vault-secret-label").textContent = k === "login" ? "Password" : "API key or token";
    syncSendAs();
  }

  function syncSendAs() {
    const v = $<HTMLSelectElement>("vault-sendas").value;
    $("vault-field-row").hidden = v === "bearer";
    $<HTMLInputElement>("vault-field").placeholder = v === "query" ? "e.g. api_key" : "e.g. X-API-Key";
  }

  function botChecks(selected: string[]) {
    const box = $("vault-bots");
    box.replaceChildren();
    const all = el("label", "check");
    const allCb = el("input");
    allCb.type = "checkbox";
    allCb.value = "*";
    allCb.checked = selected.includes("*");
    all.append(allCb, document.createTextNode("All bots"));
    box.append(all);
    const boxes: HTMLInputElement[] = [];
    for (const b of getBots()) {
      const l = el("label", "check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = b;
      cb.checked = allCb.checked || selected.includes(b);
      cb.disabled = allCb.checked;
      boxes.push(cb);
      l.append(cb, document.createTextNode(b));
      box.append(l);
    }
    allCb.addEventListener("change", () => boxes.forEach((cb) => ((cb.disabled = allCb.checked), (cb.checked = allCb.checked || cb.checked))));
  }

  function openForm(e?: VaultEntryInfo) {
    editing = e;
    $("vault-form-title").textContent = e ? `Edit ${e.name}` : "Add to vault";
    $<HTMLInputElement>("vault-name").value = e?.name ?? "";
    $<HTMLInputElement>("vault-domains").value = e?.domains.join(", ") ?? "";
    $<HTMLInputElement>("vault-username").value = e?.username ?? "";
    $<HTMLSelectElement>("vault-sendas").value = e?.sendAs ?? "bearer";
    $<HTMLInputElement>("vault-field").value = e?.field ?? "";
    const secret = $<HTMLInputElement>("vault-secret");
    secret.value = "";
    secret.type = "password";
    secret.placeholder = e ? "🔒 saved (type to replace)" : "paste it here";
    secret.classList.toggle("has-secret", !!e);
    botChecks(e?.bots ?? ["*"]);
    setKind(e?.kind ?? "api_key");
    $("vault-form-error").hidden = true;
    $("vault-form").hidden = false;
    $<HTMLInputElement>("vault-name").focus();
  }

  async function save() {
    const bots = [...$("vault-bots").querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
    try {
      await api.vaultSave({
        id: editing?.id,
        name: $<HTMLInputElement>("vault-name").value,
        kind,
        domains: $<HTMLInputElement>("vault-domains").value.split(/[,\s]+/).filter(Boolean),
        username: $<HTMLInputElement>("vault-username").value,
        sendAs: $<HTMLSelectElement>("vault-sendas").value as VaultEntryInfo["sendAs"],
        field: $<HTMLInputElement>("vault-field").value,
        bots: bots.includes("*") ? ["*"] : bots,
        secret: $<HTMLInputElement>("vault-secret").value,
      });
      $<HTMLInputElement>("vault-secret").value = ""; // don't keep it in the DOM
      $("vault-form").hidden = true;
      load();
    } catch (e) {
      $("vault-form-error").textContent = cleanError(e);
      $("vault-form-error").hidden = false;
    }
  }

  $("vault-add").addEventListener("click", () => openForm());
  document.querySelectorAll<HTMLButtonElement>("#vault-kind button").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind as "api_key" | "login")));
  $("vault-sendas").addEventListener("change", syncSendAs);
  $("vault-save").addEventListener("click", save);
  $("vault-cancel").addEventListener("click", () => {
    $<HTMLInputElement>("vault-secret").value = "";
    $("vault-form").hidden = true;
  });
  $("vault-show").addEventListener("click", () => {
    const s = $<HTMLInputElement>("vault-secret");
    s.type = s.type === "password" ? "text" : "password";
  });
  window.addEventListener("keydown", (e) => e.key === "Escape" && !$("vault-form").hidden && ($("vault-form").hidden = true));

  return { load };
}

// ── Web search settings card ─────────────────────────
const PROVIDERS: { id: SearchProvider; label: string; blurb: string; keyUrl?: string }[] = [
  { id: "auto", label: "Automatic", blurb: "Use whichever search you've set up below; falls back to Basic." },
  { id: "ollama", label: "Ollama web search", blurb: "Free API key from your ollama.com account.", keyUrl: "https://ollama.com/settings/keys" },
  { id: "brave", label: "Brave Search", blurb: "Independent index; free tier with an API key.", keyUrl: "https://api-dashboard.search.brave.com/" },
  { id: "tavily", label: "Tavily", blurb: "Search built for AI agents; free tier with an API key.", keyUrl: "https://app.tavily.com/" },
  { id: "searxng", label: "SearXNG (self-hosted)", blurb: "Your own open-source metasearch server. No key." },
  { id: "basic", label: "Basic (no key)", blurb: "DuckDuckGo instant answers + Wikipedia. Encyclopedia-style results only." },
];

export function createSearchCard(api: SlopbotApi) {
  let s: SearchSettings | null = null;

  async function load() {
    s = await api.searchGet();
    render();
  }

  function render() {
    if (!s) return;
    const box = $("search-card");
    const current = s;
    const card = el("div", "card search-card");
    const head = el("div", "card-head");
    head.append(el("span", "dot"), el("span", "connector-name", "Web search"), el("span", "connector-where", `built in · bots call web.search · now using: ${current.active || "—"}`));
    card.append(head);
    if (current.problem) card.append(el("div", "connector-error", current.problem));

    const row = el("div", "search-row");
    const sel = el("select", "bot-select");
    for (const p of PROVIDERS) {
      const label = p.id !== "auto" && current.keys[p.id] ? `${p.label} ✓` : p.label;
      sel.append(Object.assign(el("option", "", label), { value: p.id, selected: p.id === current.provider }));
    }
    const blurb = el("div", "muted small-text");
    const keyRow = el("div", "search-key");
    const key = el("input");
    key.type = "password";
    key.spellcheck = false;
    const getKey = el("a", "small-text", "Get a key ↗");
    getKey.target = "_blank";
    const forget = el("button", "ghost small", "Forget key");
    keyRow.append(key, getKey, forget);
    const url = el("input");
    url.placeholder = "http://localhost:8888";
    url.value = current.searxngUrl;
    url.className = "search-url";

    const sync = () => {
      const p = PROVIDERS.find((x) => x.id === sel.value)!;
      blurb.textContent = p.blurb;
      const keyed = ["ollama", "brave", "tavily"].includes(p.id);
      keyRow.hidden = !keyed;
      key.value = "";
      key.placeholder = current.keys[p.id] ? "🔒 saved in Keychain (type to replace)" : `${p.label} API key`;
      key.classList.toggle("has-secret", !!current.keys[p.id]);
      forget.hidden = !current.keys[p.id];
      if (p.keyUrl) getKey.href = p.keyUrl;
      url.hidden = p.id !== "searxng";
    };
    sel.addEventListener("change", sync);
    forget.addEventListener("click", async () => {
      await api.searchForgetKey(sel.value as SearchProvider);
      load();
    });

    const save = el("button", "primary small", "Save");
    const testBtn = el("button", "ghost small", "Test search");
    const out = el("div", "search-results");
    save.addEventListener("click", async () => {
      try {
        await api.searchSave({ provider: sel.value as SearchProvider, searxngUrl: url.value, key: key.value ? { provider: sel.value as SearchProvider, value: key.value } : undefined });
        key.value = "";
        await load();
      } catch (e) {
        out.replaceChildren(el("div", "connector-error", cleanError(e)));
      }
    });
    testBtn.addEventListener("click", async () => {
      out.replaceChildren(el("div", "muted small-text", "Searching…"));
      try {
        const r = await api.searchTest("open source AI agents");
        const list = el("div", "result-list");
        list.append(el("div", "test-ok", `✓ ${r.results.length} results via ${r.provider}`));
        for (const x of r.results.slice(0, 4)) {
          const a = el("a", "result-link", x.title);
          a.href = x.url;
          a.target = "_blank";
          list.append(a);
        }
        out.replaceChildren(list);
      } catch (e) {
        out.replaceChildren(el("div", "connector-error", cleanError(e)));
      }
    });
    row.append(sel, save, testBtn);
    card.append(row, blurb, keyRow, url, out);
    box.replaceChildren(card);
    sync();
  }

  return { load };
}
