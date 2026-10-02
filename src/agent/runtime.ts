// The agent loop: think → call tools (through the policy engine) → observe → repeat.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { evaluate, type Decision, type Mode } from "../policy/policy.js";
import { resolveModel } from "../providers/index.js";
import type { Message, ToolCall, Usage } from "../providers/types.js";
import { newId, type Store } from "../store/store.js";
import { getTool, toolsFor } from "../tools/registry.js";
import { expandHome, type Tool, type ToolContext } from "../tools/types.js";
import type { McpManager } from "../mcp/client.js";
import type { BotDef } from "./bot.js";
import { buildSystemPrompt } from "./prompt.js";
import { makeFindTool, selectTools, toolBudget } from "./toolselect.js";

export type ApprovalAnswer = "yes" | "no" | "always";

export interface AgentHooks {
  /** Interactive approval. If absent, "ask" decisions are queued for later. */
  approve?: (call: ToolCall, decision: Decision) => Promise<ApprovalAnswer>;
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCall, decision: Decision) => void;
  onToolResult?: (call: ToolCall, result: string, ok: boolean) => void;
}

export interface RunResult {
  text: string;
  steps: number;
  usage: Usage;
  pendingApprovals: string[];
}

export function resolveRoots(config: Config, store: Store, bot: BotDef): string[] {
  const workspace = path.resolve(config.rootDir, expandHome(bot.workspace ?? store.workspaceDir(bot.name)));
  fs.mkdirSync(workspace, { recursive: true });
  const roots = [workspace, ...bot.allowedPaths.map((p) => path.resolve(config.rootDir, expandHome(p)))];
  return roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
}

export function makeToolContext(config: Config, store: Store, bot: BotDef, sessionId: string): ToolContext {
  return { bot, config, store, roots: resolveRoots(config, store, bot), sessionId };
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export async function runTool(tool: Tool, call: ToolCall, ctx: ToolContext): Promise<{ result: string; ok: boolean }> {
  try {
    return { result: await tool.run(call.args, ctx), ok: true };
  } catch (e: any) {
    return { result: `Error: ${e?.message ?? String(e)}`, ok: false };
  }
}

export class Agent {
  readonly sessionId = newId("s_");
  readonly messages: Message[] = [];
  private sessionAllow = new Set<string>();
  private tools: Tool[];
  private ctx: ToolContext;
  /** Connector tools this conversation found (tools.find) or used; they stay offered. */
  private activeTools = new Set<string>();
  private offered: Tool[] = [];
  private findTool: Tool;

  constructor(
    private config: Config,
    private store: Store,
    public bot: BotDef,
    private mode: Mode = "interactive",
    private hooks: AgentHooks = {},
    private mcp?: McpManager,
  ) {
    this.tools = toolsFor(bot.tools);
    this.ctx = makeToolContext(config, store, bot, this.sessionId);
    this.findTool = makeFindTool(
      () => this.tools.filter((t) => !this.offered.includes(t)),
      this.activeTools,
      () => this.tools.filter((t) => !this.offered.includes(t)).length,
    );
  }

  /** MCP tools are attached on the first message (connecting to servers is async). */
  private mcpLoaded = false;
  private async loadMcpTools() {
    if (this.mcpLoaded || !this.mcp) return;
    this.mcpLoaded = true;
    const { tools, errors } = await this.mcp.toolsForBot(this.bot.name);
    this.tools.push(...tools);
    for (const [server, error] of Object.entries(errors)) {
      this.store.audit({ bot: this.bot.name, session: this.sessionId, type: "error", error: `MCP server "${server}" unavailable: ${error}` });
    }
  }

  async send(userText: string): Promise<RunResult> {
    await this.loadMcpTools();
    const { provider, model } = resolveModel(this.config, this.bot.model);
    const { bot, store, sessionId } = this;
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const pendingApprovals: string[] = [];

    this.messages.push({ role: "user", content: userText });
    store.audit({ bot: bot.name, session: sessionId, type: "run.start", mode: this.mode, model: `${provider.name}/${model}`, input: userText.slice(0, 500) });

    let finalText = "";
    let step = 0;
    try {
      for (step = 1; step <= bot.maxSteps; step++) {
        const { offered, hidden } = selectTools(this.tools, this.activeTools, userText, toolBudget(this.config, bot), this.findTool);
        this.offered = offered;
        const system = buildSystemPrompt({
          bot,
          tools: offered,
          hiddenTools: hidden,
          memory: store.readMemory(bot.name),
          roots: this.ctx.roots,
          mode: this.mode,
        });
        const turn = await provider.chat({
          model,
          system,
          messages: this.messages,
          tools: offered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
          temperature: bot.temperature,
        });
        if (turn.usage) {
          usage.inputTokens += turn.usage.inputTokens;
          usage.outputTokens += turn.usage.outputTokens;
        }
        this.messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
        store.audit({ bot: bot.name, session: sessionId, type: "model", step, text: turn.text.slice(0, 1000), toolCalls: turn.toolCalls.map((c) => c.name), usage: turn.usage });

        if (turn.text) this.hooks.onText?.(turn.text);
        if (!turn.toolCalls.length) {
          finalText = turn.text;
          break;
        }

        for (const call of turn.toolCalls) {
          const content = await this.handleCall(call, pendingApprovals);
          this.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        }
        store.saveSession(bot.name, sessionId, this.messages);
      }
      if (step > bot.maxSteps) {
        finalText ||= `(Stopped after reaching maxSteps=${bot.maxSteps}.)`;
      }
    } catch (e: any) {
      store.audit({ bot: bot.name, session: sessionId, type: "error", error: e?.message ?? String(e) });
      store.saveSession(bot.name, sessionId, this.messages);
      throw e;
    }

    store.saveSession(bot.name, sessionId, this.messages);
    store.audit({ bot: bot.name, session: sessionId, type: "run.end", steps: step, usage, pendingApprovals });
    return { text: finalText, steps: step, usage, pendingApprovals };
  }

  private async handleCall(call: ToolCall, pending: string[]): Promise<string> {
    const { bot, store, sessionId } = this;
    // Any of the bot's tools may run even if it wasn't offered this step (e.g. named by tools.find).
    const tool = call.name === this.findTool.name && this.offered.includes(this.findTool) ? this.findTool : this.tools.find((t) => t.name === call.name);
    if (tool?.name.startsWith("mcp.")) this.activeTools.add(tool.name);
    if (!tool) {
      this.hooks.onToolCall?.(call, { action: "deny", reason: "not available to this bot" });
      return `Error: tool "${call.name}" is not available to you. Available: ${this.tools.map((t) => t.name).join(", ")}`;
    }

    let decision = evaluate(this.config, bot, call, tool.risk, this.mode, this.sessionAllow);
    this.hooks.onToolCall?.(call, decision);

    if (decision.action === "ask") {
      if (this.hooks.approve) {
        const answer = await this.hooks.approve(call, decision);
        if (answer === "always") this.sessionAllow.add(call.name);
        decision = answer === "no" ? { action: "deny", reason: "user declined" } : { action: "allow", reason: "user approved" };
        store.audit({ bot: bot.name, session: sessionId, type: "approval", tool: call.name, args: call.args, answer });
      } else {
        const a = store.addApproval({ bot: bot.name, session: sessionId, call, reason: decision.reason });
        pending.push(a.id);
        store.audit({ bot: bot.name, session: sessionId, type: "approval", tool: call.name, args: call.args, queued: a.id });
        return `PENDING APPROVAL (${a.id}): this ${call.name} call has been queued for the user to review. It has NOT run. Don't retry it; continue with other work and mention it in your summary.`;
      }
    }

    if (decision.action === "deny") {
      store.audit({ bot: bot.name, session: sessionId, type: "tool", tool: call.name, args: call.args, decision });
      return `BLOCKED: ${call.name} was not run (${decision.reason}).`;
    }

    const { result, ok } = await runTool(tool, call, this.ctx);
    this.hooks.onToolResult?.(call, result, ok);
    store.audit({ bot: bot.name, session: sessionId, type: "tool", tool: call.name, args: call.args, decision, ok, result: result.slice(0, 300) });
    return truncate(result, this.config.maxToolOutputChars);
  }
}

/** Execute a previously queued tool call exactly as it was proposed. */
export async function executeApproval(config: Config, store: Store, bot: BotDef, approvalId: string, mcp?: McpManager): Promise<string> {
  const a = store.listApprovals().find((x) => x.id === approvalId);
  if (!a) throw new Error(`No approval ${approvalId}`);
  if (a.status !== "pending") throw new Error(`Approval ${approvalId} is already ${a.status}`);
  const tool = getTool(a.call.name) ?? (a.call.name.startsWith("mcp.") ? await mcp?.findTool(a.call.name) : undefined);
  if (!tool) throw new Error(`Tool ${a.call.name} no longer exists`);
  const ctx = makeToolContext(config, store, bot, a.session);
  const { result, ok } = await runTool(tool, a.call, ctx);
  store.updateApproval(a.id, { status: "approved", resolvedAt: new Date().toISOString(), result });
  store.audit({ bot: bot.name, session: a.session, type: "tool", tool: a.call.name, args: a.call.args, decision: { action: "allow", reason: `approved ${a.id}` }, ok, result: result.slice(0, 300) });
  return result;
}
