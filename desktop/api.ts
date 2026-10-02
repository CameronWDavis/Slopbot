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

export interface SlopbotApi {
  info(): Promise<{ dataDir: string; rootDir: string; defaultModel: string; version: string }>;
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
  onEvent(cb: (e: AgentEvent) => void): () => void;
  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void;
}
