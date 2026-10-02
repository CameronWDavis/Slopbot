// SlopBot as an MCP server: lets Claude Code (or any MCP client) list bots, hand them tasks, and
// read results, activity and memory.
//
// Safety: every task runs in BACKGROUND mode. Anything that writes files, runs commands or sends
// email is queued for a human to approve in the desktop app or with `slopbot approve`. This server
// deliberately has no approve tool, so the MCP client can't approve its own requests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBot, loadBots } from "../agent/bot.js";
import { Agent, type AgentHooks } from "../agent/runtime.js";
import type { Config } from "../config.js";
import type { McpManager } from "./client.js";
import type { Store } from "../store/store.js";
import { toolsFor } from "../tools/registry.js";
import { runScheduled } from "../scheduler/scheduler.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

const APPROVAL_NOTE =
  "These actions were NOT performed. A human must approve them in the SlopBot desktop app (Approvals) or with `npm run slopbot approve <id>`.";

export function createMcpServer(config: Config, store: Store, version = "0.1.0", mcp?: McpManager): McpServer {
  const server = new McpServer(
    { name: "slopbot", version },
    {
      instructions:
        "SlopBot runs the user's personal agents (bots) locally. Use list_bots to see them, ask_bot to give one a task. " +
        "Bots run unattended here, so side-effecting actions are queued for the user's approval; tell the user when that happens.",
    },
  );

  // One running conversation per bot, so follow-up messages keep context.
  const conversations = new Map<string, { agent: Agent; model?: string; actions: string[] }>();
  const running = new Set<string>();

  server.registerTool(
    "list_bots",
    {
      title: "List bots",
      description: "List the user's SlopBot bots with their description, model, tools, and schedules.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const bots = loadBots(config).map((b) => ({
        name: b.name,
        description: b.description,
        model: b.model ?? config.defaultModel,
        tools: toolsFor(b.tools).map((t) => t.name),
        schedules: b.schedules.map(({ name, cron }) => ({ name, cron })),
      }));
      return text(JSON.stringify(bots, null, 2));
    },
  );

  server.registerTool(
    "ask_bot",
    {
      title: "Ask a bot",
      description:
        "Send a message or task to a bot and wait for its answer. The bot uses its own tools (finance, files, web, memory…). " +
        "Runs unattended: file writes, shell commands, and emails are queued for the user's approval rather than performed. " +
        "Follow-ups continue the same conversation unless new_conversation is true.",
      inputSchema: {
        bot: z.string().describe("Bot name, e.g. 'ledger'"),
        message: z.string().describe("What you want the bot to do"),
        model: z.string().optional().describe("Override the model for this conversation, as provider/model-id"),
        new_conversation: z.boolean().optional().describe("Start fresh instead of continuing"),
      },
    },
    async ({ bot: botName, message, model, new_conversation }) => {
      if (running.has(botName)) return fail(`${botName} is still working on a previous task. Try again shortly.`);
      let bot;
      try {
        bot = loadBot(config, botName);
      } catch (e: any) {
        return fail(e.message);
      }

      let conv = conversations.get(botName);
      if (!conv || new_conversation || conv.model !== model) {
        if (model) bot.model = model;
        const actions: string[] = [];
        const hooks: AgentHooks = {
          onToolCall: (call, d) => actions.push(`${call.name} ${JSON.stringify(call.args).slice(0, 160)} → ${d.action}`),
          onToolResult: (_call, _result, ok) => {
            if (!ok) actions[actions.length - 1] += " (failed)";
          },
        };
        conv = { agent: new Agent(config, store, bot, "background", hooks, mcp), model, actions };
        conversations.set(botName, conv);
      }
      const { actions } = conv;
      actions.length = 0;

      running.add(botName);
      try {
        const res = await conv.agent.send(message);
        const parts = [res.text || "(no reply)"];
        if (actions.length) parts.push(`\n---\nActions taken (${res.steps} steps):\n- ${actions.join("\n- ")}`);
        if (res.pendingApprovals.length) {
          parts.push(`\nAwaiting human approval: ${res.pendingApprovals.join(", ")}\n${APPROVAL_NOTE}`);
        }
        return text(parts.join("\n"));
      } catch (e: any) {
        return fail(`${botName} failed: ${e?.message ?? e}`);
      } finally {
        running.delete(botName);
      }
    },
  );

  server.registerTool(
    "run_schedule",
    {
      title: "Run a bot's scheduled task now",
      description: "Trigger one of a bot's scheduled tasks immediately (e.g. ledger's weekly-report) instead of waiting for its cron time.",
      inputSchema: {
        bot: z.string(),
        schedule: z.string().optional().describe("Schedule name; defaults to the bot's first schedule"),
      },
    },
    async ({ bot: botName, schedule }) => {
      try {
        const bot = loadBot(config, botName);
        const s = schedule ? bot.schedules.find((x) => x.name === schedule) : bot.schedules[0];
        if (!s) return fail(`${botName} has no schedule${schedule ? ` named ${schedule}` : "s"}.`);
        const res = await runScheduled(config, store, bot, s, () => {}, mcp);
        if (!res) return fail(`${botName}/${s.name} failed; see get_activity.`);
        const pending = res.pendingApprovals.length ? `\n\nAwaiting human approval: ${res.pendingApprovals.join(", ")}\n${APPROVAL_NOTE}` : "";
        return text(res.text + pending);
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description: "Show actions bots have queued that are waiting for the user's approval. (Approving is human-only.)",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const pending = store.listApprovals().filter((a) => a.status === "pending");
      if (!pending.length) return text("No pending approvals.");
      return text(
        JSON.stringify(
          pending.map((a) => ({ id: a.id, bot: a.bot, tool: a.call.name, args: a.call.args, reason: a.reason, createdAt: a.createdAt })),
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity log",
      description: "Recent audit-log events: runs, tool calls, approvals, errors.",
      inputSchema: {
        bot: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ bot, limit }) => text(store.readAudit({ bot, limit: limit ?? 40 }).map((e) => JSON.stringify(e)).join("\n") || "No activity."),
  );

  server.registerTool(
    "get_memory",
    {
      title: "Get bot memory",
      description: "What a bot has remembered about the user (preferences, budgets, goals).",
      inputSchema: { bot: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ bot }) => {
      const notes = store.readMemory(bot);
      return text(notes.length ? notes.map((n) => `[${n.id}] ${n.text}`).join("\n") : `${bot} doesn't remember anything yet.`);
    },
  );

  return server;
}
