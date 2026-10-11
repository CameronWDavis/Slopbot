import { globMatch } from "../policy/policy.js";
import { emailTools } from "./email.js";
import { financeTools } from "./finance.js";
import { fsTools } from "./fs.js";
import { httpTools } from "./http.js";
import { memoryTools } from "./memory.js";
import { shellTools } from "./shell.js";
import type { Tool } from "./types.js";

export const ALL_TOOLS: Tool[] = [...fsTools, ...shellTools, ...httpTools, ...memoryTools, ...emailTools, ...financeTools];

const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Tools that only exist in some processes (e.g. browser.* in the desktop app). Same names replace earlier ones. */
export function registerTools(tools: Tool[]) {
  for (const t of tools) {
    const i = ALL_TOOLS.findIndex((x) => x.name === t.name);
    if (i >= 0) ALL_TOOLS[i] = t;
    else ALL_TOOLS.push(t);
    byName.set(t.name, t);
  }
}

export const getTool = (name: string) => byName.get(name);

/** Expand a bot's tool globs ("fs.*", "email.send") into concrete tools. */
export function toolsFor(patterns: string[]): Tool[] {
  return ALL_TOOLS.filter((t) => patterns.some((p) => globMatch(p, t.name)));
}
