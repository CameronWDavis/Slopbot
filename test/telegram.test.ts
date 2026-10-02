// Telegram channel against a fake Bot API: pairing, lockdown, chat, approvals.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chunk, TelegramChannel, toTelegramHtml } from "../src/channels/telegram.js";
import { loadConfig, type Config } from "../src/config.js";
import { FileSecrets } from "../src/secrets.js";
import { Store } from "../src/store/store.js";

const TOKEN = "123456789:AAH-test_token_abcdefghijklmnopqrstuvwxyz";
const OWNER = { id: 4242, first_name: "Cam", username: "cam" };
const STRANGER = { id: 6666, first_name: "Mallory" };

// ── fake Telegram ───────────────────────────────────
const sent: any[] = [];
const calls: { method: string; body: any }[] = [];
let queue: any[] = [];
let nextUpdate = 1;
let nextMsg = 100;
let tg: http.Server;
let tgBase = "";

function push(update: any) {
  queue.push({ update_id: nextUpdate++, ...update });
}
const now = () => Math.floor(Date.now() / 1000);
const text = (from: any, t: string, chatType = "private", chatId = from.id) => push({ message: { message_id: nextMsg++, from, chat: { id: chatId, type: chatType }, date: now(), text: t } });
const press = (from: any, data: string, messageId: number, chatId = from.id) =>
  push({ callback_query: { id: String(nextMsg++), from, data, message: { message_id: messageId, chat: { id: chatId, type: "private" } } } });

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

// ── fake model ──────────────────────────────────────
let script: Array<{ tools?: Array<[string, object]>; text?: string }> = [];
let llm: http.Server;
let llmBase = "";

before(async () => {
  tg = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", async () => {
      const m = req.url!.match(/^\/bot([^/]+)\/(\w+)$/);
      const body = b ? JSON.parse(b) : {};
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (!m || m[1] !== TOKEN) return res.writeHead(401).end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      calls.push({ method: m[2], body });
      switch (m[2]) {
        case "getMe":
          return reply({ id: 999, is_bot: true, username: "SlopTestBot" });
        case "getUpdates": {
          for (let i = 0; i < 20 && !queue.some((u) => u.update_id >= body.offset); i++) await new Promise((r) => setTimeout(r, 15));
          const out = queue.filter((u) => u.update_id >= (body.offset ?? 0));
          queue = queue.filter((u) => u.update_id >= (body.offset ?? 0));
          return reply(out);
        }
        case "sendMessage":
          sent.push({ ...body, message_id: nextMsg });
          return reply({ message_id: nextMsg++ });
        default:
          return reply(true);
      }
    });
  });
  await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
  tgBase = `http://127.0.0.1:${(tg.address() as any).port}`;

  llm = http.createServer((req, res) => {
    req.resume().on("end", () => {
      const n = script.shift() ?? { text: "ok" };
      const message: any = { role: "assistant", content: n.text ?? null };
      if (n.tools) message.tool_calls = n.tools.map(([name, a], i) => ({ id: `c${i}${Math.random()}`, type: "function", function: { name: name.replace(/\./g, "__"), arguments: JSON.stringify(a) } }));
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  llmBase = `http://127.0.0.1:${(llm.address() as any).port}/v1`;
});
after(() => {
  tg.close();
  llm.close();
});

const channels: TelegramChannel[] = [];
after(() => Promise.all(channels.map((c) => c.stop())));

/** Each test gets a fresh channel; the previous one stops so it can't steal updates. */
async function setup() {
  await Promise.all(channels.splice(0).map((c) => c.stop()));
  queue = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-tg-"));
  fs.mkdirSync(path.join(dir, "bots"));
  fs.writeFileSync(
    path.join(dir, "bots", "ledger.yaml"),
    "name: ledger\ndescription: money <stuff> & things\npersona: test\ntools: [\"memory.*\"]\npermissions:\n  - { tool: \"memory.remember\", action: ask }\n",
  );
  fs.writeFileSync(path.join(dir, "bots", "coder.yaml"), "name: coder\ndescription: code\npersona: test\ntools: []\n");
  fs.writeFileSync(path.join(dir, "slopbot.config.yaml"), `defaultModel: mock/m\nproviders:\n  mock: { type: openai, baseUrl: "${llmBase}" }\n`);
  const config: Config = loadConfig(dir);
  const store = new Store(config.dataDir);
  const secrets = new FileSecrets(path.join(dir, "secrets"));
  const ch = new TelegramChannel({ config, store, secrets, apiBase: tgBase, approvalPollMs: 1e9 });
  channels.push(ch);
  return { dir, config, store, secrets, ch };
}

async function linked() {
  const env = await setup();
  await env.ch.setToken(TOKEN);
  await env.ch.start();
  const code = env.ch.startPairing()!.code;
  const from = sent.length;
  text(OWNER, `/start ${code}`);
  await waitFor(() => sent.slice(from).find((m) => m.chat_id === OWNER.id && /Linked!/.test(m.text)));
  return env;
}

test("token: validated with Telegram, stored in the secret store, never in the state file", async () => {
  const { ch, secrets, config } = await setup();
  await assert.rejects(ch.setToken("nope"), /doesn't look like a bot token/);
  await assert.rejects(ch.setToken("123456789:AAH-wrong_token_abcdefghijklmnopqrstuvwxyz"), /rejected the bot token/);
  assert.equal(await ch.setToken(TOKEN), "SlopTestBot");
  assert.equal(secrets.get("channel.telegram.token"), TOKEN);
  const stateFile = fs.readFileSync(path.join(config.dataDir, "channels", "telegram.json"), "utf8");
  assert.ok(!stateFile.includes("AAH-test"), "token not in plain files");
  assert.equal(fs.statSync(path.join(config.dataDir, "channels", "telegram.json")).mode & 0o777, 0o600);
});

test("pairing: deep-link code links the owner; wrong codes burn the code; strangers get silence", async () => {
  const { ch } = await setup();
  await ch.setToken(TOKEN);
  await ch.start();
  const before = sent.length;

  text(STRANGER, "hello?"); // no pairing active
  const pairing = ch.startPairing()!;
  assert.match(pairing.link!, /^https:\/\/t\.me\/SlopTestBot\?start=\d{6}$/);
  const wrong = pairing.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) text(STRANGER, `/link ${wrong}`);
  await waitFor(() => ch.status().rejected >= 6 || undefined);
  assert.equal(ch.status().pairing, undefined, "5 wrong guesses invalidate the code");
  text(STRANGER, `/start ${pairing.code}`); // even the right code is dead now
  await waitFor(() => ch.status().rejected >= 7 || undefined);
  assert.equal(ch.status().linked, false);
  assert.equal(sent.length, before, "strangers never get a reply");

  const fresh = ch.startPairing()!;
  text(OWNER, `${fresh.code}`, "group", -100123); // codes don't work in groups
  await waitFor(() => ch.status().rejected >= 8 || undefined);
  assert.equal(ch.status().linked, false);
  const from = sent.length;
  text(OWNER, `/start ${fresh.code}`);
  await waitFor(() => sent.slice(from).find((m) => m.chat_id === OWNER.id && /Linked!/.test(m.text)));
  assert.equal(ch.status().linked, true);
  assert.equal(ch.status().ownerName, "Cam (@cam)");
  assert.equal(ch.status().pairing, undefined, "code is single-use");
});

test("after linking, only the owner's private chat is answered", async () => {
  const { ch } = await linked();
  const before = sent.length;
  const rejectedBefore = ch.status().rejected;
  text(STRANGER, "/bots");
  text(OWNER, "/bots", "group", -100999); // owner, but in a group
  text(STRANGER, "/start 123456");
  await waitFor(() => ch.status().rejected >= rejectedBefore + 3 || undefined);
  assert.equal(sent.length, before, "no replies to anyone else");
  text(OWNER, "/bots");
  const list = await waitFor(() => sent.slice(before).find((m) => /Switch with/.test(m.text)));
  assert.match(list.text, /money &lt;stuff&gt; &amp; things/, "bot descriptions are escaped");
});

test("chat: messages go to the bot, Markdown becomes Telegram HTML; /bot switches", async () => {
  await linked();
  script = [{ text: "You spent **$57.85** on `dining`." }];
  const before = sent.length;
  text(OWNER, "how much on dining?");
  const reply = await waitFor(() => sent.slice(before).find((m) => /57\.85/.test(m.text)));
  assert.equal(reply.parse_mode, "HTML");
  assert.match(reply.text, /<b>\$57\.85<\/b> on <code>dining<\/code>/);
  assert.match(reply.text, /<i>coder<\/i>|<i>ledger<\/i>/);
  text(OWNER, "/bot nope");
  await waitFor(() => sent.find((m) => /No bot named "nope"/.test(m.text)));
});

test("approvals: Approve / Deny buttons; a stranger's button press does nothing", async () => {
  const { store } = await linked();
  text(OWNER, "/bot ledger");
  await waitFor(() => sent.find((m) => /Now talking to <b>ledger/.test(m.text)));
  script = [{ tools: [["memory.remember", { text: "dining budget $150" }]] }, { text: "Saved your budget." }];
  const before = sent.length;
  text(OWNER, "remember my dining budget is $150");
  const ask = await waitFor(() => sent.slice(before).find((m) => m.reply_markup?.inline_keyboard));
  assert.match(ask.text, /wants to run <code>memory\.remember<\/code>/);
  const approve = ask.reply_markup.inline_keyboard[0][0].callback_data;

  press(STRANGER, approve, ask.message_id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.readMemory("ledger").length, 0, "stranger can't approve");

  press(OWNER, approve, ask.message_id);
  await waitFor(() => sent.slice(before).find((m) => /Saved your budget/.test(m.text)));
  assert.equal(store.readMemory("ledger")[0].text, "dining budget $150");
  assert.ok(calls.some((c) => c.method === "editMessageText" && /✅ Approved/.test(c.body.text)), "the prompt is marked approved");
});

test("queued approvals from background runs arrive with buttons and run when approved", async () => {
  const { ch, store } = await linked();
  const a = store.addApproval({ bot: "ledger", session: "s1", call: { id: "1", name: "memory.remember", args: { text: "from a scheduled run" } }, reason: "background" });
  const before = sent.length;
  await ch.notifyQueuedApprovals();
  await ch.notifyQueuedApprovals(); // no duplicates
  const note = sent.slice(before).filter((m) => /queued an action/.test(m.text));
  assert.equal(note.length, 1);
  press(OWNER, `q:${a.id}:yes`, note[0].message_id);
  await waitFor(() => sent.find((m) => /✅ Ran <code>memory\.remember<\/code>/.test(m.text)));
  assert.equal(store.readMemory("ledger")[0].text, "from a scheduled run");
  assert.equal(store.listApprovals()[0].status, "approved");
});

test("stale messages aren't acted on; scheduled reports go to the owner", async () => {
  const { ch } = await linked();
  push({ message: { message_id: nextMsg++, from: OWNER, chat: { id: OWNER.id, type: "private" }, date: now() - 3600, text: "delete everything" } });
  await waitFor(() => sent.find((m) => /offline when you sent that/.test(m.text)));
  await ch.report("ledger · weekly-report", "Spent **$412** this week.");
  assert.match(sent.at(-1).text, /📬 <b>ledger · weekly-report<\/b>/);
});

test("only one process can poll the same bot", async () => {
  const { config, store, secrets, ch } = await setup();
  await ch.setToken(TOKEN);
  assert.equal(await ch.start(), true);
  const second = new TelegramChannel({ config, store, secrets, apiBase: tgBase, approvalPollMs: 1e9 });
  assert.equal(await second.start(), false);
  assert.match(second.status().error!, /already connected to Telegram/);
});

test("offline at startup: a clear message, then it connects by itself when the network is back", async () => {
  const { config, store, secrets } = await setup();
  secrets.set("channel.telegram.token", TOKEN);
  fs.mkdirSync(path.join(config.dataDir, "channels"), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, "channels", "telegram.json"), JSON.stringify({ enabled: true, botUsername: "SlopTestBot", notifiedApprovals: [] }));
  let base = "http://127.0.0.1:9"; // nothing listens here
  const ch = new TelegramChannel({ config, store, secrets, approvalPollMs: 1e9, retryMs: 100, get apiBase() { return base; } } as any);
  channels.push(ch);
  assert.equal(await ch.start(), false);
  assert.match(ch.status().error!, /Can't reach Telegram/);
  base = tgBase; // network back
  await waitFor(() => ch.status().running || undefined);
  assert.equal(ch.status().error, undefined);
});

test("formatting helpers", () => {
  assert.equal(toTelegramHtml("a < b & **c**\n```js\nx<1\n```"), "a &lt; b &amp; <b>c</b>\n<pre>x&lt;1</pre>");
  const parts = chunk("x".repeat(3000) + "\n\n" + "y".repeat(3000));
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 3900));
});
