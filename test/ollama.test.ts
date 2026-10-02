import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ensureOllamaProvider, setBotModel, setDefaultModel } from "../src/config-edit.js";
import { loadConfig } from "../src/config.js";
import { Ollama, ollamaUrl, type PullProgress } from "../src/ollama/ollama.js";

let srv: http.Server;
let url = "";
const deleted: string[] = [];
const unloaded: string[] = [];

before(async () => {
  srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", async () => {
      const json = (d: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(d));
      const b = body ? JSON.parse(body) : {};
      switch (req.url) {
        case "/api/version":
          return json({ version: "0.35.0" });
        case "/api/tags":
          return json({
            models: [
              { name: "qwen3:8b", size: 5_225_000_000, details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
              { name: "gemma3:4b", size: 3_338_000_000, details: { family: "gemma3", parameter_size: "4.3B", quantization_level: "Q4_K_M" } },
            ],
          });
        case "/api/ps":
          return json({ models: [{ name: "qwen3:8b", size_vram: 6_000_000_000 }] });
        case "/api/show":
          return json({ capabilities: b.model === "qwen3:8b" ? ["completion", "tools", "thinking"] : ["completion", "vision"] });
        case "/api/delete":
          deleted.push(b.model);
          return json({});
        case "/api/generate":
          unloaded.push(`${b.model}:${b.keep_alive}`);
          return json({ done: true });
        case "/api/pull": {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          const send = (o: object) => res.write(JSON.stringify(o) + "\n");
          if (b.model === "nope:1b") {
            send({ status: "pulling manifest" });
            return res.end(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n");
          }
          if (b.model === "slow:1b") {
            send({ status: "pulling manifest" });
            return; // never finishes; client aborts
          }
          send({ status: "pulling manifest" });
          for (const c of [0, 500, 1000]) send({ status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: c });
          for (const c of [0, 100]) send({ status: "pulling bbb", digest: "sha256:bbb", total: 100, completed: c });
          send({ status: "verifying sha256 digest" });
          send({ status: "writing manifest" });
          send({ status: "success" });
          return res.end();
        }
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as any).port}`;
});
after(() => srv.close());

test("lists models with tool support and loaded state", async () => {
  const o = new Ollama(url);
  assert.equal(await o.version(), "0.35.0");
  const models = await o.list();
  assert.deepEqual(
    models.map((m) => [m.name, m.capabilities?.includes("tools"), m.loaded, m.parameterSize]),
    [
      ["gemma3:4b", false, false, "4.3B"],
      ["qwen3:8b", true, true, "8.2B"],
    ],
  );
  assert.equal(await new Ollama("http://127.0.0.1:1").version(), null, "not running → null");
});

test("pull aggregates progress across layers and finishes", async () => {
  const seen: PullProgress[] = [];
  await new Ollama(url).pull("qwen3:4b", (p) => seen.push(p));
  const last = seen.at(-1)!;
  assert.equal(last.done, true);
  assert.equal(last.total, 1100);
  assert.equal(last.completed, 1100);
  assert.ok(seen.some((p) => p.completed === 500 && p.total === 1000), "mid-download progress reported");
});

test("pull surfaces Ollama errors and can be cancelled", async () => {
  await assert.rejects(new Ollama(url).pull("nope:1b", () => {}), /file does not exist/);
  const ac = new AbortController();
  const p = new Ollama(url).pull("slow:1b", () => ac.abort(), ac.signal);
  await assert.rejects(p, /abort/i);
});

test("delete and unload", async () => {
  const o = new Ollama(url);
  await o.delete("gemma3:4b");
  await o.unload("qwen3:8b");
  assert.deepEqual(deleted, ["gemma3:4b"]);
  assert.deepEqual(unloaded, ["qwen3:8b:0"]);
});

test("config edits keep comments and add the Ollama provider when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-cfg-"));
  fs.writeFileSync(
    path.join(dir, "slopbot.config.yaml"),
    "# my notes\ndefaultModel: openai/gpt-5 # hosted for now\nproviders:\n  openai:\n    type: openai\n    baseUrl: https://api.openai.com/v1\n",
  );
  assert.equal(ensureOllamaProvider(dir), "ollama");
  setDefaultModel(dir, "ollama/qwen3:8b");
  const text = fs.readFileSync(path.join(dir, "slopbot.config.yaml"), "utf8");
  assert.match(text, /^# my notes/);
  assert.match(text, /defaultModel: ollama\/qwen3:8b/);
  const cfg = loadConfig(dir);
  assert.equal(cfg.providers.ollama.baseUrl, "http://localhost:11434/v1");
  assert.equal(cfg.providers.openai.type, "openai", "existing providers kept");
  assert.equal(ollamaUrl(cfg), "http://localhost:11434");
  assert.equal(ensureOllamaProvider(dir), "ollama", "idempotent");

  const bot = path.join(dir, "bot.yaml");
  fs.writeFileSync(bot, "name: ledger\n# model notes\npersona: hi\n");
  setBotModel(bot, "ollama/llama3.1:8b");
  assert.match(fs.readFileSync(bot, "utf8"), /model: ollama\/llama3\.1:8b/);
  assert.match(fs.readFileSync(bot, "utf8"), /# model notes/);
  setBotModel(bot, null);
  assert.doesNotMatch(fs.readFileSync(bot, "utf8"), /^model:/m);
});

test("a config with no file gets one from the example", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-cfg2-"));
  fs.copyFileSync(path.join(import.meta.dirname, "../slopbot.config.example.yaml"), path.join(dir, "slopbot.config.example.yaml"));
  setDefaultModel(dir, "ollama/qwen3:4b");
  const text = fs.readFileSync(path.join(dir, "slopbot.config.yaml"), "utf8");
  assert.match(text, /defaultModel: ollama\/qwen3:4b/);
  assert.match(text, /# SlopBot configuration/, "example comments preserved");
});
