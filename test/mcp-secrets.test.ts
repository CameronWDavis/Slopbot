// API keys pasted into connectors go to the secret store; config files only hold references.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { McpManager } from "../src/mcp/client.js";
import { FileSecrets, looksSecret } from "../src/secrets.js";

process.env.SLOPBOT_SECRETS = "file";
const root = path.join(import.meta.dirname, "..");
const TSX = path.join(root, "node_modules/.bin/tsx");
const FIXTURE = path.join(root, "test/fixtures/echo-mcp.ts");
const managers: McpManager[] = [];
after(() => Promise.all(managers.map((m) => m.closeAll())));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-msec-"));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
  const secrets = new FileSecrets(path.join(config.dataDir, "secrets"));
  const make = () => {
    const m = new McpManager(config);
    managers.push(m);
    return m;
  };
  return { dir, config, secrets, make, file: path.join(dir, "slopbot.mcp.json") };
}

test("what counts as a secret", () => {
  for (const [name, value] of [
    ["GITHUB_TOKEN", "abc"],
    ["Authorization", "Bearer ghp_1234567890abcdef"],
    ["X-API-Key", "k"],
    ["", "sk-proj-abc123"],
    ["", "xoxb-1-2-3"],
    ["DB_PASSWORD", "hunter2"],
    ["", "a8F3kQ9zL2mN7pR4tV6wX1yB5cD0eG"],
  ]) assert.equal(looksSecret(name, value), true, `${name}=${value}`);
  for (const [name, value] of [
    ["MEMORY_FILE_PATH", "/tmp/kg.jsonl"],
    ["TOKEN_FILE", "~/tokens.json"],
    ["LOG_LEVEL", "debug"],
    ["PORT", "8080"],
    ["Authorization", "Bearer "],
    ["GITHUB_TOKEN", "${GITHUB_TOKEN}"],
    ["", "@modelcontextprotocol/server-filesystem"],
    ["", "-y"],
  ]) assert.equal(looksSecret(name, value), false, `${name}=${value}`);
});

test("saving moves keys out of the config file and connecting still works", async () => {
  const { make, file, secrets } = setup();
  const mcp = make();
  await mcp.saveServer("echo", {
    command: TSX,
    args: [FIXTURE, "--api-key", "sk-live-abcdef123456", "--token=ghp_zzzzzzzzzzzz9", "--verbose"],
    env: { ECHO_TOKEN: "ghp_realtoken123456", LOG_LEVEL: "debug" },
    bots: ["*"],
  });
  const text = fs.readFileSync(file, "utf8");
  for (const leaked of ["sk-live-abcdef123456", "ghp_zzzzzzzzzzzz9", "ghp_realtoken123456"]) assert.ok(!text.includes(leaked), `${leaked} must not be in the file`);
  const saved = JSON.parse(text).mcpServers.echo;
  assert.equal(saved.env.ECHO_TOKEN, "${secret:mcp.echo.env.ECHO_TOKEN}");
  assert.equal(saved.env.LOG_LEVEL, "debug", "non-secrets stay readable");
  assert.deepEqual(saved.args.slice(1), ["--api-key", "${secret:mcp.echo.arg.2}", "--token=${secret:mcp.echo.arg.3}", "--verbose"]);
  assert.equal(secrets.get("mcp.echo.env.ECHO_TOKEN"), "ghp_realtoken123456");

  const { tools } = await mcp.toolsForBot("x");
  const echo = tools.find((t) => t.name === "mcp.echo.echo")!;
  assert.match(await echo.run({ text: "hi" }, {} as any), /token=ghp_realtoken123456/, "resolved at launch");
  // The status sent to the UI only ever contains references.
  assert.ok(!JSON.stringify(mcp.status()).includes("ghp_realtoken123456"));
});

test("headers and URL query keys are secured too", async () => {
  const { make, file, secrets } = setup();
  await make().saveServer("remote", { url: "https://example.com/mcp?api_key=abc123secret&region=eu", headers: { Authorization: "Bearer tok_123456789", Accept: "application/json" }, bots: ["*"] });
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.remote;
  assert.equal(saved.url, "https://example.com/mcp?api_key=${secret:mcp.remote.url.api_key}&region=eu");
  assert.equal(saved.headers.Authorization, "${secret:mcp.remote.header.Authorization}");
  assert.equal(saved.headers.Accept, "application/json");
  assert.equal(secrets.get("mcp.remote.url.api_key"), "abc123secret");
});

test("editing keeps stored keys, rename moves them, remove deletes them", async () => {
  const { make, file, secrets } = setup();
  const mcp = make();
  await mcp.saveServer("gh", { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ghp_first111111" }, bots: ["*"] });
  // The edit form sends the reference back unchanged when the user leaves the field blank.
  const saved = mcp.readServers().gh;
  await mcp.saveServer("gh", { ...saved, bots: ["ledger"] });
  assert.equal(secrets.get("mcp.gh.header.Authorization"), "Bearer ghp_first111111");

  await mcp.saveServer("github", mcp.readServers().gh, "gh");
  assert.equal(mcp.readServers().github.headers!.Authorization, "${secret:mcp.github.header.Authorization}");
  assert.equal(secrets.get("mcp.github.header.Authorization"), "Bearer ghp_first111111");
  assert.equal(secrets.get("mcp.gh.header.Authorization"), undefined, "old name's secret cleaned up");

  // Replacing the token overwrites the stored value.
  await mcp.saveServer("github", { ...mcp.readServers().github, headers: { Authorization: "Bearer ghp_second22222" } });
  assert.equal(secrets.get("mcp.github.header.Authorization"), "Bearer ghp_second22222");

  await mcp.removeServer("github");
  assert.equal(secrets.get("mcp.github.header.Authorization"), undefined);
  assert.ok(!fs.readFileSync(file, "utf8").includes("ghp_"));
});

test("plaintext keys in an existing file are migrated on startup", async () => {
  const { make, file, secrets } = setup();
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { brave: { command: "npx", args: ["-y", "brave-search"], env: { BRAVE_API_KEY: "BSAabcdef123456" }, bots: ["*"] } } }));
  make();
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.brave;
  assert.equal(saved.env.BRAVE_API_KEY, "${secret:mcp.brave.env.BRAVE_API_KEY}");
  assert.equal(secrets.get("mcp.brave.env.BRAVE_API_KEY"), "BSAabcdef123456");
  // Pasting Claude Desktop JSON with keys gets the same treatment.
  const mcp = make();
  await mcp.importJson(JSON.stringify({ mcpServers: { slack: { command: "npx", args: ["slack-mcp"], env: { SLACK_BOT_TOKEN: "xoxb-1-2-abc" } } } }));
  assert.ok(!fs.readFileSync(file, "utf8").includes("xoxb-"));
});

test("a missing secret gives a clear error instead of a confusing auth failure", async () => {
  const { make, secrets } = setup();
  const mcp = make();
  await mcp.saveServer("echo", { command: TSX, args: [FIXTURE], env: { ECHO_TOKEN: "ghp_willvanish123" }, bots: ["*"] });
  secrets.delete("mcp.echo.env.ECHO_TOKEN");
  await assert.rejects(mcp.connect("echo"), /Secret "mcp\.echo\.env\.ECHO_TOKEN" isn't in your/);
});

test("slopbot.config.yaml can reference stored secrets", () => {
  const { dir, config } = setup();
  new FileSecrets(path.join(config.dataDir, "secrets")).set("openai", "sk-from-keychain");
  fs.writeFileSync(path.join(dir, "slopbot.config.yaml"), "providers:\n  openai:\n    type: openai\n    apiKey: ${secret:openai}\n  other:\n    type: openai\n    apiKey: ${secret:not-set}\n");
  const cfg = loadConfig(dir);
  assert.equal(cfg.providers.openai.apiKey, "sk-from-keychain");
  assert.equal(cfg.providers.other.apiKey, undefined, "missing secret → no key (with a warning), not a crash");
});
