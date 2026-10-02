// The policy engine decides, for every tool call, whether it runs, needs approval, or is blocked.
import type { BotDef } from "../agent/bot.js";
import type { Config } from "../config.js";
import type { ToolCall } from "../providers/types.js";
import type { Risk } from "../tools/types.js";

export type Action = "allow" | "ask" | "deny";
export type Mode = "interactive" | "background";

export interface PolicyRule {
  /** Glob on tool name: "email.send", "fs.*", "*". */
  tool: string;
  action: Action;
  /** Rules don't loosen background-mode decisions unless this is true. */
  background?: boolean;
  reason?: string;
}

export interface Decision {
  action: Action;
  reason: string;
}

// Never allowed, whatever the rules say.
const HARD_DENY_SHELL = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME)(\s|$|\*)/i,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(shutdown|reboot|halt)\b/,
  /\bsudo\b/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bwget\b[^|]*\|\s*(ba|z)?sh\b/,
];

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };
const stricter = (a: Action, b: Action): Action => (RANK[a] >= RANK[b] ? a : b);

export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

function riskDefault(risk: Risk, mode: Mode): Action {
  if (risk === "read") return "allow";
  if (risk === "write") return mode === "interactive" ? "allow" : "ask";
  return "ask"; // external, dangerous
}

export function evaluate(
  config: Config,
  bot: BotDef,
  call: ToolCall,
  risk: Risk,
  mode: Mode,
  sessionAllow: Set<string> = new Set(),
): Decision {
  // 1. Hard rules.
  if (call.name === "shell.run") {
    const cmd = String(call.args.command ?? "");
    if (HARD_DENY_SHELL.some((re) => re.test(cmd))) {
      return { action: "deny", reason: "blocked by a built-in safety rule (destructive or privileged command)" };
    }
  }

  const base = riskDefault(risk, mode);

  // 2. Bot rules, then 3. global rules: first match wins.
  for (const [scope, rules] of [
    ["bot", bot.permissions],
    ["global", config.policy.rules],
  ] as const) {
    const rule = rules.find((r) => globMatch(r.tool, call.name));
    if (!rule) continue;
    let action = rule.action;
    // In background mode a rule can't loosen below the risk default unless it opts in.
    if (mode === "background" && !rule.background) action = stricter(action, base);
    return { action, reason: rule.reason ?? `${scope} rule "${rule.tool}: ${rule.action}"` };
  }

  // "Always allow for this session", granted at an interactive prompt.
  if (mode === "interactive" && sessionAllow.has(call.name)) {
    return { action: "allow", reason: "allowed for this session" };
  }

  // 4. Risk defaults.
  return { action: base, reason: `default for ${risk} tools in ${mode} mode` };
}
