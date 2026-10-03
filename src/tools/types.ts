import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BotDef } from "../agent/bot.js";
import type { Config } from "../config.js";
import type { Store } from "../store/store.js";
import type { Vault } from "../vault/vault.js";

export type Risk = "read" | "write" | "external" | "dangerous";

export interface ToolContext {
  bot: BotDef;
  config: Config;
  store: Store;
  /** Absolute, realpath'd sandbox roots. roots[0] is the bot's workspace. */
  roots: string[];
  sessionId: string;
  /** The encrypted credential vault (secrets are injected by tools, never returned to the model). */
  vault?: Vault;
}

export interface Tool {
  name: string;
  description: string;
  risk: Risk;
  /** Risk can depend on the arguments and the bot (e.g. which site a request goes to). Defaults to `risk`. */
  riskFor?: (args: any, ctx: { bot: BotDef; config: Config }) => Risk;
  /**
   * What "Always this session" remembers. Defaults to the tool name; http.fetch narrows it to one
   * site so approving one site doesn't approve the whole internet.
   */
  approvalKey?: (args: any) => string;
  parameters: Record<string, unknown>;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Resolve a user/model-supplied path and make sure it stays inside the sandbox.
 * Relative paths resolve against the workspace. Symlinks are followed before checking.
 */
export function safePath(ctx: ToolContext, p: string): string {
  const rel = expandHome(String(p ?? "."));
  // Relative paths resolve against the workspace, but fall back to the project dir
  // ("examples/foo.csv") when that's where the file actually is.
  const candidates = [path.resolve(ctx.roots[0], rel), path.resolve(ctx.config.rootDir, rel)];
  const abs = candidates.find((c) => fs.existsSync(c) && inRoots(ctx, fs.realpathSync(c))) ?? candidates[0];
  // realpath the deepest existing ancestor so new files can still be created.
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  if (!inRoots(ctx, real)) {
    throw new Error(`Path "${p}" is outside this bot's allowed roots: ${ctx.roots.join(", ")}`);
  }
  return real;
}

const inRoots = (ctx: ToolContext, real: string) => ctx.roots.some((r) => real === r || real.startsWith(r + path.sep));

/** Shorthand for a JSON-Schema object. */
export function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
