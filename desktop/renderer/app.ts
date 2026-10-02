import type { AgentEvent, ApprovalRequest, BotSummary, SlopbotApi } from "../api.js";
import type { Director } from "./director.js";
import { renderMarkdown } from "./markdown.js";
import { mountMascot } from "./mascot.js";
import { createMockApi } from "./mock-api.js";
import { createConnectors } from "./connectors.js";
import { createModels } from "./models.js";
import { createSearchCard, createVault } from "./vault-ui.js";
import { createChannels } from "./channels-ui.js";

declare global {
  interface Window {
    slopbot?: SlopbotApi;
    slopbotPlatform?: string;
  }
}

const api: SlopbotApi = window.slopbot ?? createMockApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const brief = (args: unknown) => {
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
};

// ── state ─────────────────────────────────────────────
let bots: BotSummary[] = [];
let current = "";
let director: Director | null = null;
let homeDir = "~";
const connectors = createConnectors(
  api,
  () => bots.map((b) => b.name),
  () => homeDir,
  () => refreshConnectorCount(),
);

const models_ = createModels(api, {
  onConfigChanged: async () => {
    bots = await api.listBots();
    models = await api.listModels();
    renderBots();
    updateModelPicker();
  },
  onWork: (s) => (s === "start" ? director?.workStarted() : director?.workFinished(s === "done")),
});

const vault = createVault(api, () => bots.map((b) => b.name));
const searchCard = createSearchCard(api);
const channels = createChannels(api, () => bots.map((b) => b.name));

async function refreshConnectorCount() {
  const n = (await api.mcpList()).filter((s) => s.def.enabled !== false).length;
  const c = $("connectors-count");
  c.textContent = String(n);
  c.hidden = n === 0;
}
const threads = new Map<string, HTMLElement>();
const busy = new Set<string>();
const toolCards = new Map<string, HTMLDetailsElement>();
const typing = new Map<string, HTMLElement>();
const modelChoice = new Map<string, string>();
const approvalQueue: ApprovalRequest[] = [];

// ── mascot ────────────────────────────────────────────
const STATUS: Record<string, { text: string; dot: string }> = {
  idle: { text: "Ready", dot: "" },
  greeting: { text: "Hi there!", dot: "" },
  working: { text: "Working on it…", dot: "busy" },
  thinking: { text: "Working on it…", dot: "busy" },
  success: { text: "All done", dot: "" },
  playful_mishap: { text: "Hit a snag, see chat", dot: "err" },
  surprised: { text: "Needs your OK", dot: "alert" },
  amused: { text: "Haha", dot: "" },
  bored: { text: "Killing time", dot: "" },
  sleepy: { text: "Napping", dot: "sleep" },
};

function setStatus(state: string) {
  const s = STATUS[state] ?? STATUS.idle;
  // Same status in the nook and (for narrow windows) the titlebar chip.
  for (const [text, dot] of [["status-text", "status-dot"], ["status-text-mini", "status-dot-mini"]]) {
    $(text).textContent = s.text;
    $(dot).className = `dot ${s.dot}`;
  }
}

async function initMascot() {
  director = await mountMascot($("mascot"));
  if (!director) {
    setStatus("idle");
    return;
  }
  director.onState = setStatus;
  setStatus(director.state);
  director.greet();
  // Real user activity resets the inactivity clock and interrupts ambient antics.
  for (const type of ["keydown", "pointerdown", "wheel"] as const) {
    window.addEventListener(type, () => director?.userActivity(), { passive: true });
  }
  $("mascot").addEventListener("click", () => director?.greet());
}

// ── bots & views ──────────────────────────────────────
function renderBots() {
  const list = $("bot-list");
  list.replaceChildren(
    ...bots.map((b) => {
      const btn = el("button", `bot${b.name === current ? " active" : ""}`);
      const name = el("div", "bot-name", b.name);
      if (busy.has(b.name)) name.append(el("span", "busy-dot"));
      btn.append(name, el("div", "bot-desc", b.description));
      btn.addEventListener("click", () => selectBot(b.name));
      return btn;
    }),
  );
}

function threadFor(bot: string): HTMLElement {
  let t = threads.get(bot);
  if (!t) {
    t = el("div");
    t.style.display = "contents";
    threads.set(bot, t);
    t.append(emptyState(bot));
  }
  return t;
}

const SUGGESTIONS: Record<string, string[]> = {
  ledger: [
    "Import examples/sample-bank.csv and tell me where my money went",
    "How much did I spend on dining in September?",
    "Remember my monthly grocery budget is $300",
  ],
  coder: ["List the files in my workspace", "Write a hello.py that prints a friendly banner, then run it"],
  reporter: ["Fetch https://news.ycombinator.com and give me the 5 most interesting stories"],
};

function emptyState(bot: string) {
  const box = el("div", "empty");
  box.dataset.empty = "1";
  const art = el("div", "empty-art");
  const img = el("img");
  img.src = "assets/branding/icon-256.png";
  img.alt = "";
  art.append(img);
  box.append(art, el("h2", "", `What are we tackling with ${bot}?`), el("p", "", bots.find((b) => b.name === bot)?.description ?? ""));
  const sug = el("div", "suggestions");
  for (const s of SUGGESTIONS[bot] ?? []) {
    const b = el("button", "suggestion", s);
    b.addEventListener("click", () => {
      $<HTMLTextAreaElement>("input").value = s;
      autosize();
      $("input").focus();
    });
    sug.append(b);
  }
  box.append(sug);
  return box;
}

async function selectBot(name: string) {
  current = name;
  const b = bots.find((x) => x.name === name)!;
  $("chat-title").textContent = b.name;
  $("chat-desc").textContent = b.description;
  $("thread").replaceChildren(threadFor(name));
  renderBots();
  updateModelPicker();
  updateComposer();
  if (!$("view-memory").hidden) loadMemory();
  scrollThread();
}

function showView(view: string) {
  document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["chat", "approvals", "activity", "memory", "models", "vault", "channels", "connectors"]) $(`view-${v}`).hidden = v !== view;
  if (view === "channels") channels.load();
  if (view === "vault") vault.load();
  if (view === "connectors") searchCard.load();
  if (view === "models") models_.load();
  if (view === "connectors") connectors.load();
  if (view === "approvals") loadApprovals();
  if (view === "activity") loadActivity();
  if (view === "memory") loadMemory();
}

// ── models ────────────────────────────────────────────
let models: string[] = [];
function updateModelPicker() {
  const sel = $<HTMLSelectElement>("model");
  const bot = bots.find((b) => b.name === current);
  const chosen = modelChoice.get(current) ?? bot?.model ?? "";
  const all = [...new Set([chosen, ...models].filter(Boolean))];
  sel.replaceChildren(...all.map((m) => Object.assign(el("option", "", m), { value: m, selected: m === chosen })));
  $("model-pill").textContent = `model: ${chosen || "—"}`;
}

// ── chat ──────────────────────────────────────────────
function scrollThread() {
  const t = $("thread");
  t.scrollTop = t.scrollHeight;
}

function append(bot: string, node: HTMLElement) {
  const t = threadFor(bot);
  t.querySelector("[data-empty]")?.remove();
  const ty = typing.get(bot);
  if (ty) t.insertBefore(node, ty);
  else t.append(node);
  if (bot === current) scrollThread();
}

function setTyping(bot: string, on: boolean) {
  typing.get(bot)?.remove();
  typing.delete(bot);
  if (on) {
    const ty = el("div", "typing");
    ty.append(el("span"), el("span"), el("span"));
    threadFor(bot).append(ty);
    typing.set(bot, ty);
    if (bot === current) scrollThread();
  }
}

function updateComposer() {
  const isBusy = busy.has(current);
  $<HTMLButtonElement>("send").disabled = isBusy;
  $<HTMLButtonElement>("send").textContent = isBusy ? "Working…" : "Send";
}

async function send(text: string) {
  const bot = current;
  if (!text.trim() || busy.has(bot)) return;
  append(bot, el("div", "msg user", text));
  if (/\b(lol|lmao|haha+|rofl)\b|😂|🤣/i.test(text)) director?.amused();
  try {
    await api.send(bot, text, modelChoice.get(bot));
  } catch (e: any) {
    append(bot, errorMsg(e?.message ?? String(e)));
  }
}

function errorMsg(text: string) {
  const m = el("div", "msg error");
  m.append(el("strong", "", "Something went wrong: "), document.createTextNode(text));
  return m;
}

function onEvent(e: AgentEvent) {
  switch (e.type) {
    case "run.start":
      busy.add(e.bot);
      setTyping(e.bot, true);
      renderBots();
      updateComposer();
      director?.workStarted();
      break;

    case "tool.call": {
      const card = el("details", "tool");
      const sum = el("summary");
      const stateCls = e.decision === "deny" ? "deny" : e.decision === "ask" ? "ask" : "run";
      const stateText = e.decision === "deny" ? "blocked" : e.decision === "ask" ? "needs ok" : "running";
      sum.append(el("span", "tool-name", e.name), el("span", "tool-args", brief(e.args)), el("span", `tool-state ${stateCls}`, stateText));
      const body = el("div", "tool-body");
      body.append(el("div", "label", "arguments"), el("pre", "code", JSON.stringify(e.args, null, 2)));
      if (e.decision === "deny") body.append(el("div", "label", `blocked: ${e.reason}`));
      card.append(sum, body);
      toolCards.set(`${e.bot}:${e.id}`, card);
      append(e.bot, card);
      break;
    }

    case "tool.result": {
      const card = toolCards.get(`${e.bot}:${e.id}`);
      if (!card) break;
      const state = card.querySelector(".tool-state")!;
      state.className = `tool-state ${e.ok ? "ok" : "fail"}`;
      state.textContent = e.ok ? "done" : "failed";
      const body = card.querySelector(".tool-body")!;
      body.append(el("div", "label", "result"), el("pre", "code", e.result));
      if (e.name === "web.search" && e.ok && /source="web\.search:basic"/.test(e.result)) maybeSearchTip(e.bot);
      break;
    }

    case "text":
      // Intermediate narration between tool calls; the final reply arrives with run.end.
      break;

    case "run.end": {
      finish(e.bot, true);
      const m = el("div", "msg bot");
      m.innerHTML = renderMarkdown(e.text || "(no reply)");
      const meta = el("div", "msg-meta", `${e.steps} step${e.steps === 1 ? "" : "s"} · ${e.tokens.toLocaleString()} tokens`);
      if (e.pending.length) meta.textContent += ` · ${e.pending.length} awaiting approval`;
      m.append(meta);
      append(e.bot, m);
      if (e.pending.length) refreshApprovalBadge();
      break;
    }

    case "run.error":
      finish(e.bot, false);
      append(e.bot, errorMsg(e.error));
      break;
  }
}

// ── one-time nudge: Basic search is limited; offer to add a free key ──
const TIP_KEY = "slopbot.searchTip.dismissed";
let searchTipShownThisSession = false;

async function maybeSearchTip(bot: string) {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(TIP_KEY) === "1";
  } catch {}
  if (dismissed || searchTipShownThisSession || (await searchCard.upgraded())) return;
  searchTipShownThisSession = true;

  const tip = el("div", "tip");
  tip.append(
    el("span", "tip-icon", "🔎"),
    el("div", "tip-text", "Searches are limited to encyclopedia-style results right now. Add a free search key (Brave, Ollama, or Tavily) and your bots get the full web."),
  );
  const actions = el("div", "tip-actions");
  const setup = el("button", "primary small", "Set up web search");
  const later = el("button", "ghost small", "Not now");
  const never = el("button", "ghost small", "Don't show again");
  setup.addEventListener("click", () => {
    tip.remove();
    searchCard.focusNext("brave");
    showView("connectors"); // loads the search card once, which applies the focus
  });
  later.addEventListener("click", () => tip.remove());
  never.addEventListener("click", () => {
    try {
      localStorage.setItem(TIP_KEY, "1");
    } catch {}
    tip.remove();
  });
  actions.append(setup, later, never);
  tip.append(actions);
  append(bot, tip);
}

function finish(bot: string, ok: boolean) {
  busy.delete(bot);
  setTyping(bot, false);
  renderBots();
  updateComposer();
  // The mascot celebrates only when nothing else is still running.
  if (busy.size === 0) director?.workFinished(ok);
}

// ── approvals (interactive) ───────────────────────────
function showNextApproval() {
  const modal = $("approval-modal");
  const req = approvalQueue[0];
  if (!req) {
    modal.hidden = true;
    return;
  }
  $("approval-title").textContent = req.tool;
  const cred = typeof req.args.credential === "string" ? req.args.credential : "";
  $("approval-reason").textContent = cred
    ? `${req.bot} wants to use your saved credential "${cred}" for this request. SlopBot attaches it; the bot never sees it. (${req.reason})`
    : `${req.bot} wants to run this (${req.reason}).`;
  $("approval-args").textContent = JSON.stringify(req.args, null, 2);
  modal.hidden = false;
  $("approval-allow").focus();
}

async function answer(a: "yes" | "no" | "always") {
  const req = approvalQueue.shift();
  if (!req) return;
  await api.answerApproval(req.id, a);
  showNextApproval();
}

// ── approvals inbox / activity / memory ───────────────
async function refreshApprovalBadge() {
  const n = (await api.listApprovals()).length;
  const badge = $("approvals-badge");
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

async function loadApprovals() {
  const items = await api.listApprovals();
  const box = $("approvals");
  if (!items.length) {
    box.replaceChildren(el("p", "muted", "Nothing waiting on you. When bots run in the background, anything that needs your OK shows up here."));
  } else {
    box.replaceChildren(
      ...items.map((a) => {
        const card = el("div", "card");
        const head = el("div", "card-head");
        head.append(el("span", "tag", a.bot), el("span", "tool-name", a.tool), el("span", "muted", new Date(a.createdAt).toLocaleString()));
        const result = el("div", "muted");
        const actions = el("div", "card-actions");
        const deny = el("button", "danger small", "Deny");
        const ok = el("button", "primary small", "Approve & run");
        const resolve = async (approve: boolean) => {
          deny.disabled = ok.disabled = true;
          try {
            result.textContent = await api.resolveApproval(a.id, approve);
          } catch (e: any) {
            result.textContent = e?.message ?? String(e);
          }
          refreshApprovalBadge();
        };
        deny.addEventListener("click", () => resolve(false));
        ok.addEventListener("click", () => resolve(true));
        actions.append(deny, ok);
        card.append(head, el("p", "muted", a.reason), el("pre", "code", JSON.stringify(a.args, null, 2)), actions, result);
        return card;
      }),
    );
  }
  refreshApprovalBadge();
}

async function loadActivity() {
  const items = await api.activity(200);
  const box = $("activity");
  if (!items.length) return box.replaceChildren(el("p", "muted", "No activity yet."));
  box.replaceChildren(
    ...items.map((i) => {
      const row = el("div", "row");
      row.append(
        el("span", "t", new Date(i.ts).toLocaleString()),
        el("span", "b", i.bot),
        el("span", "k", i.type),
        Object.assign(el("span", "s", i.summary), { title: i.summary }),
      );
      return row;
    }),
  );
}

async function loadMemory() {
  $("memory-desc").textContent = `What ${current} remembers about you. Bots add to this with memory.remember.`;
  const notes = await api.memory(current);
  const box = $("memory");
  if (!notes.length) return box.replaceChildren(el("p", "muted", `${current} doesn't remember anything yet.`));
  box.replaceChildren(
    ...notes.map((n) => {
      const card = el("div", "card");
      card.append(el("div", "", n.text), el("div", "msg-meta", n.id));
      return card;
    }),
  );
}

// ── composer ──────────────────────────────────────────
function autosize() {
  const ta = $<HTMLTextAreaElement>("input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
}

function wire() {
  const input = $<HTMLTextAreaElement>("input");
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || busy.has(current)) return;
    input.value = "";
    autosize();
    send(text);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("composer").requestSubmit();
    }
  });
  input.addEventListener("input", autosize);
  $<HTMLSelectElement>("model").addEventListener("change", (e) => {
    modelChoice.set(current, (e.target as HTMLSelectElement).value);
    $("model-pill").textContent = `model: ${modelChoice.get(current)}`;
  });
  $("new-chat").addEventListener("click", async () => {
    if (busy.has(current)) return;
    await api.reset(current);
    threads.delete(current);
    $("thread").replaceChildren(threadFor(current));
  });
  document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view!)));
  $("refresh-approvals").addEventListener("click", loadApprovals);
  $("refresh-activity").addEventListener("click", loadActivity);
  $("refresh-models").addEventListener("click", () => models_.load());
  $("open-data").addEventListener("click", () => api.openDataDir());
  $("approval-allow").addEventListener("click", () => answer("yes"));
  $("approval-deny").addEventListener("click", () => answer("no"));
  $("approval-always").addEventListener("click", () => answer("always"));
  window.addEventListener("keydown", (e) => {
    if (!$("approval-modal").hidden && e.key === "Escape") answer("no");
  });

  api.onEvent(onEvent);
  api.onApprovalRequest((req) => {
    approvalQueue.push(req);
    director?.approvalRequested();
    if (approvalQueue.length === 1) showNextApproval();
  });
}

document.documentElement.dataset.platform = window.slopbotPlatform ?? "web";

async function main() {
  wire();
  initMascot();
  const info = await api.info();
  $("foot").textContent = `v${info.version} · ${info.dataDir}`;
  homeDir = info.homeDir;
  $("secrets-note").textContent =
    info.secrets === "keychain" ? "Sign-in tokens are kept in your macOS Keychain." : info.secrets === "libsecret" ? "Sign-in tokens are kept in your system keyring." : "";
  refreshConnectorCount();
  bots = await api.listBots();
  api.listModels().then((m) => {
    models = m;
    updateModelPicker();
  });
  if (bots.length) await selectBot(bots[0].name);
  else $("thread").replaceChildren(el("p", "empty", "No bots found. Add a YAML file to the bots/ folder."));
  refreshApprovalBadge();
  $("input").focus();
}

main();
