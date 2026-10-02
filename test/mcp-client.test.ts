// Bots using external MCP servers as tools.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { BotDef } from "../src/agent/bot.js";
import { Agent, executeApproval } from "../src/agent/runtime.js";
import type { Config } from "../src/config.js";
import { McpManager, riskFromAnnotations, slopToolName } from "../src/mcp/client.js";
import { Store } from "../src/store/store.js";

const root = path.join(import.meta.dirname, "..");
const TSX = path.join(root, "node_modules/.bin/tsx");
const FIXTURE = path.join(root, "test/fixtures/echo-mcp.ts");

let script: Array<{ tools?: Array<[string, object]>; text?: string }> = [];
const requests: any[] = [];
let llm: http.Server;
let config: Config;
let store: Store;
let mcp: McpManager;

before(async () => {
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      requests.push(JSON.parse(body));
      const next = script.shift() ?? { text: "done" };
      const message: any = { role: "assistant", content: next.text ?? null };
      if (next.tools) message.tool_calls = next.tools.map(([n, a], i) => ({ id: `c${requests.length}_${i}`, type: "function", function: { name: n.replace(/\./g, "__"), arguments: JSON.stringify(a) } }));
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-mcpc-"));
  config = {
    rootDir: dir,
    dataDir: path.join(dir, "data"),
    botsDir: path.join(dir, "bots"),
    defaultModel: "mock/m",
    providers: { mock: { type: "openai", baseUrl: `http://127.0.0.1:${(llm.address() as any).port}/v1` } },
    policy: { rules: [] },
    maxToolOutputChars: 12_000,
  };
  store = new Store(config.dataDir);
  mcp = new McpManager(config);
  process.env.SECRET_FOR_TEST = "s3cr3t";
});
after(async () => {
  await mcp.closeAll();
  llm.close();
});

const bot = (name = "ledger"): BotDef => ({ name, description: "", persona: "test", tools: ["memory.*"], allowedPaths: [], maxSteps: 8, permissions: [], schedules: [], file: "" });

test("naming and risk mapping", () => {
  assert.equal(slopToolName("Echo Server", "wipe.all notes"), "mcp.echo_server.wipe_all_notes");
  assert.ok(slopToolName("s", "x".repeat(200)).replace(/\./g, "__").length <= 64);
  assert.equal(riskFromAnnotations({ readOnlyHint: true }), "read");
  assert.equal(riskFromAnnotations({ destructiveHint: true }), "dangerous");
  assert.equal(riskFromAnnotations(undefined), "external");
});

test("import Claude Desktop JSON, test connection, per-bot assignment", async () => {
  const names = await mcp.importJson(
    JSON.stringify({ mcpServers: { echo: { command: TSX, args: [FIXTURE], env: { ECHO_TOKEN: "${SECRET_FOR_TEST}" } } } }),
    ["ledger"],
  );
  assert.deepEqual(names, ["echo"]);
  const saved = JSON.parse(fs.readFileSync(mcp.file, "utf8"));
  assert.equal(saved.mcpServers.echo.env.ECHO_TOKEN, "${SECRET_FOR_TEST}", "secrets stay as references on disk");
  assert.deepEqual(mcp.serversForBot("ledger"), ["echo"]);
  assert.deepEqual(mcp.serversForBot("coder"), []);

  const tools = await mcp.test("echo", mcp.readServers().echo);
  assert.deepEqual(
    tools.map((t) => [t.slopName, t.risk]),
    [
      ["mcp.echo.echo", "read"],
      ["mcp.echo.write_note", "external"],
      ["mcp.echo.wipe_all_notes", "dangerous"],
      ["mcp.echo.broken", "external"],
    ],
  );
  await assert.rejects(mcp.importJson("nope"), /valid JSON/);
  await assert.rejects(mcp.test("bad", { command: "definitely-not-a-command-xyz" }));
});

test("agent uses MCP tools through the policy engine", async () => {
  script = [
    { tools: [["mcp.echo.echo", { text: "hi" }], ["mcp.echo.write_note", { note: "n1" }], ["mcp.echo.wipe_all_notes", {}], ["mcp.echo.broken", {}]] },
    { text: "ok" },
  ];
  const asked: string[] = [];
  const agent = new Agent(config, store, bot(), "interactive", { approve: async (c) => (asked.push(c.name), c.name.includes("wipe") ? "no" : "yes") }, mcp);
  await agent.send("go");

  const sentTools = requests.at(-1).tools.map((t: any) => t.function.name);
  assert.ok(sentTools.includes("mcp__echo__echo") && sentTools.includes("memory__remember"));
  assert.deepEqual(asked, ["mcp.echo.write_note", "mcp.echo.wipe_all_notes", "mcp.echo.broken"], "read-only tool runs without asking");
  const results = agent.messages.filter((m) => m.role === "tool").map((m: any) => m.content);
  assert.match(results[0], /echo: hi \(token=s3cr3t\)/, "env ${VAR} resolved at launch");
  assert.match(results[0], /untrusted_content source="mcp:echo"/);
  assert.match(results[1], /saved 1/);
  assert.match(results[2], /BLOCKED/);
  assert.match(results[3], /Error: kaboom/);

  // A bot without the server doesn't see its tools.
  script = [{ text: "ok" }];
  await new Agent(config, store, bot("coder"), "interactive", {}, mcp).send("hi");
  assert.ok(!requests.at(-1).tools.some((t: any) => t.function.name.startsWith("mcp__")));
});

test("background mode queues MCP writes; approval executes them later", async () => {
  script = [{ tools: [["mcp.echo.write_note", { note: "queued" }]] }, { text: "queued it" }];
  const res = await new Agent(config, store, bot(), "background", {}, mcp).send("save a note");
  assert.equal(res.pendingApprovals.length, 1);
  await mcp.closeAll(); // approval may happen in a different process; it must reconnect
  const out = await executeApproval(config, store, bot(), res.pendingApprovals[0], mcp);
  assert.match(out, /saved 1/);
});

test("disabled or broken servers don't break the bot", async () => {
  await mcp.saveServer("ghost", { command: "definitely-not-a-command-xyz", bots: ["*"] });
  script = [{ text: "fine" }];
  const res = await new Agent(config, store, bot(), "interactive", {}, mcp).send("hi");
  assert.equal(res.text, "fine");
  assert.ok(store.readAudit({ bot: "ledger" }).some((e: any) => /MCP server "ghost" unavailable/.test(String(e.error))));
  await mcp.saveServer("ghost", { command: "definitely-not-a-command-xyz", bots: ["*"], enabled: false });
  assert.deepEqual(mcp.serversForBot("ledger"), ["echo"]);
  await mcp.removeServer("ghost");
  assert.equal(mcp.readServers().ghost, undefined);
});
