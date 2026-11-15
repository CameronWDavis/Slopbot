// Creating and editing bots from the app. Your bots are saved as YAML in <data>/bots/ (private,
// per user). Editing a built-in bot saves your own copy that replaces it; deleting that copy brings
// the built-in back. Settings the editor doesn't show (permissions, maxTools, …) are kept.
import { Cron } from "croner";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Config } from "../config.js";
import { ALL_TOOLS } from "../tools/registry.js";
import { globMatch } from "../policy/policy.js";
import { loadBots, userBotsDir, type BotDef } from "./bot.js";

export const BOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface BotDraft {
  name: string;
  description: string;
  persona: string;
  /** provider/model, or empty for the default model. */
  model?: string;
  /** Tool names or globs ("fs.*"). */
  tools: string[];
  /** Extra folders the bot may read and write. */
  allowedPaths: string[];
  /** Sites it may fetch without asking. */
  sites: string[];
  maxSteps?: number;
  temperature?: number;
  schedules: { name: string; cron: string; task: string; notify: "email" | "telegram" | "none" }[];
  /** The bot's name before this edit (renames). */
  previousName?: string;
}

/** What the editor shows for an existing bot. */
export function botDraft(b: BotDef): BotDraft & { custom: boolean; overridesBuiltIn: boolean } {
  return {
    name: b.name,
    description: b.description,
    persona: b.persona,
    model: b.model ?? "",
    tools: b.tools,
    allowedPaths: b.allowedPaths,
    sites: b.network?.allow ?? [],
    maxSteps: b.maxSteps,
    temperature: b.temperature,
    schedules: b.schedules.map((s) => ({ name: s.name, cron: s.cron, task: s.task, notify: s.notify ?? "none" })),
    custom: !!b.custom,
    overridesBuiltIn: !!b.overridesBuiltIn,
  };
}

const clean = (v: unknown, max = 200) =>
  (Array.isArray(v) ? v : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max);

function validate(d: BotDraft) {
  const name = String(d.name ?? "").trim().toLowerCase();
  if (!BOT_NAME_RE.test(name)) throw new Error("Bot name: lowercase letters, numbers, - and _ (up to 40), e.g. gym-coach");
  const persona = String(d.persona ?? "").trim();
  if (!persona) throw new Error("Write the bot's instructions (who it is and how it should work)");
  if (persona.length > 20_000) throw new Error("The instructions are too long (20,000 characters max)");
  const tools = [...new Set(clean(d.tools))];
  for (const t of tools) {
    if (!/^[a-z*][\w.*-]*$/i.test(t)) throw new Error(`"${t}" isn't a tool name`);
    if (!t.startsWith("mcp.") && !ALL_TOOLS.some((x) => globMatch(t, x.name))) throw new Error(`No tool matches "${t}"`);
  }
  const model = String(d.model ?? "").trim();
  if (model && !/^[\w.-]+\/\S+$/.test(model)) throw new Error("Model must look like provider/model, e.g. ollama/qwen3:8b");
  const maxSteps = d.maxSteps === undefined || (d.maxSteps as any) === "" ? undefined : Math.round(Number(d.maxSteps));
  if (maxSteps !== undefined && !(maxSteps >= 1 && maxSteps <= 100)) throw new Error("Max steps must be between 1 and 100");
  const temperature = d.temperature === undefined || (d.temperature as any) === "" ? undefined : Number(d.temperature);
  if (temperature !== undefined && !(temperature >= 0 && temperature <= 2)) throw new Error("Temperature must be between 0 and 2");
  const sites = clean(d.sites, 50).map((s) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  for (const s of sites) if (!/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new Error(`"${s}" isn't a website name (e.g. wikipedia.org)`);
  const names = new Set<string>();
  const schedules = (Array.isArray(d.schedules) ? d.schedules : []).slice(0, 20).map((s, i) => {
    const sName = String(s.name || `schedule-${i + 1}`).trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[\w-]{1,40}$/.test(sName)) throw new Error(`Schedule name "${s.name}": letters, numbers, - and _`);
    if (names.has(sName)) throw new Error(`Two schedules are named "${sName}"`);
    names.add(sName);
    const cron = String(s.cron ?? "").trim();
    try {
      new Cron(cron, { paused: true }).stop();
    } catch {
      throw new Error(`Schedule "${sName}": "${cron}" isn't a valid cron time (e.g. "0 8 * * MON" = Mondays 8:00)`);
    }
    const task = String(s.task ?? "").trim();
    if (!task) throw new Error(`Schedule "${sName}" needs a task`);
    const notify = (["email", "telegram", "none"] as const).includes(s.notify) ? s.notify : "none";
    return { name: sName, cron, task, notify };
  });
  return { name, persona, tools, model, maxSteps, temperature, sites, schedules, description: String(d.description ?? "").trim().slice(0, 300), allowedPaths: clean(d.allowedPaths, 20) };
}

const fileFor = (config: Config, name: string) => path.join(userBotsDir(config), `${name}.yaml`);

/** Create or update a bot. Returns its name. */
export function saveBot(config: Config, draft: BotDraft): string {
  const v = validate(draft);
  const bots = loadBots(config);
  const prev = draft.previousName ? bots.find((b) => b.name === draft.previousName) : undefined;
  if (draft.previousName && !prev) throw new Error(`No bot named "${draft.previousName}"`);
  if (v.name !== prev?.name && bots.some((b) => b.name === v.name)) throw new Error(`There's already a bot named "${v.name}"`);

  // Start from the existing file so settings the editor doesn't show are kept.
  const doc = prev ? YAML.parseDocument(fs.readFileSync(prev.file, "utf8")) : new YAML.Document({});
  const set = (k: string, val: unknown) => (val === undefined || val === "" || (Array.isArray(val) && !val.length) ? doc.delete(k) : doc.set(k, val));
  set("name", v.name);
  set("description", v.description);
  doc.set("persona", new YAML.Scalar(v.persona.endsWith("\n") ? v.persona : `${v.persona}\n`));
  (doc.get("persona", true) as YAML.Scalar).type = "BLOCK_LITERAL";
  set("model", v.model);
  doc.set("tools", v.tools);
  set("allowedPaths", v.allowedPaths);
  if (v.sites.length) doc.set("network", { allow: v.sites });
  else doc.delete("network");
  set("maxSteps", v.maxSteps);
  set("temperature", v.temperature);
  set("schedules", v.schedules);

  fs.mkdirSync(userBotsDir(config), { recursive: true, mode: 0o700 });
  const file = fileFor(config, v.name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Renaming your own bot: remove the old file.
  if (prev?.custom && prev.name !== v.name) fs.rmSync(prev.file, { force: true });
  return v.name;
}

/**
 * Delete one of your bots. A copy that replaced a built-in goes away and the built-in returns.
 * Built-in bots themselves can't be deleted.
 */
export function deleteBot(config: Config, name: string) {
  const b = loadBots(config).find((x) => x.name === name);
  if (!b) throw new Error(`No bot named "${name}"`);
  if (!b.custom) throw new Error(`"${name}" comes with SlopBot and can't be deleted.`);
  fs.rmSync(b.file, { force: true });
}

/** The file to edit for a bot setting (a built-in gets a private copy first). */
export function editableBotFile(config: Config, name: string): string {
  const b = loadBots(config).find((x) => x.name === name);
  if (!b) throw new Error(`No bot named "${name}"`);
  if (b.custom) return b.file;
  fs.mkdirSync(userBotsDir(config), { recursive: true, mode: 0o700 });
  const file = fileFor(config, name);
  fs.copyFileSync(b.file, file);
  fs.chmodSync(file, 0o600);
  return file;
}

/** Tools offered in the editor. */
export function toolCatalog() {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description.split(/(?<=\.)\s/)[0].slice(0, 160), risk: t.risk }));
}
