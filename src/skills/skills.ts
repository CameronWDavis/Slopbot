// Agent Skills: folders with a SKILL.md (YAML frontmatter `name` + `description`, then
// instructions), plus any scripts, templates or reference files the instructions mention.
//
//   built-in:  skills/<name>/ in the app bundle (or the source checkout): public, read-only
//   private:   <data>/skills/<name>/ — skills you write or import; never in the repo or a build
//   <data>/skills.json                     which bots use which skill (set in the app or CLI)
//   bots/<bot>.yaml  skills: [name, …]     also honored, for hand-written bots
// A private skill with the same name as a built-in one replaces it.
//
// Bots only see each skill's name and description up front; they load the instructions with
// skills.read when a task calls for it, so a big library doesn't flood a small model's context.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BotDef } from "../agent/bot.js";
import type { Config } from "../config.js";
import { isSourceCheckout } from "../paths.js";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  /** Bots assigned in slopbot.skills.json ("*" = all). */
  bots: string[];
  enabled: boolean;
  license?: string;
  /** Problem with the SKILL.md, if any (skill is listed but not offered to bots). */
  error?: string;
  /** Ships with SlopBot (read-only; can be turned off, and edited into a private copy). */
  bundled?: boolean;
}

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_MD = 256 * 1024;

/** Your private skills. */
export const skillsDir = (config: Config) => path.join(config.dataDir, "skills");
/** Skills that ship with SlopBot. */
export const bundledSkillsDir = (config: Config) => config.bundledSkillsDir ?? path.join(config.rootDir, "skills");
const assignFile = (config: Config) => path.join(config.dataDir, "skills.json");

/** Older installs kept skills and assignments in the home folder; move them to private data once. */
const migrated = new Set<string>();
function migrate(config: Config) {
  if (migrated.has(config.dataDir)) return;
  migrated.add(config.dataDir);
  const oldAssign = path.join(config.rootDir, "slopbot.skills.json");
  try {
    if (!fs.existsSync(assignFile(config)) && fs.existsSync(oldAssign)) {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(oldAssign, assignFile(config));
      fs.chmodSync(assignFile(config), 0o600);
      fs.rmSync(oldAssign, { force: true });
    }
  } catch {}
  // In an installed app the home folder's skills/ held seeded + imported skills. In a source
  // checkout skills/ is the built-in set, so it stays.
  const oldDir = path.join(config.rootDir, "skills");
  if (isSourceCheckout(config.rootDir) || !fs.existsSync(oldDir) || path.resolve(oldDir) === path.resolve(bundledSkillsDir(config))) return;
  try {
    fs.mkdirSync(skillsDir(config), { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(oldDir)) {
      const from = path.join(oldDir, name);
      const to = path.join(skillsDir(config), name);
      const builtIn = path.join(bundledSkillsDir(config), name, "SKILL.md");
      const same = fs.existsSync(builtIn) && fs.existsSync(path.join(from, "SKILL.md")) && fs.readFileSync(builtIn, "utf8") === fs.readFileSync(path.join(from, "SKILL.md"), "utf8");
      if (!same && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
  } catch {}
}

type Assignments = Record<string, { bots: string[]; enabled?: boolean }>;

function readAssignments(config: Config): Assignments {
  try {
    return JSON.parse(fs.readFileSync(assignFile(config), "utf8")).skills ?? {};
  } catch {
    return {};
  }
}
function writeAssignments(config: Config, a: Assignments) {
  const file = assignFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ skills: a }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Split SKILL.md into frontmatter and body. */
export function parseSkillMd(text: string): { meta: Record<string, any>; body: string } {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) throw new Error("SKILL.md must start with YAML frontmatter (--- name: … description: … ---)");
  const meta = YAML.parse(m[1]) ?? {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("SKILL.md frontmatter must be key: value pairs");
  return { meta, body: m[2].trim() };
}

function validate(meta: Record<string, any>): { name: string; description: string } {
  const name = String(meta.name ?? "").trim();
  const description = String(meta.description ?? "").trim();
  if (!SKILL_NAME_RE.test(name) || name.length > 64) throw new Error(`Skill name "${name}" must be lowercase letters, digits and hyphens (max 64), e.g. "weekly-report"`);
  if (!description) throw new Error(`Skill "${name}" needs a description (it's how the bot knows when to use it)`);
  if (description.length > 1024) throw new Error(`Skill "${name}": description is over 1024 characters`);
  return { name, description };
}

/** Every skill in the library, including broken ones (with `error`) so the app can show them. */
export function listSkills(config: Config): Skill[] {
  migrate(config);
  const assigned = readAssignments(config);
  const found = new Map<string, { dir: string; bundled: boolean }>();
  for (const [root, bundled] of [
    [bundledSkillsDir(config), true],
    [skillsDir(config), false],
  ] as const) {
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) if (d.isDirectory() && !d.name.startsWith(".")) found.set(d.name, { dir: path.join(root, d.name), bundled });
  }
  const out: Skill[] = [];
  for (const [name, { dir, bundled }] of found) {
    const a = assigned[name] ?? { bots: [] };
    const base = { name, description: "", dir, bots: a.bots ?? [], enabled: a.enabled !== false, bundled: bundled || undefined };
    try {
      const { meta } = parseSkillMd(readSkillFile(dir, "SKILL.md", MAX_SKILL_MD));
      const v = validate(meta);
      if (v.name !== name) throw new Error(`folder is "${name}" but SKILL.md says name: ${v.name}`);
      out.push({ ...base, description: v.description, license: meta.license ? String(meta.license) : undefined });
    } catch (e: any) {
      out.push({ ...base, error: e?.message ?? String(e) });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** The working skills a bot may use: assigned in the app/CLI, or listed in the bot's YAML. */
export function skillsForBot(config: Config, bot: BotDef): Skill[] {
  const fromYaml = bot.skills ?? [];
  return listSkills(config).filter(
    (s) => !s.error && s.enabled && (s.bots.includes("*") || s.bots.includes(bot.name) || fromYaml.includes("*") || fromYaml.includes(s.name)),
  );
}

/**
 * Read a file inside a skill folder. Refuses anything that escapes the folder, including through
 * symlinks, and anything that isn't a regular file.
 */
export function readSkillFile(dir: string, rel: string, maxBytes = 512 * 1024): string {
  const root = fs.realpathSync(dir);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`"${rel}" is outside the skill folder`);
  const real = fs.realpathSync(target);
  if (real !== target) throw new Error(`"${rel}" is a link; skills can't follow links`);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`"${rel}" is not a file`);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8") + (st.size > maxBytes ? `\n… [truncated, ${st.size} bytes total]` : "");
  } finally {
    fs.closeSync(fd);
  }
}

/** Files in a skill folder (relative paths), for the bot to know what's there. */
export function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || out.length >= 200) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Copy a folder into the library, refusing links and anything huge. */
function copyTree(from: string, to: string) {
  let files = 0;
  let bytes = 0;
  const check = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`The skill contains a link (${path.relative(from, p)}); remove it and try again`);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        check(p);
      } else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
      }
      if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("That folder is too big for a skill (max 500 files / 20 MB)");
    }
  };
  check(from);
  fs.cpSync(from, to, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
}

/**
 * Add a skill from a folder containing SKILL.md, or a SKILL.md file on its own.
 * The folder is named after the skill's `name`. Returns the skill name.
 */
export function addSkill(config: Config, source: string, bots: string[] = ["*"], opts: { replace?: boolean } = {}): string {
  let src = path.resolve(source);
  const st = fs.statSync(src);
  if (st.isFile()) {
    if (path.basename(src).toLowerCase() !== "skill.md") throw new Error("Pick a SKILL.md file or the folder that contains it");
    src = path.dirname(src);
  }
  const mdName = fs.readdirSync(src).find((f) => f.toLowerCase() === "skill.md");
  if (!mdName) throw new Error(`No SKILL.md in ${src}`);
  const { name } = validate(parseSkillMd(readSkillFile(src, mdName, MAX_SKILL_MD)).meta);
  const dest = path.join(skillsDir(config), name);
  if (path.resolve(src) === dest) {
    assign(config, name, bots);
    return name;
  }
  if (fs.existsSync(dest)) {
    if (!opts.replace) throw new Error(`You already have a skill named "${name}"`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDir(config), { recursive: true });
  copyTree(src, dest);
  if (mdName !== "SKILL.md") fs.renameSync(path.join(dest, mdName), path.join(dest, "SKILL.md"));
  assign(config, name, bots);
  return name;
}

/** Create or overwrite a simple skill (just a SKILL.md) from the app's editor. */
export function writeSkill(config: Config, input: { name: string; description: string; instructions: string; bots?: string[]; previousName?: string }): string {
  const { name, description } = validate(input);
  const dir = path.join(skillsDir(config), name);
  // Editing a built-in skill saves your own private copy (with its other files) that replaces it.
  const prev = input.previousName;
  if (prev && SKILL_NAME_RE.test(prev) && !fs.existsSync(path.join(skillsDir(config), prev)) && fs.existsSync(path.join(bundledSkillsDir(config), prev))) {
    if (prev !== name && fs.existsSync(dir)) throw new Error(`You already have a skill named "${name}"`);
    fs.mkdirSync(skillsDir(config), { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(bundledSkillsDir(config), prev), dir, { recursive: true });
    if (prev !== name) assign(config, name, readAssignments(config)[prev]?.bots ?? []);
  } else if (input.previousName && input.previousName !== name) {
    if (fs.existsSync(dir)) throw new Error(`You already have a skill named "${name}"`);
    renameSkill(config, input.previousName, name);
  } else if (!input.previousName && fs.existsSync(dir)) {
    throw new Error(`You already have a skill named "${name}"`);
  }
  fs.mkdirSync(dir, { recursive: true });
  let meta: Record<string, any> = {};
  try {
    meta = parseSkillMd(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).meta; // keep license etc.
  } catch {}
  const front = YAML.stringify({ ...meta, name, description }).trim();
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n\n${input.instructions.trim()}\n`);
  if (input.bots) assign(config, name, input.bots);
  return name;
}

function renameSkill(config: Config, from: string, to: string) {
  if (!SKILL_NAME_RE.test(from)) throw new Error(`No skill "${from}"`);
  fs.renameSync(path.join(skillsDir(config), from), path.join(skillsDir(config), to));
  const a = readAssignments(config);
  if (a[from]) {
    a[to] = a[from];
    delete a[from];
    writeAssignments(config, a);
  }
}

/** The full SKILL.md text, for the app's editor. */
export function getSkill(config: Config, name: string): { meta: Record<string, any>; body: string; files: string[] } {
  const s = listSkills(config).find((x) => x.name === name);
  if (!s) throw new Error(`No skill "${name}"`);
  return { ...parseSkillMd(readSkillFile(s.dir, "SKILL.md", MAX_SKILL_MD)), files: skillFiles(s.dir) };
}

export function assign(config: Config, name: string, bots: string[], enabled?: boolean) {
  const a = readAssignments(config);
  a[name] = { bots: bots.includes("*") ? ["*"] : [...new Set(bots)], enabled: enabled ?? a[name]?.enabled ?? true };
  writeAssignments(config, a);
}

export function removeSkill(config: Config, name: string) {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`No skill "${name}"`);
  if (!fs.existsSync(path.join(skillsDir(config), name)) && fs.existsSync(path.join(bundledSkillsDir(config), name)))
    throw new Error(`"${name}" comes with SlopBot and can't be deleted. Turn it off instead.`);
  fs.rmSync(path.join(skillsDir(config), name), { recursive: true, force: true });
  const a = readAssignments(config);
  delete a[name];
  writeAssignments(config, a);
}
