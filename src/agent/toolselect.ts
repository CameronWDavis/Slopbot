// Small local models get confused by long tool lists. When a bot has more tools than its budget,
// offer its own built-in tools plus the connector (MCP) tools most relevant to the request, and a
// `tools.find` tool to discover the rest on demand.
import type { Config } from "../config.js";
import { obj, type Tool } from "../tools/types.js";
import type { BotDef } from "./bot.js";

const STOP = new Set("a an the and or of to in on for with my me i you it is are be do can please what how from this that".split(" "));

const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "") || w;

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/**
 * Keyword relevance per query term (best match wins): the tool's own name ×3, its server's name ×1,
 * its description ×1. Mentioning a server ("my knowledge graph") then favors the tool whose own
 * name fits ("read_graph") instead of tying every tool on that server.
 */
export function scoreTool(tool: Tool, query: string): number {
  const q = new Set(tokens(query));
  if (!q.size) return 0;
  const m = tool.name.match(/^mcp\.([^.]+)\.(.+)$/);
  const own = new Set(tokens((m ? m[2] : tool.name).replace(/[._-]/g, " ")));
  const server = new Set(m ? tokens(m[1].replace(/[_-]/g, " ")) : []);
  const desc = new Set(tokens(tool.description));
  let score = 0;
  for (const t of q) score += own.has(t) ? 3 : server.has(t) || desc.has(t) ? 1 : 0;
  for (const t of q) if (desc.has(t) && (own.has(t) || server.has(t))) score += 0.5;
  return score;
}

const RISK_ORDER = { read: 0, write: 1, external: 2, dangerous: 3 } as const;

export function rankTools(tools: Tool[], query: string): Tool[] {
  return tools
    .map((t, i) => ({ t, i, s: scoreTool(t, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || RISK_ORDER[a.t.risk] - RISK_ORDER[b.t.risk] || a.i - b.i)
    .map((x) => x.t);
}

const isLocal = (config: Config, model?: string) => {
  const provider = (model ?? config.defaultModel ?? "").split("/")[0];
  return /localhost|127\.0\.0\.1|\[::1\]/.test(config.providers[provider]?.baseUrl ?? "");
};

/** Tool budget: bot setting, then config, then auto (20 for local models, 64 for hosted). */
export function toolBudget(config: Config, bot: BotDef): number {
  const v = bot.maxTools ?? config.maxTools ?? "auto";
  if (typeof v === "number" && v > 0) return v;
  return isLocal(config, bot.model) ? 20 : 64;
}

export interface Selection {
  offered: Tool[];
  hidden: number;
}

/**
 * Choose which tools to send to the model this step.
 * - built-in tools (the bot's own list) are always offered
 * - connector tools the bot already found or used stay offered (`active`)
 * - remaining slots go to the connector tools most relevant to `query`
 */
export function selectTools(all: Tool[], active: Set<string>, query: string, max: number, findTool: Tool): Selection {
  if (all.length <= max) return { offered: all, hidden: 0 };
  const core = all.filter((t) => !t.name.startsWith("mcp."));
  const extra = all.filter((t) => t.name.startsWith("mcp."));
  const keep = extra.filter((t) => active.has(t.name));
  let slots = Math.max(0, max - core.length - 1 - keep.length);
  const picked = new Set(keep.map((t) => t.name));
  for (const t of rankTools(extra.filter((t) => !picked.has(t.name)), query)) {
    if (slots-- <= 0) break;
    picked.add(t.name);
  }
  const offered = [...core, ...extra.filter((t) => picked.has(t.name)), findTool];
  return { offered, hidden: extra.length - picked.size };
}

/** The discovery tool. Found tools are added to `active` so they're offered from the next step on. */
export function makeFindTool(getHidden: () => Tool[], active: Set<string>, hiddenCount: () => number): Tool {
  return {
    name: "tools.find",
    description:
      "Search for more tools from the user's connected apps (Notion, GitHub, files, browser, …) that aren't in your list yet. " +
      "Describe what you need in a few keywords. Matching tools become available on your next step.",
    risk: "read",
    parameters: obj({ query: { type: "string", description: "Keywords, e.g. 'create notion page' or 'github issues'" } }, ["query"]),
    async run({ query }) {
      const hits = rankTools(getHidden(), String(query ?? "")).slice(0, 8);
      if (!hits.length) return `No connected tools match "${query}". ${hiddenCount()} other tools exist; try different keywords.`;
      for (const t of hits) active.add(t.name);
      return `Now available (use them on your next step):\n${hits.map((t) => `- ${t.name}: ${t.description.slice(0, 160)}`).join("\n")}`;
    },
  };
}
