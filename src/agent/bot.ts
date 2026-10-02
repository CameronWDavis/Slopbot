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
  permissions: PolicyRule[];
  schedules: Schedule[];
  file: string;
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

export function loadBots(config: Config): BotDef[] {
  if (!fs.existsSync(config.botsDir)) return [];
  return fs
    .readdirSync(config.botsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseBot(path.join(config.botsDir, f)));
}

export function loadBot(config: Config, name: string): BotDef {
  const bot = loadBots(config).find((b) => b.name === name);
  if (!bot) {
    const names = loadBots(config).map((b) => b.name);
    throw new Error(`No bot named "${name}". Available: ${names.join(", ") || "(none, run `slopbot init`)"}`);
  }
  return bot;
}
