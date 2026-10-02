import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { formatResults, resolveSearch, webSearch, type SearchConfig } from "../src/search/search.js";
import { FileSecrets } from "../src/secrets.js";

let srv: http.Server;
let base = "";
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
before(async () => {
  srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      seen.push({ url: req.url!, headers: req.headers, body });
      const json = (d: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(d));
      if (req.url!.startsWith("/ollama")) return req.headers.authorization === "Bearer ok-key" ? json({ results: [{ title: "Ollama", url: "https://ollama.com", content: "Run models" }] }) : json({ error: "Unauthorized" }, 401);
      if (req.url!.startsWith("/brave")) return json({ web: { results: [{ title: "<b>Brave</b> result", url: "https://brave.com", description: "A <strong>browser</strong>" }] } });
      if (req.url!.startsWith("/tavily")) return json({ results: [{ title: "Tavily", url: "https://tavily.com", content: "Search for agents" }] });
      if (req.url!.startsWith("/search")) return json({ results: [{ title: "SearX", url: "https://searx.example", content: "self-hosted" }] });
      if (req.url!.startsWith("/basic/ddg")) return json({ Heading: "Ollama", AbstractText: "Ollama is a tool to run LLMs.", AbstractURL: "https://en.wikipedia.org/wiki/Ollama", RelatedTopics: [{ Text: "LM Studio - a desktop app", FirstURL: "https://duckduckgo.com/LM_Studio" }, { Topics: [{ Text: "llama.cpp - inference", FirstURL: "https://duckduckgo.com/llama.cpp" }] }] });
      if (req.url!.startsWith("/basic/wiki")) return json({ query: { search: [{ title: "Ollama", snippet: "<span>Ollama</span> runs models" }, { title: "Large language model", snippet: "An <b>LLM</b>" }] } });
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
after(() => srv.close());

const secretsWith = (keys: Record<string, string> = {}) => {
  const s = new FileSecrets(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-search-")));
  for (const [k, v] of Object.entries(keys)) s.set(k, v);
  return s;
};
const cfg = (c: SearchConfig = {}): SearchConfig => ({ ...c, endpoints: { ollama: `${base}/ollama`, brave: `${base}/brave`, tavily: `${base}/tavily`, searxng: base, basic: `${base}/basic` } });

test("auto picks a keyed provider, then SearXNG, then basic", () => {
  assert.equal(resolveSearch({}, secretsWith()).provider, "basic");
  assert.equal(resolveSearch({ searxngUrl: "http://x" }, secretsWith()).provider, "searxng");
  assert.equal(resolveSearch({}, secretsWith({ "search.brave": "k" })).provider, "brave");
  assert.equal(resolveSearch({}, secretsWith({ "search.brave": "k", "search.ollama": "o" })).provider, "ollama");
  assert.throws(() => resolveSearch({ provider: "tavily" }, secretsWith()), /no API key is saved/);
});

test("each provider's response is normalized", async () => {
  const run = async (c: SearchConfig, keys: Record<string, string>) => (await webSearch("ollama", { config: cfg(c), secrets: secretsWith(keys) })).results[0];
  assert.deepEqual(await run({ provider: "ollama" }, { "search.ollama": "ok-key" }), { title: "Ollama", url: "https://ollama.com", snippet: "Run models" });
  assert.deepEqual(await run({ provider: "brave" }, { "search.brave": "bk" }), { title: "Brave result", url: "https://brave.com", snippet: "A browser" });
  assert.equal(seen.at(-1)!.headers["x-subscription-token"], "bk");
  assert.equal((await run({ provider: "tavily" }, { "search.tavily": "tk" })).url, "https://tavily.com");
  assert.equal(seen.at(-1)!.headers.authorization, "Bearer tk");
  assert.equal((await run({ provider: "searxng", searxngUrl: base }, {})).title, "SearX");
  assert.match(seen.at(-1)!.url, /format=json/);
});

test("basic mode merges instant answers and Wikipedia, deduplicated", async () => {
  const { provider, results } = await webSearch("ollama", { config: cfg(), secrets: secretsWith() });
  assert.equal(provider, "basic");
  assert.deepEqual(results.map((r) => r.url), [
    "https://en.wikipedia.org/wiki/Ollama",
    "https://duckduckgo.com/LM_Studio",
    "https://duckduckgo.com/llama.cpp",
    "https://en.wikipedia.org/wiki/Large_language_model",
  ]);
  assert.match(formatResults(provider, "ollama", results), /encyclopedia-style sources only/);
});

test("bad keys give an actionable error", async () => {
  await assert.rejects(webSearch("x", { config: cfg({ provider: "ollama" }), secrets: secretsWith({ "search.ollama": "wrong" }) }), /rejected the key \(HTTP 401\)/);
});
