// SlopBot's MCP server, driven by a real MCP client over an in-memory transport.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Store } from "../src/store/store.js";

let script: Array<{ tools?: Array<[string, object]>; text?: string }> = [];
let server: http.Server;
let client: Client;
let store: Store;

before(async () => {
  server = http.createServer((req, res) => {
    req.resume().on("end", () => {
      const next = script.shift() ?? { text: "done" };
      const message: any = { role: "assistant", content: next.text ?? null };
      if (next.tools) {
        message.tool_calls = next.tools.map(([name, args], i) => ({
          id: `c${i}${Math.random()}`,
          type: "function",
          function: { name: name.replace(/\./g, "__"), arguments: JSON.stringify(args) },
        }));
      }
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-mcp-"));
  const root = path.join(import.meta.dirname, "..");
  fs.cpSync(path.join(root, "bots"), path.join(dir, "bots"), { recursive: true });
  fs.cpSync(path.join(root, "examples"), path.join(dir, "examples"), { recursive: true });
  const config: Config = {
    rootDir: dir,
    dataDir: path.join(dir, "data"),
    botsDir: path.join(dir, "bots"),
    defaultModel: "mock/m",
    providers: { mock: { type: "openai", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` } },
    policy: { rules: [] },
    maxToolOutputChars: 12_000,
  };
  store = new Store(config.dataDir);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(config, store).connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});
after(async () => {
  await client.close();
  server.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c: any) => c.text).join("\n") as string, isError: !!r.isError };
};

test("exposes the expected tools, and no way to approve", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["ask_bot", "get_activity", "get_memory", "list_bots", "list_pending_approvals", "run_schedule"]);
  assert.ok(!names.some((n) => /approve|deny|resolve/.test(n)));
});

test("list_bots returns the sample bots", async () => {
  const { text } = await call("list_bots");
  const bots = JSON.parse(text);
  assert.deepEqual(bots.map((b: any) => b.name), ["coder", "ledger", "reporter"]);
  assert.ok(bots.find((b: any) => b.name === "ledger").tools.includes("finance.summary"));
});

test("ask_bot: reads run, writes are queued for a human, conversation continues", async () => {
  script = [
    { tools: [["finance.import_csv", { path: "examples/sample-bank.csv" }], ["finance.summary", {}]] },
    { text: "Import is waiting for your approval; the ledger is empty for now." },
  ];
  const r1 = await call("ask_bot", { bot: "ledger", message: "import the sample csv" });
  assert.equal(r1.isError, false);
  assert.match(r1.text, /waiting for your approval/);
  assert.match(r1.text, /finance\.import_csv .* → ask/);
  assert.match(r1.text, /finance\.summary .* → allow/);
  assert.match(r1.text, /Awaiting human approval: ap_/);
  assert.equal(fs.existsSync(path.join(store.workspaceDir("ledger"), "ledger.json")), false, "import must not have run");

  const pending = JSON.parse((await call("list_pending_approvals")).text);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "finance.import_csv");

  // Follow-up keeps the same conversation (history is sent to the model).
  script = [{ text: "Still waiting on you." }];
  const r2 = await call("ask_bot", { bot: "ledger", message: "status?" });
  assert.match(r2.text, /Still waiting/);
  assert.doesNotMatch(r2.text, /Actions taken/, "actions list resets each turn");
});

test("errors are reported as tool errors, not crashes", async () => {
  const r = await call("ask_bot", { bot: "nope", message: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No bot named "nope"/);
  const r2 = await call("run_schedule", { bot: "coder" });
  assert.equal(r2.isError, true);
});

test("activity and memory are readable", async () => {
  assert.match((await call("get_activity", { bot: "ledger", limit: 5 })).text, /"bot":"ledger"/);
  assert.match((await call("get_memory", { bot: "ledger" })).text, /doesn't remember anything yet/);
});
