// Native adapter for the Anthropic Messages API.
import {
  fromWireName,
  toWireName,
  type AssistantTurn,
  type ChatRequest,
  type Provider,
  type ProviderConfig,
} from "./types.js";

export class AnthropicProvider implements Provider {
  constructor(
    public name: string,
    private cfg: ProviderConfig,
  ) {}

  async chat(req: ChatRequest): Promise<AssistantTurn> {
    const baseUrl = (this.cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");

    // Anthropic wants consecutive tool results merged into one user message.
    const messages: any[] = [];
    for (const m of req.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: c.id, name: toWireName(c.name), input: c.args });
        }
        messages.push({ role: "assistant", content });
      } else {
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = messages[messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
          last.content.push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      }
    }

    const body: any = {
      model: req.model,
      system: req.system,
      messages,
      max_tokens: req.maxTokens ?? 8192,
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: toWireName(t.name),
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        ...this.cfg.headers,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`[${this.name}] HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data: any = await res.json();

    let text = "";
    const toolCalls = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: fromWireName(block.name), args: block.input ?? {} });
      }
    }
    return {
      text: text.trim(),
      toolCalls,
      stopReason: data.stop_reason ?? "unknown",
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
        : undefined,
    };
  }
}
