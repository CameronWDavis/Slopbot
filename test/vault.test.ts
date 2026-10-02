// The credential vault: encrypted at rest, bound to this machine's key, usable but never readable by bots.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { BotDef } from "../src/agent/bot.js";
import type { Config } from "../src/config.js";
import { evaluate } from "../src/policy/policy.js";
import { FileSecrets } from "../src/secrets.js";
import { httpTools } from "../src/tools/http.js";
import { domainAllowed, normalizeDomain, Vault, VaultLockedError } from "../src/vault/vault.js";

const SECRET = "ghp_SuperSecretToken1234567890";

function newVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-vault-"));
  const secrets = new FileSecrets(path.join(dir, "secrets"));
  return { dir, secrets, vault: new Vault(path.join(dir, "vault.enc"), secrets) };
}

test("encrypted at rest; list never includes secrets", () => {
  const { vault } = newVault();
  vault.upsert({ name: "GitHub", kind: "api_key", domains: ["https://github.com/settings", "api.github.com"], secret: SECRET });
  vault.upsert({ name: "Bank", kind: "login", domains: ["mybank.com"], username: "cam", secret: "hunter2-but-longer" });
  const raw = fs.readFileSync(vault.file, "utf8");
  for (const leak of [SECRET, "hunter2", "GitHub", "mybank", "cam"]) assert.ok(!raw.includes(leak), `"${leak}" must not appear in the file`);
  assert.equal(fs.statSync(vault.file).mode & 0o777, 0o600);
  assert.match(JSON.parse(raw).id, /^[0-9a-f]{16}$/);
  assert.equal(vault.keyName, `vault.key.${JSON.parse(raw).id}`, "each vault has its own key name");
  const list = vault.list();
  assert.deepEqual(list.map((e) => [e.name, e.domains, e.hasSecret]), [["GitHub", ["github.com", "api.github.com"], true], ["Bank", ["mybank.com"], true]]);
  assert.ok(!JSON.stringify(list).includes(SECRET));
});

test("the file is useless without this machine's key, and tampering is detected", () => {
  const { dir, vault } = newVault();
  vault.upsert({ name: "GitHub", kind: "api_key", domains: ["github.com"], secret: SECRET });
  // Copied to another machine = a different secret store without the key.
  const elsewhere = new Vault(vault.file, new FileSecrets(path.join(dir, "other-machine")));
  assert.throws(() => elsewhere.list(), VaultLockedError);
  // Flip one byte of ciphertext.
  const box = JSON.parse(fs.readFileSync(vault.file, "utf8"));
  const data = Buffer.from(box.data, "base64");
  data[0] ^= 1;
  fs.writeFileSync(vault.file, JSON.stringify({ ...box, data: data.toString("base64") }));
  assert.throws(() => new Vault(vault.file, (vault as any).secrets).list(), /modified/);
});

test("two vaults on one machine never share or overwrite each other's key", () => {
  const { dir, secrets } = newVault();
  const a = new Vault(path.join(dir, "a.enc"), secrets);
  const b = new Vault(path.join(dir, "b.enc"), secrets);
  a.upsert({ name: "A", kind: "api_key", domains: ["a.com"], secret: "aaaa1111" });
  b.upsert({ name: "B", kind: "api_key", domains: ["b.com"], secret: "bbbb2222" });
  assert.notEqual(a.keyName, b.keyName);
  secrets.delete(b.keyName);
  assert.deepEqual(new Vault(path.join(dir, "a.enc"), secrets).list().map((e) => e.name), ["A"], "deleting B's key doesn't affect A");
  assert.throws(() => new Vault(path.join(dir, "b.enc"), secrets).list(), VaultLockedError);
});

test("editing without a new secret keeps the old one; names are unique", () => {
  const { vault } = newVault();
  const e = vault.upsert({ name: "GitHub", kind: "api_key", domains: ["github.com"], secret: SECRET });
  vault.upsert({ id: e.id, name: "GitHub", kind: "api_key", domains: ["github.com"], bots: ["coder"] });
  assert.equal(vault.credentialFor("GitHub", "https://api.github.com/user", "coder").headers.authorization, `Bearer ${SECRET}`);
  assert.throws(() => vault.upsert({ name: "github", kind: "api_key", domains: ["x.com"], secret: "y" }), /already an entry/);
  assert.throws(() => vault.upsert({ name: "NoDomain", kind: "api_key", domains: [], secret: "y" }), /at least one website/);
});

test("domain binding: subdomains ok, look-alikes and plain http are refused", () => {
  assert.equal(normalizeDomain("https://www.GitHub.com/login"), "github.com");
  assert.equal(normalizeDomain("*.example.com"), "example.com");
  const d = ["github.com"];
  assert.equal(domainAllowed("https://api.github.com/user", d), true);
  assert.equal(domainAllowed("https://github.com", d), true);
  assert.equal(domainAllowed("https://github.com.evil.io/steal", d), false);
  assert.equal(domainAllowed("https://evilgithub.com", d), false);
  assert.equal(domainAllowed("http://api.github.com", d), false, "never over plain http");
});

test("bot access and send-as modes", () => {
  const { vault } = newVault();
  vault.upsert({ name: "Linear", kind: "api_key", domains: ["linear.app"], sendAs: "header", field: "X-Api-Key", bots: ["coder"], secret: "lin_api_123456" });
  vault.upsert({ name: "Maps", kind: "api_key", domains: ["maps.example.com"], sendAs: "query", field: "key", secret: "AIzaMapsKey123" });
  vault.upsert({ name: "Svc", kind: "login", domains: ["svc.example.com"], username: "bot", secret: "pw-1234" });
  assert.equal(vault.list("ledger").find((e) => e.name === "Linear"), undefined);
  assert.throws(() => vault.credentialFor("Linear", "https://api.linear.app/graphql", "ledger"), /isn't shared with this bot/);
  assert.equal(vault.credentialFor("Linear", "https://api.linear.app/graphql", "coder").headers["x-api-key"], "lin_api_123456");
  assert.match(vault.credentialFor("Maps", "https://maps.example.com/geo?q=1", "x").url, /key=AIzaMapsKey123/);
  assert.equal(vault.credentialFor("Svc", "https://svc.example.com/", "x").headers.authorization, `Basic ${Buffer.from("bot:pw-1234").toString("base64")}`);
  assert.ok(vault.list().find((e) => e.name === "Svc")!.lastUsedAt, "usage is recorded");
});

// ── http.fetch with credentials, against a local https-less test server via the localhost exception ──
let srv: http.Server;
let base = "";
let lastAuth: string | undefined;
before(async () => {
  srv = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.url === "/echo") return res.end(`you sent ${req.headers.authorization}`);
    if (req.url === "/redirect-away") return res.writeHead(302, { location: "https://attacker.example/collect" }).end();
    if (req.url === "/redirect-home") return res.writeHead(302, { location: "/echo" }).end();
    res.end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
after(() => srv.close());

const fetchTool = httpTools.find((t) => t.name === "http.fetch")!;
function ctxWith(vault: Vault, botName = "coder") {
  return { bot: { name: botName } as BotDef, vault, config: {} as Config } as any;
}

test("http.fetch injects the credential, and scrubs it from the response the model sees", async () => {
  const { vault } = newVault();
  vault.upsert({ name: "Local", kind: "api_key", domains: ["127.0.0.1"], secret: SECRET });
  const out = await fetchTool.run({ url: `${base}/echo`, credential: "Local" }, ctxWith(vault));
  assert.equal(lastAuth, `Bearer ${SECRET}`, "server received the real token");
  assert.ok(!out.includes(SECRET), "model never sees it");
  assert.match(out, /you sent Bearer \[vault:Local\]/);
  assert.match(out, /authenticated as vault:Local/);
  // Same-site redirects keep working.
  assert.match(await fetchTool.run({ url: `${base}/redirect-home`, credential: "Local" }, ctxWith(vault)), /\[vault:Local\]/);
});

test("a credential can't be sent to the wrong site, even via redirect, and the model can't set auth headers", async () => {
  const { vault } = newVault();
  vault.upsert({ name: "Local", kind: "api_key", domains: ["127.0.0.1"], secret: SECRET });
  vault.upsert({ name: "GitHub", kind: "api_key", domains: ["github.com"], secret: SECRET });
  await assert.rejects(fetchTool.run({ url: `${base}/echo`, credential: "GitHub" }, ctxWith(vault)), /may only be sent to github\.com/);
  await assert.rejects(fetchTool.run({ url: `${base}/redirect-away`, credential: "Local" }, ctxWith(vault)), /not to attacker\.example/);
  await assert.rejects(fetchTool.run({ url: `${base}/echo`, headers: { Authorization: "x" } }, ctxWith(vault)), /use the credential parameter/);
});

test("using a credential or changing data asks the user by default", () => {
  const config = { policy: { rules: [] } } as unknown as Config;
  const bot = { permissions: [] } as unknown as BotDef;
  const risk = (args: any) => fetchTool.riskFor!(args);
  const decide = (args: any) => evaluate(config, bot, { id: "1", name: "http.fetch", args }, risk(args), "interactive").action;
  assert.equal(decide({ url: "https://example.com" }), "allow");
  assert.equal(decide({ url: "https://api.github.com/user", credential: "GitHub" }), "ask");
  assert.equal(decide({ url: "https://example.com", method: "POST" }), "ask");
});
