import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { Provider } from "./types.js";

const cache = new Map<string, Provider>();

/** Resolve "provider/model-id" (model ids may themselves contain slashes, e.g. openrouter/meta-llama/llama-3). */
export function resolveModel(config: Config, ref: string | undefined): { provider: Provider; model: string } {
  const full = ref ?? config.defaultModel;
  if (!full) throw new Error("No model configured. Set `defaultModel` in slopbot.config.yaml or `model` on the bot.");
  const slash = full.indexOf("/");
  if (slash < 0) throw new Error(`Model "${full}" must look like provider/model-id`);
  const providerName = full.slice(0, slash);
  const model = full.slice(slash + 1);

  let provider = cache.get(providerName);
  if (!provider) {
    const pc = config.providers[providerName];
    if (!pc) {
      throw new Error(
        `Unknown provider "${providerName}". Configured: ${Object.keys(config.providers).join(", ") || "(none)"}`,
      );
    }
    provider =
      pc.type === "anthropic" ? new AnthropicProvider(providerName, pc) : new OpenAICompatProvider(providerName, pc);
    cache.set(providerName, provider);
  }
  return { provider, model };
}
