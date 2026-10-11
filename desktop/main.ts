// Electron main process: owns config, bots and Agent instances, and talks to the UI over IPC.
import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBot, loadBots } from "../src/agent/bot.js";
import { Agent, executeApproval } from "../src/agent/runtime.js";
import { loadConfig, type Config } from "../src/config.js";
import { McpManager, type McpServerDef } from "../src/mcp/client.js";
import { Ollama, ollamaProviderName, ollamaUrl } from "../src/ollama/ollama.js";
import { ensureOllamaProvider, setBotModel, setDefaultModel, setSearchConfig } from "../src/config-edit.js";
import { openVault } from "../src/agent/runtime.js";
import { KEYED, resolveSearch, searchKeyName, webSearch, type SearchProvider } from "../src/search/search.js";
import type { VaultEntry } from "../src/vault/vault.js";
import { TelegramChannel } from "../src/channels/telegram.js";
import { acquireLock } from "../src/lock.js";
import { startDaemon } from "../src/scheduler/scheduler.js";
import { openSecretStore } from "../src/secrets.js";
import { Store, newId } from "../src/store/store.js";
import { registerTools, toolsFor } from "../src/tools/registry.js";
import { makeBrowserTools } from "../src/shopping/browser-tools.js";
import { formatMoney } from "../src/shopping/money.js";
import { checkoutModel, describeDeal, ShoppingService } from "../src/shopping/service.js";
import { SOURCE_INFO, maskSecret, type SourceId } from "../src/shopping/sources.js";
import { AUTO_BUY_ENABLED, type Deal, type ShoppingSettings, type WatchInput } from "../src/shopping/state.js";
import { esc } from "../src/channels/telegram.js";
import { ElectronShopBrowser } from "./shopping-browser.js";
import { addSkill, assign, getSkill, listSkills, removeSkill, skillFiles, skillsDir, writeSkill } from "../src/skills/skills.js";
import type { ActivityItem, AgentEvent, ApprovalRequest, BotSummary, QueuedApproval, SkillInfo } from "./api.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const rendererDir = path.join(__dirname, "renderer");

/**
 * Where config, bots and data live. Dev: the project folder. Packaged: the per-user app data dir,
 * seeded on first launch with the bundled sample bots and example config.
 */
function resolveHome(): string {
  if (process.env.SLOPBOT_HOME) return path.resolve(process.env.SLOPBOT_HOME);
  if (!app.isPackaged) return path.resolve(__dirname, "..");
  const home = path.join(app.getPath("userData"), "home");
  if (!fs.existsSync(path.join(home, "bots"))) {
    const seed = path.join(process.resourcesPath, "seed");
    fs.mkdirSync(home, { recursive: true });
    fs.cpSync(path.join(seed, "bots"), path.join(home, "bots"), { recursive: true });
    fs.cpSync(path.join(seed, "examples"), path.join(home, "examples"), { recursive: true });
    fs.copyFileSync(path.join(seed, "slopbot.config.example.yaml"), path.join(home, "slopbot.config.example.yaml"));
    fs.copyFileSync(path.join(seed, "slopbot.config.example.yaml"), path.join(home, "slopbot.config.yaml"));
  }
  return home;
}

let config: Config;
let store: Store;
let mcp: McpManager;
let ollama: Ollama;
let telegram: TelegramChannel;
let shopping: ShoppingService;
let shopBrowser: ElectronShopBrowser;
let home: string;
const pulls = new Map<string, AbortController>();
let win: BrowserWindow | null = null;
const agents = new Map<string, { agent: Agent; model?: string }>();
const busy = new Set<string>();
const pendingAnswers = new Map<string, (a: "yes" | "no" | "always") => void>();

const emit = (e: AgentEvent) => win?.webContents.send("agent:event", e);

function agentFor(botName: string, model?: string): Agent {
  const existing = agents.get(botName);
  if (existing && existing.model === model) return existing.agent;
  const bot = loadBot(config, botName);
  if (model) bot.model = model;
  const agent = new Agent(config, store, bot, "interactive", {
    onText: (text) => emit({ type: "text", bot: botName, text }),
    onToolCall: (call, d) =>
      emit({ type: "tool.call", bot: botName, id: call.id, name: call.name, args: call.args, decision: d.action, reason: d.reason }),
    onToolResult: (call, result, ok) =>
      emit({ type: "tool.result", bot: botName, id: call.id, name: call.name, ok, result: result.slice(0, 4000) }),
    approve: (call, d) =>
      new Promise((resolve) => {
        const req: ApprovalRequest = { id: newId("ask_"), bot: botName, tool: call.name, args: call.args, reason: d.reason };
        pendingAnswers.set(req.id, resolve);
        win?.webContents.send("approval:request", req);
      }),
  }, mcp);
  agents.set(botName, { agent, model });
  return agent;
}

function summarize(e: Record<string, any>): string {
  switch (e.type) {
    case "run.start":
      return `${e.mode} run on ${e.model}: ${String(e.input ?? "").slice(0, 120)}`;
    case "run.end":
      return `finished in ${e.steps} steps${e.pendingApprovals?.length ? `, ${e.pendingApprovals.length} pending` : ""}`;
    case "tool":
      return `${e.tool} → ${e.decision?.action ?? "?"}${e.ok === false ? " (failed)" : ""}`;
    case "approval":
      return `${e.tool} ${e.answer ?? (e.queued ? `queued ${e.queued}` : e.denied ? "denied" : "")}`;
    case "model":
      return e.toolCalls?.length ? `model called ${e.toolCalls.join(", ")}` : `model replied`;
    case "error":
      return String(e.error);
    default:
      return "";
  }
}

/** Config plus where the app's built-in (public, read-only) skills are. */
function loadAppConfig() {
  const c = loadConfig(home);
  c.bundledSkillsDir = app.isPackaged ? path.join(process.resourcesPath, "seed", "skills") : path.join(path.resolve(__dirname, ".."), "skills");
  return c;
}

function showShopping() {
  if (!win || win.isDestroyed()) createWindow();
  win!.show();
  win!.focus();
  win!.webContents.send("shopping:show");
}

const timeOf = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/** The Telegram alert for a deal waiting for Buy: exact item, seller, quantity, price and cap. */
function dealAlert(deal: Deal, reconfirm: boolean) {
  const d = describeDeal(deal);
  const m = checkoutModel(config, shopping.state.settings().bot);
  const lines = [
    reconfirm ? `⚠️ <b>Changed: confirm again</b> · ${esc(deal.watchName)}` : `🛒 <b>Deal</b> · ${esc(deal.watchName)}`,
    `<b>${esc(d.item)}</b>`,
    `Seller: ${esc(d.seller)} · Store: ${esc(d.store)}`,
    `Quantity: 1 · Price: <b>${esc(d.price)}</b> (${esc(d.currency)})`,
    `Max total with tax &amp; shipping: <b>${esc(d.cap)}</b>`,
    deal.note ? `<i>${esc(deal.note)}</i>` : "",
    `Seen on: ${esc(deal.sources.join(", "))}`,
    `Buy button valid until ${esc(timeOf(d.expires))}.`,
    m.local ? "" : `<i>Checkout uses ${esc(m.model)}, a cloud model: the cart and checkout summaries it reads (no names, addresses or card details) are sent to that provider.</i>`,
  ].filter(Boolean);
  const buttons = [
    [
      { text: `🛒 Buy (max ${d.cap})`, data: `deal:${deal.id}:buy:${deal.approval?.nonce}` },
      { text: "Skip", data: `deal:${deal.id}:skip` },
    ],
    [{ text: "Open deal ↗", url: d.url }],
  ];
  return { html: lines.join("\n"), buttons };
}

/** Deal watching runs while the app is running; buying uses the shopping browser. */
function setUpShopping() {
  shopBrowser = new ElectronShopBrowser(path.join(rendererDir, "assets", "branding", "icon-256.png"));
  const changed = () => win?.webContents.send("shopping:changed");
  const notify = (title: string, body: string) => {
    const n = new Notification({ title, body });
    n.on("click", showShopping);
    n.show();
  };
  shopping = new ShoppingService(
    config,
    store,
    {
      onChange: changed,
      readWithBrowser: (url, currency) => shopBrowser.readProduct(url, currency),
      getBrowser: () => shopBrowser,
      beginExecution: (x) => shopBrowser.setExecution(x),
      endExecution: () => shopBrowser.setExecution(undefined),
      secrets: openSecretStore(config.dataDir),
      log: (m) => console.log(m),
      onDeal: (deal, _watch, { reconfirm }) => {
        notify(reconfirm ? `Changed: ${deal.watchName}` : `Deal: ${deal.watchName}`, `${deal.listing.title} · ${formatMoney(deal.listing.price)} · max ${formatMoney(deal.cap)}`);
        const a = dealAlert(deal, !!reconfirm);
        void telegram.notify(a.html, a.buttons).catch(() => {});
        changed();
      },
      onUpdate: (deal) => {
        const titles: Record<string, string> = { confirmed: "✅ Order confirmed", uncertain: "⚠️ Check your account", paused: "⏸ Purchase needs you", failed: "Purchase stopped", expired: "Deal expired" };
        const title = titles[deal.status] ?? `Deal ${deal.status}`;
        notify(title, `${deal.listing.title}\n${(deal.note ?? "").slice(0, 160)}`);
        const buttons =
          deal.status === "paused"
            ? [[{ text: "▶ Resume", data: `deal:${deal.id}:resume` }, { text: "Cancel", data: `deal:${deal.id}:cancel` }]]
            : deal.status === "uncertain"
              ? [[{ text: "It was ordered", data: `deal:${deal.id}:ordered` }, { text: "Not ordered", data: `deal:${deal.id}:notordered` }]]
              : deal.status === "expired"
                ? [[{ text: "Check again", data: `deal:${deal.id}:recheck` }]]
                : [];
        void telegram.notify(`<b>${esc(title)}</b>\n${esc(deal.listing.title)}\n${esc(deal.note ?? "")}`, buttons).catch(() => {});
      },
    },
    mcp,
  );
  registerTools(makeBrowserTools(() => shopBrowser, () => shopping.execution));
  shopping.start();
}

/** Telegram button presses for deals: deal:<id>:<action>[:<nonce>]. */
async function onDealButton(id: string, action: string, nonce?: string): Promise<string> {
  const later = (p: Promise<unknown>) => void p.catch((e) => telegram.notify(`⚠️ ${esc(e.message)}`).catch(() => {}));
  switch (action) {
    case "buy": {
      const d = shopping.state.deal(id);
      if (!d || d.status !== "pending") return `That deal is ${d?.status ?? "gone"}.`;
      if (!nonce || d.approval?.nonce !== nonce) return "That Buy button is out of date.";
      later(shopping.approve(id, nonce));
      return "Buying… I'll message you with the result.";
    }
    case "skip":
      shopping.skip(id);
      return "Skipped";
    case "resume":
      later(shopping.resume(id));
      return "Resuming…";
    case "cancel":
      shopping.cancel(id);
      return "Cancelled";
    case "ordered":
    case "notordered":
      shopping.resolveUncertain(id, action === "ordered");
      return "Thanks, noted.";
    case "recheck":
      later(shopping.recheck(id));
      return "Checking the price again…";
  }
  return "Unknown button";
}

function registerIpc() {
  ipcMain.handle("info", () => ({
    dataDir: config.dataDir,
    rootDir: config.rootDir,
    homeDir: os.homedir(),
    secrets: openSecretStore(config.dataDir).kind,
    defaultModel: config.defaultModel ?? "",
    version: app.getVersion(),
  }));

  ipcMain.handle("bots:list", (): BotSummary[] =>
    loadBots(config).map((b) => ({
      name: b.name,
      description: b.description,
      model: b.model ?? config.defaultModel ?? "",
      tools: toolsFor(b.tools).map((t) => t.name),
      schedules: b.schedules.map(({ name, cron, task }) => ({ name, cron, task })),
    })),
  );

  ipcMain.handle("models:list", async () => {
    const models = new Set<string>();
    if (config.defaultModel) models.add(config.defaultModel);
    for (const b of loadBots(config)) if (b.model) models.add(b.model);
    // Ask each OpenAI-compatible provider that's usable (local, or has a key) what it serves.
    await Promise.all(
      Object.entries(config.providers).map(async ([name, p]) => {
        if (p.type !== "openai" || !p.baseUrl) return;
        const local = /localhost|127\.0\.0\.1/.test(p.baseUrl);
        if (!local && !p.apiKey) return;
        try {
          const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/models`, {
            headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
            signal: AbortSignal.timeout(1500),
          });
          const data: any = await res.json();
          for (const m of (data.data ?? []).slice(0, 50)) models.add(`${name}/${m.id}`);
        } catch {
          /* provider not running */
        }
      }),
    );
    return [...models];
  });

  ipcMain.handle("chat:send", async (_e, botName: string, text: string, model?: string) => {
    if (busy.has(botName)) throw new Error(`${botName} is still working on the last message`);
    busy.add(botName);
    emit({ type: "run.start", bot: botName });
    try {
      const res = await agentFor(botName, model || undefined).send(text);
      emit({
        type: "run.end",
        bot: botName,
        text: res.text,
        steps: res.steps,
        tokens: res.usage.inputTokens + res.usage.outputTokens,
        pending: res.pendingApprovals,
      });
    } catch (e: any) {
      emit({ type: "run.error", bot: botName, error: e?.message ?? String(e) });
    } finally {
      busy.delete(botName);
    }
  });

  ipcMain.handle("chat:reset", (_e, botName: string) => {
    if (!busy.has(botName)) agents.delete(botName);
  });

  ipcMain.handle("approval:answer", (_e, id: string, answer: "yes" | "no" | "always") => {
    pendingAnswers.get(id)?.(answer);
    pendingAnswers.delete(id);
  });

  ipcMain.handle("approvals:list", (): QueuedApproval[] =>
    store
      .listApprovals()
      .filter((a) => a.status === "pending")
      .map((a) => ({ id: a.id, bot: a.bot, tool: a.call.name, args: a.call.args, reason: a.reason, createdAt: a.createdAt })),
  );

  ipcMain.handle("approvals:resolve", async (_e, id: string, approve: boolean) => {
    const a = store.listApprovals().find((x) => x.id === id);
    if (!a) throw new Error(`No approval ${id}`);
    if (approve) return executeApproval(config, store, loadBot(config, a.bot), id, mcp);
    store.updateApproval(id, { status: "denied", resolvedAt: new Date().toISOString() });
    store.audit({ bot: a.bot, session: a.session, type: "approval", tool: a.call.name, denied: id });
    return "Denied.";
  });

  ipcMain.handle("activity", (_e, limit = 100): ActivityItem[] =>
    store
      .readAudit({ limit })
      .reverse()
      .map((e: any) => ({ ts: e.ts, bot: e.bot, type: e.type, summary: summarize(e) })),
  );

  ipcMain.handle("memory", (_e, botName: string) => store.readMemory(botName).map(({ id, text }) => ({ id, text })));

  ipcMain.handle("open:data", () => shell.openPath(config.dataDir));

  // ── Ollama (local models) ──────────────────────────
  /** Re-read config after edits so new defaults/models apply to the next message. */
  const reloadConfig = () => {
    config = loadAppConfig();
    ollama.baseUrl = ollamaUrl(config);
    telegram.config = config;
    for (const name of agents.keys()) if (!busy.has(name)) agents.delete(name);
  };
  // ── Vault (bots use these; the UI and the model never get secrets back) ──
  // Skills (SKILL.md folders in <home>/skills)
  ipcMain.handle("skills:list", (): SkillInfo[] => {
    const bots = loadBots(config);
    return listSkills(config).map((s) => ({
      name: s.name,
      description: s.description,
      bots: s.bots,
      yamlBots: bots.filter((b) => b.skills?.includes(s.name) || b.skills?.includes("*")).map((b) => b.name),
      bundled: s.bundled,
      enabled: s.enabled,
      license: s.license,
      error: s.error,
      files: s.error ? 0 : skillFiles(s.dir).length,
    }));
  });
  ipcMain.handle("skills:get", (_e, name: string) => {
    const s = getSkill(config, name);
    return { name, description: String(s.meta.description ?? ""), instructions: s.body, files: s.files };
  });
  ipcMain.handle("skills:save", (_e, input: { name: string; description: string; instructions: string; bots: string[]; previousName?: string }) => writeSkill(config, input));
  ipcMain.handle("skills:import", async (_e, bots: string[]) => {
    const r = await dialog.showOpenDialog(win!, {
      title: "Add a skill",
      message: "Choose a skill folder (or its SKILL.md)",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "SKILL.md", extensions: ["md"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return addSkill(config, r.filePaths[0], bots);
  });
  ipcMain.handle("skills:assign", (_e, name: string, bots: string[], enabled: boolean) => assign(config, name, bots, enabled));
  ipcMain.handle("skills:remove", (_e, name: string) => removeSkill(config, name));
  ipcMain.handle("skills:reveal", (_e, name?: string) => {
    // Only ever a skill folder SlopBot knows about (never a path built from the name).
    if (name !== undefined) {
      const s = listSkills(config).find((x) => x.name === name);
      if (!s) throw new Error(`No skill "${name}"`);
      return shell.openPath(s.dir);
    }
    fs.mkdirSync(skillsDir(config), { recursive: true, mode: 0o700 });
    return shell.openPath(skillsDir(config));
  });

  // Shopping: deal watches and purchases
  const shoppingSnapshot = () => {
    const s = shopping.state.read();
    return {
      watches: s.watches.map(({ seen, sinceId, ...w }) => w),
      deals: s.deals.slice(-100).reverse(),
      settings: { extraAllowancePct: s.settings.extraAllowancePct, approvalMinutes: s.settings.approvalMinutes, savedFeeds: s.settings.savedFeeds, renderService: s.settings.renderService, xMonthlyLimit: s.settings.xMonthlyLimit, xUsage: s.settings.xUsage },
      model: checkoutModel(config, s.settings.bot),
      autoBuy: AUTO_BUY_ENABLED,
      buying: !!shopping.execution,
    };
  };
  ipcMain.handle("shopping:state", shoppingSnapshot);
  ipcMain.handle("shopping:saveWatch", (_e, input: WatchInput) => {
    const w = shopping.state.saveWatch(input);
    void shopping.check(w.id); // first check right away
    return w;
  });
  ipcMain.handle("shopping:removeWatch", (_e, id: string) => shopping.state.removeWatch(id));
  ipcMain.handle("shopping:setEnabled", (_e, id: string, on: boolean) => shopping.state.patchWatch(id, { enabled: on, nextCheckAt: undefined, failures: 0 }));
  ipcMain.handle("shopping:check", async (_e, id: string) => {
    const r = await shopping.check(id);
    return { ok: r.ok, summary: r.summary, hint: r.hint };
  });
  ipcMain.handle("shopping:buy", (_e, id: string, nonce: string) => {
    const d = shopping.state.deal(id);
    if (!d || d.status !== "pending" || d.approval?.nonce !== nonce) throw new Error("That deal changed or expired. Refresh and check it again.");
    void shopping.approve(id, nonce).catch(() => {}); // the result arrives via shopping:changed + a notification
  });
  ipcMain.handle("shopping:skip", (_e, id: string) => void shopping.skip(id));
  ipcMain.handle("shopping:recheck", async (_e, id: string) => void (await shopping.recheck(id)));
  ipcMain.handle("shopping:resume", (_e, id: string) => void shopping.resume(id).catch(() => {}));
  ipcMain.handle("shopping:cancel", (_e, id: string) => void shopping.cancel(id));
  ipcMain.handle("shopping:resolve", (_e, id: string, ordered: boolean) => void shopping.resolveUncertain(id, ordered));
  ipcMain.handle("shopping:saveSettings", (_e, patch: Partial<ShoppingSettings>) => {
    const allowed: (keyof ShoppingSettings)[] = ["extraAllowancePct", "approvalMinutes", "savedFeeds", "renderService", "xMonthlyLimit"];
    shopping.state.saveSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof ShoppingSettings))));
    return shoppingSnapshot().settings;
  });
  ipcMain.handle("shopping:openBrowser", (_e, url?: string) => {
    if (url && !/^https?:\/\//.test(url)) throw new Error("Only web addresses");
    shopBrowser.show(url);
  });
  ipcMain.handle("shopping:clearHistory", () => shopping.state.clearHistory());
  ipcMain.handle("shopping:clearSignIns", () => shopBrowser.clearSignIns());
  // Deal sources: keys live in the OS credential store; the UI only ever sees a masked tail.
  ipcMain.handle("sources:list", () =>
    (Object.keys(SOURCE_INFO) as SourceId[]).map((id) => {
      const key = shopping.credentials.get(id);
      return { id, ...SOURCE_INFO[id], configured: !!key, masked: maskSecret(key), lastTest: shopping.state.settings().sourceTests[id] };
    }),
  );
  ipcMain.handle("sources:save", (_e, id: SourceId, key: string) => {
    if (!(id in SOURCE_INFO)) throw new Error("Unknown source");
    shopping.credentials.set(id, key);
    return shopping.testSource(id);
  });
  ipcMain.handle("sources:remove", (_e, id: SourceId) => {
    if (!(id in SOURCE_INFO)) throw new Error("Unknown source");
    shopping.credentials.remove(id);
    shopping.state.update((s) => void delete s.settings.sourceTests[id]);
  });
  ipcMain.handle("sources:test", (_e, id: SourceId) => {
    if (!(id in SOURCE_INFO)) throw new Error("Unknown source");
    return shopping.testSource(id);
  });

  ipcMain.handle("vault:list", () => openVault(config).list());
  ipcMain.handle("vault:save", (_e, input: Partial<VaultEntry> & { name: string; kind: VaultEntry["kind"] }) => {
    const saved = openVault(config).upsert(input);
    return saved;
  });
  ipcMain.handle("vault:remove", (_e, id: string) => openVault(config).remove(id));

  // ── Web search ─────────────────────────────────────
  ipcMain.handle("search:get", () => {
    const secrets = openSecretStore(config.dataDir);
    let active = "";
    let problem = "";
    try {
      active = resolveSearch(config.search, secrets).provider;
    } catch (e: any) {
      problem = e.message;
    }
    return {
      provider: config.search?.provider ?? "auto",
      searxngUrl: config.search?.searxngUrl ?? "",
      keys: Object.fromEntries(KEYED.map((p) => [p, !!secrets.get(searchKeyName(p))])),
      active,
      problem,
    };
  });
  ipcMain.handle("search:save", (_e, s: { provider: SearchProvider; searxngUrl?: string; key?: { provider: SearchProvider; value: string } }) => {
    const secrets = openSecretStore(config.dataDir);
    if (s.key?.value) secrets.set(searchKeyName(s.key.provider), s.key.value.trim());
    setSearchConfig(config.rootDir, { provider: s.provider, searxngUrl: s.searxngUrl?.trim() || undefined });
    reloadConfig();
  });
  ipcMain.handle("search:forgetKey", (_e, provider: SearchProvider) => {
    openSecretStore(config.dataDir).delete(searchKeyName(provider));
  });
  ipcMain.handle("search:test", async (_e, query: string) => webSearch(query, { config: config.search, secrets: openSecretStore(config.dataDir), max: 5 }));

  // ── Telegram ───────────────────────────────────────
  ipcMain.handle("telegram:status", () => telegram.status());
  ipcMain.handle("telegram:setToken", async (_e, token: string) => {
    const name = await telegram.setToken(token);
    await telegram.start();
    return name;
  });
  ipcMain.handle("telegram:pair", () => telegram.startPairing());
  ipcMain.handle("telegram:unlink", () => telegram.unlink());
  ipcMain.handle("telegram:setDefaultBot", (_e, bot: string) => telegram.setDefaultBot(bot));
  ipcMain.handle("telegram:setEnabled", (_e, on: boolean) => telegram.setEnabled(on));
  ipcMain.handle("telegram:removeToken", () => telegram.removeToken());

  ipcMain.handle("ollama:status", async () => {
    const version = await ollama.version();
    const install = Ollama.detect();
    return {
      running: !!version,
      version,
      installed: !!(install.binary || install.app),
      baseUrl: ollama.baseUrl,
      ramBytes: os.totalmem(),
      provider: ollamaProviderName(config),
      defaultModel: config.defaultModel ?? "",
      bots: loadBots(config).map((b) => ({ name: b.name, model: b.model ?? "" })),
      models: version ? await ollama.list().catch(() => []) : [],
      pulling: [...pulls.keys()],
    };
  });
  ipcMain.handle("ollama:start", () => ollama.start());
  ipcMain.handle("ollama:stop", () => ollama.stop());
  ipcMain.handle("ollama:download", () => shell.openExternal("https://ollama.com/download"));
  ipcMain.handle("ollama:pull", async (_e, model: string) => {
    if (pulls.has(model)) return;
    const ac = new AbortController();
    pulls.set(model, ac);
    try {
      await ollama.pull(model, (p) => win?.webContents.send("ollama:progress", p), ac.signal);
    } catch (e: any) {
      const cancelled = ac.signal.aborted;
      win?.webContents.send("ollama:progress", { model, status: cancelled ? "cancelled" : "error", completed: 0, total: 0, error: cancelled ? "Cancelled" : e?.message ?? String(e) });
      if (!cancelled) throw e;
    } finally {
      pulls.delete(model);
    }
  });
  ipcMain.handle("ollama:cancel", (_e, model: string) => pulls.get(model)?.abort());
  ipcMain.handle("ollama:delete", (_e, model: string) => ollama.delete(model));
  ipcMain.handle("ollama:unload", (_e, model: string) => ollama.unload(model));
  ipcMain.handle("ollama:setDefault", (_e, model: string) => {
    const provider = ensureOllamaProvider(config.rootDir, `${ollama.baseUrl}/v1`);
    setDefaultModel(config.rootDir, `${provider}/${model}`);
    reloadConfig();
  });
  ipcMain.handle("ollama:useForBot", (_e, botName: string, model: string | null) => {
    const provider = ensureOllamaProvider(config.rootDir, `${ollama.baseUrl}/v1`);
    setBotModel(loadBot(config, botName).file, model ? `${provider}/${model}` : null);
    reloadConfig();
  });

  // ── MCP connectors ─────────────────────────────────
  // Idle conversations are dropped when servers change so bots pick up the new tools.
  const refreshAgents = () => {
    for (const name of agents.keys()) if (!busy.has(name)) agents.delete(name);
  };
  ipcMain.handle("mcp:list", () => mcp.status());
  ipcMain.handle("mcp:connect", async (_e, name: string) => {
    await mcp.disconnect(name);
    try {
      await mcp.connect(name);
    } catch {
      /* error is reported in status */
    }
    return mcp.status().find((s) => s.name === name);
  });
  ipcMain.handle("mcp:test", (_e, name: string, def: McpServerDef) => mcp.test(name, def));
  ipcMain.handle("mcp:save", async (_e, name: string, def: McpServerDef, previousName?: string) => {
    await mcp.saveServer(name, def, previousName);
    refreshAgents();
  });
  ipcMain.handle("mcp:remove", async (_e, name: string) => {
    await mcp.removeServer(name);
    refreshAgents();
  });
  ipcMain.handle("mcp:signin", async (_e, name: string) => {
    try {
      await mcp.signIn(name);
    } finally {
      // Bring SlopBot back to the front after the browser round-trip.
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        app.focus({ steal: true });
      }
    }
    refreshAgents();
    return mcp.status().find((s) => s.name === name);
  });
  ipcMain.handle("mcp:signout", async (_e, name: string) => {
    await mcp.signOut(name);
    refreshAgents();
  });
  ipcMain.handle("mcp:import", async (_e, json: string, bots: string[]) => {
    const names = await mcp.importJson(json, bots);
    refreshAgents();
    return names;
  });
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(rendererDir, "assets", "branding", "icon-256.png"), // Windows/Linux window + taskbar
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "SlopBot",
    backgroundColor: "#f5f1e8", // matches the canvas, so there's no flash of the old theme
    // macOS: traffic lights over the charcoal titlebar. Windows: native caption buttons drawn
    // over it in matching colors. Linux keeps its regular frame.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 20, y: 24 } }
      : process.platform === "win32"
        ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#262822", symbolColor: "#f5f1e8", height: 64 } }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Stay inside the app: no navigation, external links open in the real browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL("app://slopbot/index.html");
  win.on("closed", () => {
    win = null;
    // The shopping browser hides instead of closing, so "all windows closed" never fires while it
    // exists: on Windows/Linux closing the main window quits, as before.
    if (process.platform !== "darwin") app.quit();
  });
}

/**
 * Apps launched from Finder/Dock get a minimal PATH, so `npx`, `uvx`, `docker` etc. used by MCP
 * servers wouldn't be found. Borrow the PATH from the user's login shell.
 */
function adoptShellPath() {
  if (process.platform === "win32") return;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", 'printf "__SLOPBOT_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 4000 });
    const p = out.split("__SLOPBOT_PATH__").pop()?.trim();
    if (p) process.env.PATH = [...new Set([...p.split(":"), ...(process.env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  } catch {
    /* keep the existing PATH */
  }
}

app.on("before-quit", () => {
  shopping?.stop();
  shopBrowser?.close();
  void mcp?.closeAll();
  void telegram?.stop();
  for (const ac of pulls.values()) ac.abort();
});

app.whenReady().then(() => {
  adoptShellPath();
  // In development the Dock shows Electron's icon; packaged builds use icon.icns from electron-builder.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, "branding", "icon-mac-1024.png"));
  home = resolveHome();
  config = loadAppConfig();
  ollama = new Ollama(ollamaUrl(config));
  store = new Store(config.dataDir, { retentionDays: config.retentionDays });
  mcp = new McpManager(config, (url) => (/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? shell.openExternal(url) : undefined));

  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(rendererDir, decodeURIComponent(pathname)));
    if (!file.startsWith(rendererDir + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  telegram = new TelegramChannel({
    config,
    store,
    mcp,
    secrets: openSecretStore(config.dataDir),
    apiBase: process.env.SLOPBOT_TELEGRAM_API, // dev/testing only; defaults to api.telegram.org
    onStatus: (s) => win?.webContents.send("telegram:status", s),
    log: (m) => console.log(m),
    onAction: async (kind, id, answer, extra) => (kind === "deal" ? onDealButton(id, answer, extra) : "Unknown button"),
  });
  setUpShopping();
  registerIpc();
  createWindow();
  // Always-on while the app is open: Telegram, plus the bots' schedules (unless `slopbot daemon`
  // already runs them; the lock keeps it to one process).
  void telegram.start();
  if (acquireLock(config.dataDir, "scheduler")) startDaemon(config, store, mcp, { telegram: (t, x) => telegram.report(t, x) });
  if (process.env.SLOPBOT_SMOKE) smokeTest(process.env.SLOPBOT_SMOKE);
  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

/**
 * SLOPBOT_SMOKE=<out.png> npm run desktop: sends one real message through IPC → agent runtime,
 * waits for it to finish, prints renderer state, saves a screenshot, and quits. Used for CI/dev checks.
 */
function smokeTest(outPng: string) {
  const w = win!;
  const size = process.env.SLOPBOT_SMOKE_SIZE?.match(/^(\d+)x(\d+)$/);
  if (size) w.setContentSize(Number(size[1]), Number(size[2]));
  w.webContents.once("did-finish-load", async () => {
    const js = (code: string) => w.webContents.executeJavaScript(code);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    if (process.env.SLOPBOT_SMOKE_BOT) {
      await js(`[...document.querySelectorAll(".bot")].find(b => b.querySelector(".bot-name").textContent.trim() === ${JSON.stringify(process.env.SLOPBOT_SMOKE_BOT)})?.click()`);
      await wait(300);
    }
    const before = await js(`document.getElementById("status-text").textContent`);
    if (process.env.SLOPBOT_SMOKE_MSG !== "-")
      await js(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(process.env.SLOPBOT_SMOKE_MSG ?? "How much did I spend on dining?")}; document.getElementById("composer").requestSubmit(); })()`);
    await wait(400);
    const during = await js(`document.getElementById("status-text").textContent`);
    let modalShot = false;
    for (let i = 0; i < 600 && busy.size; i++) {
      await wait(100);
      // Dev-only: answer approval prompts, optionally capturing the first one.
      if (process.env.SLOPBOT_SMOKE_APPROVE && (await js(`!document.getElementById("approval-modal").hidden`))) {
        if (process.env.SLOPBOT_SMOKE_MODAL && !modalShot) {
          await wait(300);
          fs.writeFileSync(process.env.SLOPBOT_SMOKE_MODAL, (await w.webContents.capturePage()).toPNG());
          modalShot = true;
        }
        await js(`document.getElementById("approval-${process.env.SLOPBOT_SMOKE_APPROVE === "no" ? "deny" : "allow"}").click()`);
      }
    }
    await wait(900);
    const after = await js(`({ status: document.getElementById("status-text").textContent, messages: [...document.querySelectorAll(".msg, .tool")].map(n => n.className + ": " + n.textContent.slice(0, 160)) })`);
    if (process.env.SLOPBOT_SMOKE_VIEW) {
      await js(`document.querySelector('[data-view=${process.env.SLOPBOT_SMOKE_VIEW}]').click()`);
      for (let i = 0; i < 100; i++) {
        await wait(200);
        if (!(await js(`!!document.querySelector(".connector.connecting")`))) break;
      }
      await wait(500);
      await js(`document.querySelectorAll(".tool-list").forEach((d) => (d.open = true))`);
      await wait(200);
    }
    // Dev-only: extra UI steps for the smoke run (e.g. click Download), then let it settle.
    if (process.env.SLOPBOT_SMOKE_JS) {
      console.log("smoke js →", JSON.stringify(await js(process.env.SLOPBOT_SMOKE_JS)));
      await wait(Number(process.env.SLOPBOT_SMOKE_WAIT ?? 1500));
    }
    const img = await w.webContents.capturePage();
    fs.writeFileSync(outPng, img.toPNG());
    console.log(JSON.stringify({ home: config.rootDir, before, during, after }, null, 2));
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
