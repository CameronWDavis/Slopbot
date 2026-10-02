// Adapter for any OpenAI Chat Completions–compatible endpoint:
// OpenAI, Ollama, LM Studio, vLLM, llama.cpp server, Groq, OpenRouter, Together, ...
import {
  fromWireName,
  toWireName,
  type AssistantTurn,
  type ChatRequest,
  type Provider,
  type ProviderConfig,
} from "./types.js";

export class OpenAICompatProvider implements Provider {
  constructor(
    public name: string,
    private cfg: ProviderConfig,
  ) {}

  async chat(req: ChatRequest): Promise<AssistantTurn> {
    const baseUrl = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

    const messages: any[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const msg: any = { role: "assistant", content: m.content || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: toWireName(c.name), arguments: JSON.stringify(c.args) },
          }));
        }
        messages.push(msg);
      } else {
        messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      }
    }

    const body: any = { model: req.model, messages };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: toWireName(t.name), description: t.description, parameters: t.parameters },
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    const headers: Record<string, string> = { "content-type": "application/json", ...this.cfg.headers };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e: any) {
      const local = /localhost|127\.0\.0\.1/.test(baseUrl);
      throw new Error(
        `[${this.name}] can't reach ${baseUrl} (${e.cause?.code ?? e.message}).` +
          (local ? " Is your local model server running? e.g. `ollama serve` then `ollama pull " + req.model + "`" : ""),
      );
    }
    if (!res.ok) {
      throw new Error(`[${this.name}] HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data: any = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};

    const toolCalls = (msg.tool_calls ?? []).map((c: any, i: number) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: fromWireName(c.function.name),
      args: parseArgs(c.function.arguments),
    }));

    return {
      text: stripThinking(msg.content ?? ""),
      toolCalls,
      stopReason: choice?.finish_reason ?? "unknown",
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// Reasoning models served locally (Qwen3, DeepSeek-R1) often inline <think> blocks.
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
