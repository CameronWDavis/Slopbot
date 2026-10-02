// Telegram channel: talk to your bots from your phone while SlopBot runs on your computer.
//
// Lockdown: the bot answers exactly one Telegram account, the one that paired with a one-time
// code from the app, and only in that account's private chat. Everything else (other users,
// groups, wrong codes) is ignored without a reply. The bot token lives in the secret store.
// Uses long polling, so no port is opened and no server is needed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadBot, loadBots } from "../agent/bot.js";
import { Agent, executeApproval, type ApprovalAnswer } from "../agent/runtime.js";
import type { Config } from "../config.js";
import { acquireLock } from "../lock.js";
import type { McpManager } from "../mcp/client.js";
import type { ToolCall } from "../providers/types.js";
import type { SecretStore } from "../secrets.js";
import type { Store } from "../store/store.js";

export const TELEGRAM_TOKEN_KEY = "channel.telegram.token";
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_ATTEMPTS = 5;
const STALE_MS = 15 * 60_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const MAX_TEXT = 3900; // Telegram's limit is 4096

interface State {
  enabled: boolean;
  botId?: number;
  botUsername?: string;
  ownerId?: number;
  ownerChatId?: number;
  ownerName?: string;
  linkedAt?: string;
  defaultBot?: string;
  notifiedApprovals: string[];
}

export interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  botUsername?: string;
  linked: boolean;
  ownerName?: string;
  linkedAt?: string;
  defaultBot?: string;
  pairing?: { code: string; expiresAt: number; link?: string };
  error?: string;
  rejected: number; // messages ignored from strangers since start
}

export const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escape for Telegram HTML and convert the bits of Markdown models use most. */
export function toTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => `\u0000${blocks.push(`<pre>${esc(code.trimEnd())}</pre>`) - 1}\u0000`);
  s = esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

/** Split long text on paragraph / line boundaries. */
export function chunk(text: string, max = MAX_TEXT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export class TelegramChannel {
  private state: State;
  private stateFile: string;
  private pairing?: { code: string; expiresAt: number; attempts: number };
  private abort?: AbortController;
  private lock: { release: () => void } | null = null;
  private running = false;
  private lastError?: string;
  private rejected = 0;
  private offset = 0;
  private agents = new Map<string, Agent>();
  private busy = false;
  private pendingAsks = new Map<string, { resolve: (a: ApprovalAnswer) => void; messageId?: number; text: string; timer: NodeJS.Timeout }>();
  private approvalTimer?: NodeJS.Timeout;
  private currentBot = "";
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private opts: {
      config: Config;
      store: Store;
      secrets: SecretStore;
      mcp?: McpManager;
      apiBase?: string; // tests
      onStatus?: (s: TelegramStatus) => void;
      log?: (msg: string) => void;
      approvalPollMs?: number;
      retryMs?: number;
    },
  ) {
    this.stateFile = path.join(opts.config.dataDir, "channels", "telegram.json");
    try {
      this.state = { notifiedApprovals: [], ...JSON.parse(fs.readFileSync(this.stateFile, "utf8")) };
    } catch {
      this.state = { enabled: false, notifiedApprovals: [] };
    }
    this.currentBot = this.state.defaultBot ?? "";
  }

  set config(c: Config) {
    this.opts.config = c;
    this.agents.clear();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    this.opts.onStatus?.(this.status());
  }

  private get token() {
    return this.opts.secrets.get(TELEGRAM_TOKEN_KEY);
  }

  status(): TelegramStatus {
    const p = this.pairing && Date.now() < this.pairing.expiresAt ? this.pairing : undefined;
    return {
      configured: !!this.token,
      enabled: this.state.enabled,
      running: this.running,
      botUsername: this.state.botUsername,
      linked: !!this.state.ownerId,
      ownerName: this.state.ownerName,
      linkedAt: this.state.linkedAt,
      defaultBot: this.state.defaultBot,
      pairing: p ? { code: p.code, expiresAt: p.expiresAt, link: this.state.botUsername ? `https://t.me/${this.state.botUsername}?start=${p.code}` : undefined } : undefined,
      error: this.lastError,
      rejected: this.rejected,
    };
  }

  // ── Telegram Bot API ──────────────────────────────
  private async api<T = any>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal, token = this.token): Promise<T> {
    if (!token) throw new Error("No Telegram bot token");
    let res: Response;
    try {
      res = await fetch(`${this.opts.apiBase ?? "https://api.telegram.org"}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(40_000),
      });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      const err = new Error("Can't reach Telegram. Check your internet connection; SlopBot will keep trying.");
      (err as any).code = "NETWORK";
      throw err;
    }
    const data: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) {
      const err = new Error(data.error_code === 401 ? "Telegram rejected the bot token (401). Copy it again from @BotFather." : `Telegram ${method}: ${data.description ?? res.status}`);
      (err as any).code = data.error_code;
      throw err;
    }
    return data.result as T;
  }

  /** Send HTML that SlopBot composed (interpolated values must already be escaped). */
  async sendHtml(chatId: number, html: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    try {
      return (await this.api("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...extra })).message_id;
    } catch (e: any) {
      if (e.code !== 400) throw e;
      const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return (await this.api("sendMessage", { chat_id: chatId, text: plain, disable_web_page_preview: true, ...extra })).message_id;
    }
  }

  /** Send a model's Markdown reply, split to fit Telegram, with an optional HTML suffix on the last part. */
  async sendMd(chatId: number, md: string, suffixHtml = ""): Promise<void> {
    const parts = chunk(md);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      try {
        await this.api("sendMessage", { chat_id: chatId, text: toTelegramHtml(parts[i]) + (last ? suffixHtml : ""), parse_mode: "HTML", disable_web_page_preview: true });
      } catch (e: any) {
        if (e.code !== 400) throw e; // formatting problem → plain text
        await this.api("sendMessage", { chat_id: chatId, text: parts[i], disable_web_page_preview: true });
      }
    }
  }

  // ── setup (called from the app) ───────────────────
  /** Validate and store a BotFather token. Linking resets if it's a different bot. */
  async setToken(token: string): Promise<string> {
    token = token.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("That doesn't look like a bot token. It should look like 123456789:ABC-def…");
    const me = await this.api<{ id: number; username: string; is_bot: boolean }>("getMe", {}, undefined, token);
    this.opts.secrets.set(TELEGRAM_TOKEN_KEY, token);
    if (this.state.botId !== me.id) Object.assign(this.state, { ownerId: undefined, ownerChatId: undefined, ownerName: undefined, linkedAt: undefined, notifiedApprovals: [] });
    Object.assign(this.state, { botId: me.id, botUsername: me.username, enabled: true });
    this.save();
    return me.username;
  }

  async removeToken() {
    await this.stop();
    this.opts.secrets.delete(TELEGRAM_TOKEN_KEY);
    this.state = { enabled: false, notifiedApprovals: [] };
    this.pairing = undefined;
    this.save();
  }

  /** New one-time pairing code (replaces any previous one). */
  startPairing(): TelegramStatus["pairing"] {
    this.pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + PAIR_TTL_MS, attempts: 0 };
    this.opts.onStatus?.(this.status());
    return this.status().pairing;
  }

  unlink() {
    Object.assign(this.state, { ownerId: undefined, ownerChatId: undefined, ownerName: undefined, linkedAt: undefined });
    this.agents.clear();
    this.save();
  }

  setDefaultBot(name: string) {
    loadBot(this.opts.config, name); // validate
    this.state.defaultBot = name;
    this.currentBot = name;
    this.save();
  }

  async setEnabled(on: boolean) {
    this.state.enabled = on;
    this.save();
    if (on) await this.start();
    else await this.stop();
  }

  // ── polling ───────────────────────────────────────
  async start(): Promise<boolean> {
    if (this.running || !this.state.enabled || !this.token) return this.running;
    this.lock = acquireLock(this.opts.config.dataDir, "telegram");
    if (!this.lock) {
      this.lastError = "Another SlopBot process (the app or `slopbot daemon`) is already connected to Telegram.";
      this.opts.onStatus?.(this.status());
      return false;
    }
    try {
      await this.api("deleteWebhook", { drop_pending_updates: false });
      await this.api("setMyCommands", {
        commands: [
          { command: "bots", description: "List your bots" },
          { command: "bot", description: "Switch bot: /bot ledger" },
          { command: "new", description: "Start a new conversation" },
          { command: "approvals", description: "Actions waiting for your OK" },
          { command: "help", description: "How to use SlopBot here" },
        ],
      });
      this.lastError = undefined;
    } catch (e: any) {
      this.lastError = e.message;
      this.lock.release();
      this.lock = null;
      // Offline or Telegram hiccup: try again shortly instead of waiting for the user to toggle.
      if (e.code === "NETWORK" || (e.code >= 500 && e.code < 600)) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.start(), this.opts.retryMs ?? 30_000);
        this.retryTimer.unref?.();
      }
      this.opts.onStatus?.(this.status());
      return false;
    }
    this.running = true;
    this.abort = new AbortController();
    this.opts.onStatus?.(this.status());
    void this.loop(this.abort.signal);
    this.approvalTimer = setInterval(() => void this.notifyQueuedApprovals().catch(() => {}), this.opts.approvalPollMs ?? 20_000);
    return true;
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.abort?.abort();
    clearInterval(this.approvalTimer);
    for (const p of this.pendingAsks.values()) {
      clearTimeout(p.timer);
      p.resolve("no");
    }
    this.pendingAsks.clear();
    this.running = false;
    this.lock?.release();
    this.lock = null;
    this.opts.onStatus?.(this.status());
  }

  private async loop(signal: AbortSignal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = await this.api<any[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          // Don't await: an agent run can take minutes and must not block approval button presses.
          void this.handle(u).catch((e) => this.opts.log?.(`telegram: ${e.message}`));
        }
      } catch (e: any) {
        if (signal.aborted) break;
        this.lastError = e.message;
        this.opts.onStatus?.(this.status());
        if (e.code === 401) {
          await this.stop();
          break;
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  // ── lockdown ──────────────────────────────────────
  private isOwner(from: any, chat: any): boolean {
    return !!this.state.ownerId && from?.id === this.state.ownerId && chat?.id === this.state.ownerChatId && chat?.type === "private";
  }

  private reject(reason: string, from: any) {
    this.rejected++;
    this.opts.store.audit({ bot: "telegram", session: "channel", type: "error", error: `ignored Telegram update: ${reason} (user ${from?.id ?? "?"})` });
    this.opts.onStatus?.(this.status());
  }

  /** Pairing: only via an active code, only from a private chat with a real person. */
  private tryPair(msg: any): boolean {
    const m = String(msg.text ?? "").trim().match(/^(?:\/(?:start|link)(?:@\w+)?\s+)?(\d{6})$/);
    if (!m || msg.chat?.type !== "private" || msg.from?.is_bot) return false;
    const p = this.pairing;
    if (!p || Date.now() > p.expiresAt) return false;
    const ok = crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(p.code));
    if (!ok) {
      if (++p.attempts >= PAIR_MAX_ATTEMPTS) this.pairing = undefined; // stop guessing
      return false;
    }
    this.pairing = undefined;
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") + (msg.from.username ? ` (@${msg.from.username})` : "");
    Object.assign(this.state, { ownerId: msg.from.id, ownerChatId: msg.chat.id, ownerName: name, linkedAt: new Date().toISOString() });
    this.save();
    this.opts.store.audit({ bot: "telegram", session: "channel", type: "approval", tool: "telegram.link", linked: name });
    return true;
  }

  // ── updates ───────────────────────────────────────
  private async handle(u: any) {
    if (u.callback_query) return this.onButton(u.callback_query);
    const msg = u.message;
    if (!msg) return;
    if (!this.isOwner(msg.from, msg.chat)) {
      if (!this.state.ownerId && this.tryPair(msg)) {
        await this.sendHtml(msg.chat.id, `🔗 Linked! Only you can talk to SlopBot here now.\n\nYou're chatting with <b>${esc(this.bot())}</b>. Send /bots to see the others.`);
        return;
      }
      return this.reject(msg.chat?.type !== "private" ? "not a private chat" : this.state.ownerId ? "not the linked account" : "not linked / bad code", msg.from);
    }
    const chatId = msg.chat.id;
    if (Date.now() - msg.date * 1000 > STALE_MS) {
      await this.sendHtml(chatId, "⏸ SlopBot was offline when you sent that. Send it again if you still need it.");
      return;
    }
    const text = String(msg.text ?? "").trim();
    if (!text) return void (await this.sendHtml(chatId, "I can only read text messages for now."));
    if (text.startsWith("/")) return this.command(chatId, text);
    await this.chat(chatId, text);
  }

  private bot(): string {
    const bots = loadBots(this.opts.config).map((b) => b.name);
    if (!bots.includes(this.currentBot)) this.currentBot = this.state.defaultBot && bots.includes(this.state.defaultBot) ? this.state.defaultBot : bots[0] ?? "";
    return this.currentBot;
  }

  private async command(chatId: number, text: string) {
    const [cmd, ...args] = text.split(/\s+/);
    const name = cmd.replace(/@\w+$/, "").toLowerCase();
    if (name === "/bots") {
      const list = loadBots(this.opts.config)
        .map((b) => `${b.name === this.bot() ? "▸" : "•"} <b>${esc(b.name)}</b>: ${esc(b.description)}`)
        .join("\n");
      return void (await this.sendHtml(chatId, `${list}\n\nSwitch with /bot name`));
    }
    if (name === "/bot") {
      const target = args[0];
      if (!target) return void (await this.sendHtml(chatId, `You're talking to <b>${esc(this.bot())}</b>. Switch with /bot name`));
      try {
        loadBot(this.opts.config, target);
        this.currentBot = target;
        return void (await this.sendHtml(chatId, `Now talking to <b>${esc(target)}</b>.`));
      } catch (e: any) {
        return void (await this.sendHtml(chatId, esc(e.message)));
      }
    }
    if (name === "/new") {
      this.agents.delete(this.bot());
      return void (await this.sendHtml(chatId, `Fresh conversation with <b>${esc(this.bot())}</b>.`));
    }
    if (name === "/approvals") {
      const pending = this.opts.store.listApprovals().filter((a) => a.status === "pending");
      if (!pending.length) return void (await this.sendHtml(chatId, "Nothing is waiting for your OK."));
      for (const a of pending.slice(0, 10)) await this.sendQueuedApproval(a);
      return;
    }
    return void (await this.sendHtml(
      chatId,
      `Talk to your SlopBot bots from here. You're talking to <b>${esc(this.bot())}</b>.\n\n/bots: list bots\n/bot name: switch bot\n/new: new conversation\n/approvals: actions waiting for your OK\n\nWhen a bot needs your OK, you'll get Approve / Deny buttons.`,
    ));
  }

  private async chat(chatId: number, text: string) {
    if (this.busy) return void (await this.sendHtml(chatId, "⏳ Still working on your last message…"));
    const botName = this.bot();
    if (!botName) return void (await this.sendHtml(chatId, "No bots are set up yet."));
    this.busy = true;
    const typing = setInterval(() => void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4500);
    void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const used = new Set<string>();
    try {
      let agent = this.agents.get(botName);
      if (!agent) {
        agent = new Agent(
          this.opts.config,
          this.opts.store,
          loadBot(this.opts.config, botName),
          "interactive",
          {
            onToolCall: (call) => used.add(call.name),
            approve: (call, d) => this.ask(chatId, botName, call, d.reason),
          },
          this.opts.mcp,
        );
        this.agents.set(botName, agent);
      }
      const res = await agent.send(text);
      const footer = `\n\n<i>${esc(botName)}${used.size ? ` · used ${esc([...used].join(", "))}` : ""}</i>`;
      await this.sendMd(chatId, res.text || "(no reply)", footer);
    } catch (e: any) {
      await this.sendHtml(chatId, `⚠️ ${esc(botName)} hit an error: ${esc(e?.message ?? String(e))}`);
    } finally {
      clearInterval(typing);
      this.busy = false;
    }
  }

  // ── approvals ─────────────────────────────────────
  /** Live approval during a chat: Approve / Deny / Always buttons. Times out to "no". */
  private ask(chatId: number, bot: string, call: ToolCall, reason: string): Promise<ApprovalAnswer> {
    const nonce = crypto.randomBytes(6).toString("hex");
    const cred = typeof call.args.credential === "string" ? `\nUses your saved credential "${call.args.credential}" (the bot never sees it).` : "";
    const text = `⚠️ <b>${esc(bot)}</b> wants to run <code>${esc(call.name)}</code>${esc(cred)}\n<pre>${esc(JSON.stringify(call.args, null, 2).slice(0, 1500))}</pre>`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveAsk(nonce, "no", "⌛ No answer in 10 minutes, so it was denied."), APPROVAL_TIMEOUT_MS);
      this.pendingAsks.set(nonce, {
        resolve: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
        text,
        timer,
      });
      this.api("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `ask:${nonce}:yes` },
              { text: "❌ Deny", callback_data: `ask:${nonce}:no` },
            ],
            [{ text: "Always this session", callback_data: `ask:${nonce}:always` }],
          ],
        },
      })
        .then((m: any) => {
          const p = this.pendingAsks.get(nonce);
          if (p) p.messageId = m.message_id;
        })
        .catch(() => this.resolveAsk(nonce, "no"));
    });
  }

  private resolveAsk(nonce: string, answer: ApprovalAnswer, note?: string) {
    const p = this.pendingAsks.get(nonce);
    if (!p) return false;
    this.pendingAsks.delete(nonce);
    p.resolve(answer);
    const label = note ?? (answer === "no" ? "❌ Denied" : answer === "always" ? "✅ Approved (always this session)" : "✅ Approved");
    if (p.messageId && this.state.ownerChatId) {
      void this.api("editMessageText", { chat_id: this.state.ownerChatId, message_id: p.messageId, text: `${p.text}\n\n${label}`, parse_mode: "HTML" }).catch(() => {});
    }
    return true;
  }

  private async sendQueuedApproval(a: { id: string; bot: string; call: ToolCall; reason: string }) {
    if (!this.state.ownerChatId) return;
    const text = `🕒 <b>${esc(a.bot)}</b> queued an action while running in the background:\n<code>${esc(a.call.name)}</code>\n<pre>${esc(JSON.stringify(a.call.args, null, 2).slice(0, 1500))}</pre>`;
    await this.api("sendMessage", {
      chat_id: this.state.ownerChatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ Approve & run", callback_data: `q:${a.id}:yes` }, { text: "❌ Deny", callback_data: `q:${a.id}:no` }]] },
    });
  }

  /** Background runs queue approvals; tell the owner about new ones. */
  async notifyQueuedApprovals() {
    if (!this.running || !this.state.ownerChatId) return;
    const fresh = this.opts.store.listApprovals().filter((a) => a.status === "pending" && !this.state.notifiedApprovals.includes(a.id));
    for (const a of fresh) {
      await this.sendQueuedApproval(a);
      this.state.notifiedApprovals = [...this.state.notifiedApprovals, a.id].slice(-300);
    }
    if (fresh.length) this.save();
  }

  private async onButton(q: any) {
    if (!this.isOwner(q.from, q.message?.chat)) {
      this.reject("button press from someone else", q.from);
      return;
    }
    const [kind, id, answer] = String(q.data ?? "").split(":");
    let note = "";
    if (kind === "ask") {
      note = this.resolveAsk(id, answer as ApprovalAnswer) ? "" : "That request already expired.";
    } else if (kind === "q") {
      const a = this.opts.store.listApprovals().find((x) => x.id === id);
      if (!a || a.status !== "pending") note = "Already handled.";
      else if (answer === "yes") {
        try {
          const out = await executeApproval(this.opts.config, this.opts.store, loadBot(this.opts.config, a.bot), id, this.opts.mcp);
          await this.sendHtml(q.message.chat.id, `✅ Ran <code>${esc(a.call.name)}</code>:\n${esc(out.slice(0, 1500))}`);
        } catch (e: any) {
          note = e.message;
        }
      } else {
        this.opts.store.updateApproval(id, { status: "denied", resolvedAt: new Date().toISOString() });
        await this.sendHtml(q.message.chat.id, `❌ Denied <code>${esc(a.call.name)}</code>.`);
      }
      void this.api("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
    await this.api("answerCallbackQuery", { callback_query_id: q.id, text: note || undefined }).catch(() => {});
  }

  /** Deliver a scheduled report (schedules with `notify: telegram`). */
  async report(title: string, text: string) {
    if (!this.state.ownerChatId) throw new Error("Telegram isn't linked to your account yet");
    await this.sendMd(this.state.ownerChatId, `📬 **${title}**\n\n${text}`);
  }
}
