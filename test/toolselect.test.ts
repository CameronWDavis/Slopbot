import assert from "node:assert/strict";
import { test } from "node:test";
import { rankTools, selectTools, toolBudget } from "../src/agent/toolselect.js";
import type { Tool } from "../src/tools/types.js";

const t = (name: string, description = ""): Tool => ({ name, description, risk: "read", parameters: {}, run: async () => "" });
const find = t("tools.find");

test("ranking prefers name matches, including the server name", () => {
  const tools = [t("mcp.github.list_issues", "List issues in a repo"), t("mcp.notion.create_page", "Create a page"), t("mcp.notion.search", "Search pages and databases")];
  assert.deepEqual(rankTools(tools, "make a new Notion page").map((x) => x.name), ["mcp.notion.create_page", "mcp.notion.search"]);
  assert.deepEqual(rankTools(tools, "what issues are open?").map((x) => x.name), ["mcp.github.list_issues"]);
  assert.deepEqual(rankTools(tools, "the and of"), []);
});

test("naming a server favors the tool whose own name fits, then read-only tools", () => {
  const kg = ["add_observations", "create_entities", "delete_entities", "open_nodes", "read_graph", "search_nodes"].map((n) =>
    Object.assign(t(`mcp.knowledge-graph.${n}`, n === "read_graph" ? "Read the entire knowledge graph" : `${n.replace("_", " ")} in the knowledge graph`), {
      risk: (/^(read|open|search)/.test(n) ? "read" : "external") as Tool["risk"],
    }),
  );
  const ranked = rankTools(kg, "What's in my knowledge graph?").map((x) => x.name.split(".")[2]);
  assert.equal(ranked[0], "read_graph");
  assert.deepEqual(ranked.slice(1, 3).sort(), ["open_nodes", "search_nodes"], "read-only tools win ties");
});

test("selection keeps built-ins and active tools, fills by relevance, respects the budget", () => {
  const core = [t("fs.read"), t("fs.write")];
  const extra = Array.from({ length: 30 }, (_, i) => t(`mcp.s.tool${i}`, i === 7 ? "send slack message" : "unrelated"));
  const all = [...core, ...extra];
  const sel = selectTools(all, new Set(["mcp.s.tool3"]), "post a slack message", 5, find);
  assert.deepEqual(sel.offered.map((x) => x.name), ["fs.read", "fs.write", "mcp.s.tool3", "mcp.s.tool7", "tools.find"]);
  assert.equal(sel.hidden, 28);
  assert.equal(selectTools(all.slice(0, 4), new Set(), "", 5, find).offered.length, 4, "under budget: unchanged");
});

test("auto budget: small for local models, larger for hosted, bot setting wins", () => {
  const config: any = { defaultModel: "ollama/q", providers: { ollama: { baseUrl: "http://localhost:11434/v1" }, openai: { baseUrl: "https://api.openai.com/v1" } }, maxTools: "auto" };
  const bot: any = {};
  assert.equal(toolBudget(config, bot), 20);
  assert.equal(toolBudget(config, { model: "openai/gpt" } as any), 64);
  assert.equal(toolBudget(config, { maxTools: 8 } as any), 8);
  assert.equal(toolBudget({ ...config, maxTools: 12 }, bot), 12);
});
