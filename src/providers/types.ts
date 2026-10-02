// Neutral message format shared by every provider adapter.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface Provider {
  name: string;
  chat(req: ChatRequest): Promise<AssistantTurn>;
}

export interface ProviderConfig {
  type: "openai" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

// Model tool names may only contain [a-zA-Z0-9_-], so "fs.read" goes over the wire as "fs__read".
export const toWireName = (name: string) => name.replace(/\./g, "__");
export const fromWireName = (name: string) => name.replace(/__/g, ".");
