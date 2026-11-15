import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "../config.js";
import type { PolicyRule } from "../policy/policy.js";

export interface Schedule {
  name: string;
  cron: string;
  task: string;
  /** Where to send the final answer: email (config.smtp.to), telegram (the linked account), or nowhere. */
  notify?: "email" | "telegram" | "none";
}

export interface BotDef {
  name: string;
  description: string;
  model?: string;
  persona: string;
  tools: string[];
  workspace?: string;
  allowedPaths: string[];
  maxSteps: number;
  temperature?: number;
  /** Max tools offered to the model per step; extra connector tools are found via tools.find. */
  maxTools?: number;
  /** Sites this bot may fetch without asking (domain or subdomain match). */
  network?: { allow: string[] };
  /** Skills from the library this bot uses (in addition to ones assigned in the app). "*" = all. */
  skills?: string[];
  permissions: PolicyRule[];
  schedules: Schedule[];
  file: string;
  /** Made or edited by the user in the app (saved in their private data, not the app's bots). */
  custom?: boolean;
  /** A custom bot that replaces a built-in one with the same name. */
  overridesBuiltIn?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function parseBot(file: string): BotDef {
  const raw: any = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  const name = raw.name ?? path.basename(file).replace(/\.ya?ml$/, "");
  if (!NAME_RE.test(name)) throw new Error(`${file}: bot name "${name}" must match ${NAME_RE}`);
  if (!raw.persona) throw new Error(`${file}: "persona" is required`);
  return {
    name,
    description: raw.description ?? "",
    model: raw.model,
    persona: String(raw.persona),
    tools: raw.tools ?? ["memory.*", "fs.list", "fs.read"],
    workspace: raw.workspace,
    allowedPaths: raw.allowedPaths ?? [],
    maxSteps: raw.maxSteps ?? 20,
    temperature: raw.temperature,
    maxTools: typeof raw.maxTools === "number" ? raw.maxTools : undefined,
    network: { allow: Array.isArray(raw.network?.allow) ? raw.network.allow.map(String) : [] },
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    permissions: raw.permissions ?? [],
    schedules: (raw.schedules ?? []).map((s: any, i: number) => ({
      name: s.name ?? `schedule-${i + 1}`,
      cron: s.cron,
      task: s.task,
      notify: s.notify ?? "none",
    })),
    file,
  };
}

/** Bots you create or edit in the app: private per-user data, never the project folder or a build. */
export const userBotsDir = (config: Config) => path.join(config.dataDir, "bots");

function readDir(dir: string): BotDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: BotDef[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    try {
      out.push(parseBot(path.join(dir, f)));
    } catch (e: any) {
      console.error(`slopbot: skipping ${f}: ${e.message}`); // one broken file shouldn't hide every bot
    }
  }
  return out;
}

/** Built-in bots (bots/) plus your own (data/bots/); yours replace a built-in with the same name. */
export function loadBots(config: Config): BotDef[] {
  const builtIn = readDir(config.botsDir);
  const mine = config.dataDir ? readDir(userBotsDir(config)) : [];
  const byName = new Map(builtIn.map((b) => [b.name, b]));
  for (const b of mine) byName.set(b.name, { ...b, custom: true, overridesBuiltIn: byName.has(b.name) });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadBot(config: Config, name: string): BotDef {
  const bot = loadBots(config).find((b) => b.name === name);
  if (!bot) {
    const names = loadBots(config).map((b) => b.name);
    throw new Error(`No bot named "${name}". Available: ${names.join(", ") || "(none, run `slopbot init`)"}`);
  }
  return bot;
}
