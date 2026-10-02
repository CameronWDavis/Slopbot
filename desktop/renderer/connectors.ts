// Connectors view: add MCP servers and choose which bots can use them.
import type { McpServerDef, McpServerStatus, McpToolInfo, SlopbotApi } from "../api.js";

interface Preset {
  name: string;
  title: string;
  blurb: string;
  def: (home: string) => McpServerDef;
  note?: string;
}

const PRESETS: Preset[] = [
  {
    name: "files",
    title: "Filesystem",
    blurb: "Read and write files in a folder you pick",
    def: (home) => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", `${home}/Documents`] }),
    note: "The last part of the command is the folder it can access. Change it to any folder.",
  },
  {
    name: "browser",
    title: "Browser",
    blurb: "A real Playwright browser your bot can drive",
    def: () => ({ command: "npx", args: ["-y", "@playwright/mcp@latest"] }),
  },
  {
    name: "github",
    title: "GitHub",
    blurb: "Repos, issues and PRs via GitHub's hosted server",
    def: () => ({ url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer " } }),
    note: "Paste a GitHub personal access token after “Bearer ” (github.com → Settings → Developer settings → Tokens).",
  },
  {
    name: "knowledge-graph",
    title: "Knowledge graph",
    blurb: "Long-term memory as entities and relations",
    def: () => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }),
  },
  {
    name: "sequential-thinking",
    title: "Sequential thinking",
    blurb: "A step-by-step reasoning scratchpad",
    def: () => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }),
  },
  {
    name: "everything",
    title: "Everything (demo)",
    blurb: "Reference server with sample tools, good for testing",
    def: () => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
  },
];

const RISK_LABEL: Record<string, string> = { read: "read-only", write: "writes", external: "asks first", dangerous: "destructive" };

/** Split a command line into argv, honoring quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export const joinCommand = (argv: string[]) => argv.map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function createConnectors(api: SlopbotApi, getBots: () => string[], getHome: () => string, onChange: () => void) {
  let servers: McpServerStatus[] = [];
  let editing: string | undefined; // original name while editing
  let kind: "command" | "url" = "command";

  // ── list ──────────────────────────────────────────
  async function load(autoConnect = true) {
    servers = await api.mcpList();
    render();
    if (!autoConnect) return;
    // Connect idle servers in the background so tool counts show up without clicking anything.
    for (const s of servers.filter((x) => x.state === "idle")) {
      s.state = "connecting";
      render();
      api.mcpConnect(s.name).then((st) => {
        const i = servers.findIndex((x) => x.name === s.name);
        if (st && i >= 0) servers[i] = st;
        render();
        onChange();
      });
    }
  }

  function botChips(s: McpServerStatus) {
    const wrap = el("div", "chips");
    const bots = s.def.bots ?? [];
    const all = bots.includes("*");
    const toggle = async (next: string[]) => {
      await api.mcpSave(s.name, { ...s.def, bots: next });
      s.def.bots = next;
      render();
      onChange();
    };
    const allChip = el("button", `chip${all ? " on" : ""}`, "All bots");
    allChip.addEventListener("click", () => toggle(all ? [] : ["*"]));
    wrap.append(el("span", "chips-label", "Used by"), allChip);
    for (const b of getBots()) {
      const on = all || bots.includes(b);
      const chip = el("button", `chip${on ? " on" : ""}`, b);
      chip.disabled = all;
      chip.addEventListener("click", () => toggle(on ? bots.filter((x) => x !== b) : [...bots.filter((x) => x !== "*"), b]));
      wrap.append(chip);
    }
    return wrap;
  }

  function toolList(tools: McpToolInfo[]) {
    const det = el("details", "tool-list");
    det.append(el("summary", "", `${tools.length} tool${tools.length === 1 ? "" : "s"}`));
    const ul = el("div", "tool-grid");
    for (const t of tools) {
      const row = el("div", "tool-row");
      row.title = t.description;
      row.append(el("span", "tool-name", t.name), el("span", `risk ${t.risk}`, RISK_LABEL[t.risk] ?? t.risk));
      ul.append(row);
    }
    det.append(ul);
    return det;
  }

  function render() {
    const box = $("connectors");
    if (!servers.length) {
      box.replaceChildren(el("p", "muted", "No servers yet. Pick a quick add above, paste JSON from Claude Desktop or Cursor, or add your own."));
      return;
    }
    box.replaceChildren(
      ...servers.map((s) => {
        const card = el("div", `card connector ${s.state}`);
        const head = el("div", "card-head");
        const dot = el("span", `dot ${s.state === "connected" ? "" : s.state === "error" ? "err" : s.state === "connecting" ? "busy" : "off"}`);
        const where = s.def.url ?? joinCommand([s.def.command ?? "", ...(s.def.args ?? [])]);
        const sw = el("label", "switch");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = s.def.enabled !== false;
        cb.addEventListener("change", async () => {
          await api.mcpSave(s.name, { ...s.def, enabled: cb.checked });
          await load();
          onChange();
        });
        sw.append(cb, el("span", "slider"));
        sw.title = cb.checked ? "Enabled" : "Disabled";
        head.append(dot, el("span", "connector-name", s.name), el("span", "connector-where", where), sw);
        card.append(head);

        const stateText =
          s.state === "connecting" ? "Connecting… (first run may download the server)" : s.state === "disabled" ? "Disabled" : s.state === "error" ? "" : "";
        if (stateText) card.append(el("div", "muted small-text", stateText));
        if (s.error) card.append(el("div", "connector-error", s.error));
        if (s.tools.length) card.append(toolList(s.tools));
        card.append(botChips(s));

        const actions = el("div", "card-actions");
        const retry = el("button", "ghost small", s.state === "error" ? "Retry" : "Reconnect");
        retry.addEventListener("click", async () => {
          s.state = "connecting";
          s.error = undefined;
          render();
          const st = await api.mcpConnect(s.name);
          const i = servers.findIndex((x) => x.name === s.name);
          if (st && i >= 0) servers[i] = st;
          render();
        });
        const edit = el("button", "ghost small", "Edit");
        edit.addEventListener("click", () => openForm(s.name, s.def));
        const rm = el("button", "danger small", "Remove");
        rm.addEventListener("click", async () => {
          if (!confirm(`Remove ${s.name}? Bots will lose its tools.`)) return;
          await api.mcpRemove(s.name);
          await load(false);
          onChange();
        });
        actions.append(retry, edit, rm);
        card.append(actions);
        return card;
      }),
    );
  }

  function renderPresets() {
    $("presets").replaceChildren(
      ...PRESETS.map((p) => {
        const b = el("button", "preset");
        b.append(el("span", "preset-title", p.title), el("span", "preset-blurb", p.blurb));
        b.addEventListener("click", () => openForm(undefined, { ...p.def(getHome()), bots: ["*"] }, p.name, p.note));
        return b;
      }),
    );
  }

  // ── add / edit form ───────────────────────────────
  function kvRows(containerId: string, map: Record<string, string> | undefined, keyPh: string) {
    const box = $(containerId);
    box.replaceChildren();
    const add = (k = "", v = "") => {
      const row = el("div", "kv-row");
      const ki = el("input");
      ki.placeholder = keyPh;
      ki.value = k;
      const vi = el("input");
      vi.placeholder = "value";
      vi.type = "password";
      vi.value = v;
      vi.addEventListener("focus", () => (vi.type = "text"));
      vi.addEventListener("blur", () => (vi.type = "password"));
      const x = el("button", "ghost small", "✕");
      x.type = "button";
      x.addEventListener("click", () => row.remove());
      row.append(ki, vi, x);
      box.append(row);
      return ki;
    };
    for (const [k, v] of Object.entries(map ?? {})) add(k, v);
    return add;
  }

  const readKv = (id: string) =>
    Object.fromEntries(
      [...$(id).querySelectorAll<HTMLElement>(".kv-row")]
        .map((r) => [...r.querySelectorAll("input")].map((i) => i.value))
        .filter(([k]) => k.trim())
        .map(([k, v]) => [k.trim(), v]),
    );

  let addEnv: (k?: string, v?: string) => HTMLInputElement = () => el("input");
  let addHeader: (k?: string, v?: string) => HTMLInputElement = () => el("input");

  function setKind(k: "command" | "url") {
    kind = k;
    document.querySelectorAll<HTMLButtonElement>("#mcp-kind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === k));
    $("mcp-command-fields").hidden = k !== "command";
    $("mcp-url-fields").hidden = k !== "url";
  }

  function formBots(selected: string[]) {
    const box = $("mcp-bots");
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

  const readBots = () => {
    const checked = [...$("mcp-bots").querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
    return checked.includes("*") ? ["*"] : checked;
  };

  function readForm(): { name: string; def: McpServerDef } {
    const name = $<HTMLInputElement>("mcp-name").value.trim();
    const prev = servers.find((s) => s.name === editing)?.def;
    const base: McpServerDef = { bots: readBots(), enabled: prev?.enabled ?? true };
    if (kind === "url") {
      const headers = readKv("mcp-headers");
      return { name, def: { ...base, url: $<HTMLInputElement>("mcp-url").value.trim(), ...(Object.keys(headers).length ? { headers } : {}) } };
    }
    const argv = splitCommand($<HTMLInputElement>("mcp-cmd").value);
    const env = readKv("mcp-env");
    return { name, def: { ...base, command: argv[0], args: argv.slice(1), ...(Object.keys(env).length ? { env } : {}) } };
  }

  function openForm(original?: string, def: McpServerDef = { bots: ["*"] }, suggestedName = "", note = "") {
    editing = original;
    $("mcp-form-title").textContent = original ? `Edit ${original}` : "Add MCP server";
    $<HTMLInputElement>("mcp-name").value = original ?? suggestedName;
    $<HTMLInputElement>("mcp-cmd").value = def.command ? joinCommand([def.command, ...(def.args ?? [])]) : "";
    $<HTMLInputElement>("mcp-url").value = def.url ?? "";
    addEnv = kvRows("mcp-env", def.env, "NAME (e.g. API_KEY)");
    addHeader = kvRows("mcp-headers", def.headers, "Header (e.g. Authorization)");
    formBots(def.bots ?? ["*"]);
    setKind(def.url ? "url" : "command");
    $("mcp-note").textContent = note;
    $("mcp-note").hidden = !note;
    $("mcp-test-result").replaceChildren();
    $("mcp-form").hidden = false;
    // Put the cursor where the user most likely needs to type.
    const focus = def.headers?.Authorization === "Bearer " ? $("mcp-headers").querySelector<HTMLInputElement>(".kv-row input[type=password]") : $<HTMLInputElement>(original || suggestedName ? (def.url ? "mcp-url" : "mcp-cmd") : "mcp-name");
    focus?.focus();
  }

  const closeForm = () => ($("mcp-form").hidden = true);

  async function test() {
    const out = $("mcp-test-result");
    const { name, def } = readForm();
    if (!def.command && !def.url) {
      out.replaceChildren(el("div", "connector-error", "Enter a command or URL first."));
      return;
    }
    out.replaceChildren(el("div", "muted", "Connecting… (the first run of an npx server can take a minute)"));
    const btn = $<HTMLButtonElement>("mcp-test");
    btn.disabled = true;
    try {
      const tools = await api.mcpTest(name || "test", def);
      const ok = el("div", "test-ok", `✓ Connected: ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
      out.replaceChildren(ok, toolList(tools));
      (out.querySelector("details") as HTMLDetailsElement).open = true;
    } catch (e: any) {
      out.replaceChildren(el("div", "connector-error", cleanError(e)));
    } finally {
      btn.disabled = false;
    }
  }

  async function save() {
    const { name, def } = readForm();
    const out = $("mcp-test-result");
    try {
      if (!name) throw new Error("Give it a name");
      await api.mcpSave(name, def, editing);
      closeForm();
      await load();
      onChange();
    } catch (e: any) {
      out.replaceChildren(el("div", "connector-error", cleanError(e)));
    }
  }

  // ── paste JSON ────────────────────────────────────
  async function importJson() {
    const out = $("mcp-import-result");
    try {
      const names = await api.mcpImport($<HTMLTextAreaElement>("mcp-json").value, ["*"]);
      out.replaceChildren(el("div", "test-ok", `✓ Added ${names.join(", ")}`));
      $<HTMLTextAreaElement>("mcp-json").value = "";
      await load();
      onChange();
      setTimeout(() => ($("mcp-import").hidden = true), 700);
    } catch (e: any) {
      out.replaceChildren(el("div", "connector-error", cleanError(e)));
    }
  }

  // ── wiring ────────────────────────────────────────
  $("mcp-add").addEventListener("click", () => openForm());
  $("mcp-paste").addEventListener("click", () => {
    $("mcp-import-result").replaceChildren();
    $("mcp-import").hidden = false;
    $("mcp-json").focus();
  });
  $("mcp-import-cancel").addEventListener("click", () => ($("mcp-import").hidden = true));
  $("mcp-import-go").addEventListener("click", importJson);
  document.querySelectorAll<HTMLButtonElement>("#mcp-kind button").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind as "command" | "url")));
  $("mcp-add-env").addEventListener("click", () => addEnv().focus());
  $("mcp-add-header").addEventListener("click", () => addHeader().focus());
  $("mcp-test").addEventListener("click", test);
  $("mcp-save").addEventListener("click", save);
  $("mcp-cancel").addEventListener("click", closeForm);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("mcp-form").hidden) closeForm();
    if (!$("mcp-import").hidden) $("mcp-import").hidden = true;
  });

  renderPresets();
  return { load, count: () => servers.filter((s) => s.def.enabled !== false).length };
}

// Electron wraps IPC errors as "Error invoking remote method 'x': Error: real message".
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
