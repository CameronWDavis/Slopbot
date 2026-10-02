// Electron main process: owns config, bots and Agent instances, and talks to the UI over IPC.
import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBot, loadBots } from "../src/agent/bot.js";
import { Agent, executeApproval } from "../src/agent/runtime.js";
import { loadConfig, type Config } from "../src/config.js";
import { McpManager, type McpServerDef } from "../src/mcp/client.js";
import { Store, newId } from "../src/store/store.js";
import { toolsFor } from "../src/tools/registry.js";
import type { ActivityItem, AgentEvent, ApprovalRequest, BotSummary, QueuedApproval } from "./api.js";

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

function registerIpc() {
  ipcMain.handle("info", () => ({
    dataDir: config.dataDir,
    rootDir: config.rootDir,
    homeDir: os.homedir(),
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
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "SlopBot",
    backgroundColor: "#07040d",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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
  win.on("closed", () => (win = null));
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
  void mcp?.closeAll();
});

app.whenReady().then(() => {
  adoptShellPath();
  const home = resolveHome();
  config = loadConfig(home);
  store = new Store(config.dataDir);
  mcp = new McpManager(config, (url) => shell.openExternal(url));

  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(rendererDir, decodeURIComponent(pathname)));
    if (!file.startsWith(rendererDir + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  registerIpc();
  createWindow();
  if (process.env.SLOPBOT_SMOKE) smokeTest(process.env.SLOPBOT_SMOKE);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * SLOPBOT_SMOKE=<out.png> npm run desktop: sends one real message through IPC → agent runtime,
 * waits for it to finish, prints renderer state, saves a screenshot, and quits. Used for CI/dev checks.
 */
function smokeTest(outPng: string) {
  const w = win!;
  w.webContents.once("did-finish-load", async () => {
    const js = (code: string) => w.webContents.executeJavaScript(code);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    if (process.env.SLOPBOT_SMOKE_BOT) {
      await js(`[...document.querySelectorAll(".bot")].find(b => b.querySelector(".bot-name").textContent.trim() === ${JSON.stringify(process.env.SLOPBOT_SMOKE_BOT)})?.click()`);
      await wait(300);
    }
    const before = await js(`document.getElementById("status-text").textContent`);
    await js(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(process.env.SLOPBOT_SMOKE_MSG ?? "How much did I spend on dining?")}; document.getElementById("composer").requestSubmit(); })()`);
    await wait(400);
    const during = await js(`document.getElementById("status-text").textContent`);
    for (let i = 0; i < 600 && busy.size; i++) await wait(100);
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
    const img = await w.webContents.capturePage();
    fs.writeFileSync(outPng, img.toPNG());
    console.log(JSON.stringify({ home: config.rootDir, before, during, after }, null, 2));
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
