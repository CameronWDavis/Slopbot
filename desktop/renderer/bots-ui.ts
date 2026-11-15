// Bot editor: create a bot from scratch or from an existing one, edit it, or delete it. Bots you make
// are saved in your private data; editing a built-in bot saves your own copy that replaces it.
import type { BotDraft, SlopbotApi, ToolInfo } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const RISK_LABEL: Record<string, string> = { read: "reads", write: "changes files", external: "asks first", dangerous: "always asks" };
const GROUP_LABEL: Record<string, string> = {
  fs: "Files (in its workspace and the folders below)",
  shell: "Run commands",
  http: "Web requests",
  web: "Web search",
  memory: "Memory",
  email: "Email",
  finance: "Finance ledger",
  browser: "Shopping browser",
  vault: "Saved logins & keys (Vault)",
};
const glob = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);

const BLANK: BotDraft = {
  name: "",
  description: "",
  persona: "You are a helpful assistant for me.\n- \n",
  model: "",
  tools: ["memory.*", "web.search", "http.fetch"],
  allowedPaths: [],
  sites: [],
  schedules: [],
};

export function createBotEditor(api: SlopbotApi, hooks: { bots: () => string[]; models: () => string[]; onSaved: (name: string) => void; onDeleted: (name: string) => void }) {
  let tools: ToolInfo[] = [];
  let editing: (BotDraft & { custom: boolean; overridesBuiltIn: boolean }) | undefined;
  let extraTools: string[] = []; // e.g. mcp.* patterns the checkboxes don't show; kept as-is

  function renderTools(selected: string[]) {
    const box = $("bot-tools");
    box.replaceChildren();
    extraTools = selected.filter((p) => !tools.some((t) => glob(p, t.name)));
    const groups = new Map<string, ToolInfo[]>();
    for (const t of tools) {
      const g = t.name.split(".")[0];
      groups.set(g, [...(groups.get(g) ?? []), t]);
    }
    for (const [g, list] of groups) {
      const fs = el("fieldset", "tool-group");
      const legend = el("legend");
      const all = el("input");
      all.type = "checkbox";
      const label = el("label", "check");
      label.append(all, document.createTextNode(GROUP_LABEL[g] ?? g));
      legend.append(label);
      fs.append(legend);
      const boxes: HTMLInputElement[] = [];
      for (const t of list) {
        const l = el("label", "check tool-check");
        const cb = el("input");
        cb.type = "checkbox";
        cb.value = t.name;
        cb.checked = selected.some((p) => glob(p, t.name));
        boxes.push(cb);
        l.title = t.description;
        l.append(cb, el("code", "", t.name), el("span", `tag risk-${t.risk}`, RISK_LABEL[t.risk] ?? t.risk));
        fs.append(l);
      }
      const sync = () => {
        all.checked = boxes.every((b) => b.checked);
        all.indeterminate = !all.checked && boxes.some((b) => b.checked);
      };
      all.addEventListener("change", () => (boxes.forEach((b) => (b.checked = all.checked)), sync()));
      boxes.forEach((b) => b.addEventListener("change", sync));
      sync();
      box.append(fs);
    }
  }

  /** Whole groups become "group.*" so tools added to that group later are included too. */
  function selectedTools(): string[] {
    const out: string[] = [];
    for (const fs of $("bot-tools").querySelectorAll("fieldset")) {
      const boxes = [...fs.querySelectorAll<HTMLInputElement>("input[value]")];
      const on = boxes.filter((b) => b.checked).map((b) => b.value);
      if (on.length && on.length === boxes.length && boxes.length > 1) out.push(`${on[0].split(".")[0]}.*`);
      else out.push(...on);
    }
    return [...out, ...extraTools];
  }

  function scheduleRow(s?: BotDraft["schedules"][number]) {
    const row = el("div", "schedule-row");
    const name = Object.assign(el("input"), { placeholder: "name", value: s?.name ?? "" });
    const cron = Object.assign(el("input", "mono"), { placeholder: "0 8 * * MON", value: s?.cron ?? "", title: 'When to run (cron): "0 8 * * MON" = Mondays 8:00, "30 7 * * *" = every day 7:30' });
    const notify = el("select", "bot-select");
    for (const [v, t] of [
      ["none", "Just run"],
      ["telegram", "Send to Telegram"],
      ["email", "Email me"],
    ])
      notify.append(Object.assign(el("option", "", t), { value: v, selected: (s?.notify ?? "none") === v }));
    const task = Object.assign(el("textarea", "schedule-task"), { placeholder: "What should it do? e.g. Summarize today's top tech news in 5 bullets.", value: s?.task ?? "", rows: 2 });
    const del = el("button", "ghost small", "Remove");
    del.type = "button";
    del.addEventListener("click", () => row.remove());
    const top = el("div", "schedule-top");
    top.append(name, cron, notify, del);
    row.append(top, task);
    $("bot-schedules").append(row);
  }

  function fill(d: BotDraft) {
    $<HTMLInputElement>("bot-name").value = d.name;
    $<HTMLInputElement>("bot-description").value = d.description;
    $<HTMLTextAreaElement>("bot-persona").value = d.persona;
    const model = $<HTMLSelectElement>("bot-model");
    model.replaceChildren(Object.assign(el("option", "", "Default model"), { value: "" }));
    for (const m of new Set([...hooks.models(), ...(d.model ? [d.model] : [])])) model.append(Object.assign(el("option", "", m), { value: m }));
    model.value = d.model ?? "";
    renderTools(d.tools);
    $<HTMLTextAreaElement>("bot-paths").value = d.allowedPaths.join("\n");
    $<HTMLInputElement>("bot-sites").value = d.sites.join(", ");
    $<HTMLInputElement>("bot-steps").value = d.maxSteps ? String(d.maxSteps) : "";
    $<HTMLInputElement>("bot-temp").value = d.temperature !== undefined ? String(d.temperature) : "";
    $("bot-schedules").replaceChildren();
    for (const s of d.schedules) scheduleRow(s);
  }

  async function open(name?: string) {
    $("bot-form-error").hidden = true;
    tools = await api.botTools();
    editing = name ? await api.getBot(name) : undefined;
    $("bot-form-title").textContent = name ? `Edit ${name}` : "New bot";
    $("bot-template-row").hidden = !!name;
    const tpl = $<HTMLSelectElement>("bot-template");
    tpl.replaceChildren(Object.assign(el("option", "", "Blank"), { value: "" }), ...hooks.bots().map((b) => Object.assign(el("option", "", `Copy of ${b}`), { value: b })));
    const note = $("bot-form-note");
    note.hidden = !editing || editing.custom;
    note.textContent = "This bot comes with SlopBot. Saving keeps your own copy in your private data; delete it any time to get the original back.";
    const del = $<HTMLButtonElement>("bot-delete");
    del.hidden = !editing?.custom;
    del.textContent = editing?.overridesBuiltIn ? "Reset to original" : "Delete bot";
    fill(editing ?? BLANK);
    $("bot-form").hidden = false;
    $<HTMLInputElement>(name ? "bot-description" : "bot-name").focus();
  }

  async function useTemplate() {
    const from = $<HTMLSelectElement>("bot-template").value;
    const d = from ? { ...(await api.getBot(from)), name: "" } : BLANK;
    const typedName = $<HTMLInputElement>("bot-name").value;
    fill({ ...d, name: typedName, description: d.description });
  }

  async function save() {
    const lines = (id: string) =>
      $<HTMLTextAreaElement>(id)
        .value.split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
    const schedules = [...$("bot-schedules").querySelectorAll<HTMLElement>(".schedule-row")].map((r) => {
      const [name, cron] = r.querySelectorAll<HTMLInputElement>("input");
      return { name: name.value, cron: cron.value, notify: r.querySelector<HTMLSelectElement>("select")!.value as "none", task: r.querySelector<HTMLTextAreaElement>("textarea")!.value };
    });
    try {
      const name = await api.saveBot({
        previousName: editing?.name,
        name: $<HTMLInputElement>("bot-name").value,
        description: $<HTMLInputElement>("bot-description").value,
        persona: $<HTMLTextAreaElement>("bot-persona").value,
        model: $<HTMLSelectElement>("bot-model").value,
        tools: selectedTools(),
        allowedPaths: lines("bot-paths"),
        sites: $<HTMLInputElement>("bot-sites").value.split(/[,\s]+/).filter(Boolean),
        maxSteps: $<HTMLInputElement>("bot-steps").value ? Number($<HTMLInputElement>("bot-steps").value) : undefined,
        temperature: $<HTMLInputElement>("bot-temp").value ? Number($<HTMLInputElement>("bot-temp").value) : undefined,
        schedules,
      });
      $("bot-form").hidden = true;
      hooks.onSaved(name);
    } catch (e) {
      $("bot-form-error").textContent = cleanError(e);
      $("bot-form-error").hidden = false;
      $("bot-form-error").scrollIntoView({ block: "nearest" });
    }
  }

  async function remove() {
    if (!editing) return;
    const msg = editing.overridesBuiltIn ? `Throw away your changes to "${editing.name}" and go back to the original?` : `Delete the bot "${editing.name}"? Its chats and memory stay in your data folder.`;
    if (!confirm(msg)) return;
    try {
      await api.deleteBot(editing.name);
      $("bot-form").hidden = true;
      hooks.onDeleted(editing.name);
    } catch (e) {
      $("bot-form-error").textContent = cleanError(e);
      $("bot-form-error").hidden = false;
    }
  }

  // Typing a name: keep it in the form bots use.
  $("bot-name").addEventListener("input", () => {
    const i = $<HTMLInputElement>("bot-name");
    const v = i.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
    if (v !== i.value) i.value = v;
  });
  $("bot-template").addEventListener("change", useTemplate);
  $("bot-add-schedule").addEventListener("click", () => scheduleRow());
  $("bot-save").addEventListener("click", save);
  $("bot-delete").addEventListener("click", remove);
  $("bot-cancel").addEventListener("click", () => ($("bot-form").hidden = true));
  window.addEventListener("keydown", (e) => e.key === "Escape" && !$("bot-form").hidden && ($("bot-form").hidden = true));

  return { open };
}
