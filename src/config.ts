import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
import type { SearchConfig } from "./search/search.js";
import type { PolicyRule } from "./policy/policy.js";
import { MissingSecretError, openSecretStore, resolveSecretRefs } from "./secrets.js";

export interface SmtpConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Default recipient for reports / notifications ("me"). */
  to?: string;
}

export interface Config {
  rootDir: string;
  dataDir: string;
  botsDir: string;
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  smtp?: SmtpConfig;
  policy: { rules: PolicyRule[] };
  maxToolOutputChars: number;
  /** Web search settings (keys live in the secret store as search.<provider>). */
  search?: SearchConfig;
  /** Default tool budget per step: a number, or "auto" (20 for local models, 64 for hosted). */
  maxTools?: number | "auto";
}

export const CONFIG_FILE = "slopbot.config.yaml";

/** Minimal .env loader so users don't need dotenv. Existing env vars win. */
function loadDotEnv(dir: string) {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

/**
 * Replace ${VAR} / ${VAR:-default} (environment) and ${secret:NAME} (Keychain / secret store) in
 * every string value. A missing secret becomes "" with a warning, so one bad key doesn't stop the app.
 */
function interpolate(value: unknown, secret: (s: string) => string): unknown {
  if (typeof value === "string") {
    return secret(value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, def) => process.env[name] ?? def ?? ""));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, secret)]));
  }
  return value;
}

export function loadConfig(rootDir = process.env.SLOPBOT_HOME ? path.resolve(process.env.SLOPBOT_HOME) : process.cwd()): Config {
  loadDotEnv(rootDir);
  const file = path.join(rootDir, CONFIG_FILE);
  const parsed: any = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) : {};
  const dataDir = path.resolve(rootDir, process.env.SLOPBOT_DATA ?? parsed.dataDir ?? "data");
  const secret = (s: string) => {
    if (!s.includes("${secret:")) return s;
    try {
      return resolveSecretRefs(s, openSecretStore(dataDir));
    } catch (e) {
      if (!(e instanceof MissingSecretError)) throw e;
      console.error(`slopbot: ${e.message.split(".")[0]}. Store it with: slopbot secret set ${e.key}`);
      return s.replace(/\$\{secret:[^}]+\}/g, "");
    }
  };
  const raw: any = interpolate(parsed, secret);

  const providers: Record<string, ProviderConfig> = raw.providers ?? {};
  // Zero-config local default: if nothing is configured, assume Ollama.
  if (Object.keys(providers).length === 0) {
    providers.ollama = { type: "openai", baseUrl: "http://localhost:11434/v1" };
  }
  // Drop empty API keys so an unset env var doesn't send "Bearer ".
  for (const p of Object.values(providers)) if (!p.apiKey) delete p.apiKey;

  const smtp = raw.smtp?.host ? (raw.smtp as SmtpConfig) : undefined;
  if (smtp?.port) smtp.port = Number(smtp.port);

  return {
    rootDir,
    dataDir,
    botsDir: path.resolve(rootDir, raw.botsDir ?? "bots"),
    defaultModel: process.env.SLOPBOT_MODEL ?? raw.defaultModel ?? "ollama/qwen3:8b",
    providers,
    smtp,
    policy: { rules: raw.policy?.rules ?? [] },
    maxToolOutputChars: raw.maxToolOutputChars ?? 12_000,
    maxTools: typeof raw.maxTools === "number" ? raw.maxTools : "auto",
    search: raw.search,
  };
}
