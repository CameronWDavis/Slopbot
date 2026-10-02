import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BotDef } from "../agent/bot.js";
import type { Config } from "../config.js";
import type { Store } from "../store/store.js";

export type Risk = "read" | "write" | "external" | "dangerous";

export interface ToolContext {
  bot: BotDef;
  config: Config;
  store: Store;
  /** Absolute, realpath'd sandbox roots. roots[0] is the bot's workspace. */
  roots: string[];
  sessionId: string;
}

export interface Tool {
  name: string;
  description: string;
  risk: Risk;
  parameters: Record<string, unknown>;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Resolve a user/model-supplied path and make sure it stays inside the sandbox.
 * Relative paths resolve against the workspace. Symlinks are followed before checking.
 */
export function safePath(ctx: ToolContext, p: string): string {
  const abs = path.resolve(ctx.roots[0], expandHome(String(p ?? ".")));
  // realpath the deepest existing ancestor so new files can still be created.
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  const ok = ctx.roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) {
    throw new Error(`Path "${p}" is outside this bot's allowed roots: ${ctx.roots.join(", ")}`);
  }
  return real;
}

/** Shorthand for a JSON-Schema object. */
export function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
