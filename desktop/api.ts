// The typed surface the renderer gets via contextBridge (window.slopbot).

export interface BotSummary {
  name: string;
  description: string;
  model: string;
  tools: string[];
  schedules: { name: string; cron: string; task: string }[];
}

export interface ApprovalRequest {
  id: string;
  bot: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface QueuedApproval {
  id: string;
  bot: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export type AgentEvent =
  | { type: "run.start"; bot: string }
  | { type: "text"; bot: string; text: string }
  | { type: "tool.call"; bot: string; id: string; name: string; args: Record<string, unknown>; decision: string; reason: string }
  | { type: "tool.result"; bot: string; id: string; name: string; ok: boolean; result: string }
  | { type: "run.end"; bot: string; text: string; steps: number; tokens: number; pending: string[] }
  | { type: "run.error"; bot: string; error: string };

export interface ActivityItem {
  ts: string;
  bot: string;
  type: string;
  summary: string;
}

export type Risk = "read" | "write" | "external" | "dangerous";

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bots?: string[];
  enabled?: boolean;
  description?: string;
}

export interface McpToolInfo {
  name: string;
  slopName: string;
  description: string;
  risk: Risk;
}

export interface McpServerStatus {
  name: string;
  def: McpServerDef;
  state: "disabled" | "idle" | "connecting" | "connected" | "error" | "needs_auth";
  error?: string;
  oauth?: "signed_in" | "signed_out";
  tools: McpToolInfo[];
}

export interface SlopbotApi {
  info(): Promise<{ dataDir: string; rootDir: string; homeDir: string; defaultModel: string; version: string }>;
  listBots(): Promise<BotSummary[]>;
  listModels(): Promise<string[]>;
  send(bot: string, text: string, model?: string): Promise<void>;
  reset(bot: string): Promise<void>;
  answerApproval(id: string, answer: "yes" | "no" | "always"): Promise<void>;
  listApprovals(): Promise<QueuedApproval[]>;
  resolveApproval(id: string, approve: boolean): Promise<string>;
  activity(limit?: number): Promise<ActivityItem[]>;
  memory(bot: string): Promise<{ id: string; text: string }[]>;
  openDataDir(): Promise<void>;
  mcpList(): Promise<McpServerStatus[]>;
  mcpConnect(name: string): Promise<McpServerStatus>;
  mcpTest(name: string, def: McpServerDef): Promise<McpToolInfo[]>;
  mcpSave(name: string, def: McpServerDef, previousName?: string): Promise<void>;
  mcpRemove(name: string): Promise<void>;
  mcpImport(json: string, bots: string[]): Promise<string[]>;
  mcpSignIn(name: string): Promise<McpServerStatus>;
  mcpSignOut(name: string): Promise<void>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void;
}
