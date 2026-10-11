import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BotDef } from "../src/agent/bot.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import type { Config } from "../src/config.js";
import { addSkill, assign, listSkills, parseSkillMd, removeSkill, skillsForBot, writeSkill } from "../src/skills/skills.js";
import { skillsReadTool } from "../src/skills/tool.js";

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-skills-")));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
  const bot = (name: string, skills: string[] = []) => ({ name, skills, persona: "", tools: [], allowedPaths: [], maxSteps: 5, permissions: [], schedules: [], file: "" }) as unknown as BotDef;
  const src = path.join(dir, "download", "csv-cleanup");
  fs.mkdirSync(path.join(src, "reference"), { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: csv-cleanup\ndescription: Use when a bank CSV has odd columns.\n---\n\n# Steps\n1. Look at the header row.\n");
  fs.writeFileSync(path.join(src, "reference", "banks.md"), "Chase puts debits in column 4.\n");
  return { dir, config, bot, src };
}
const ctxFor = (config: Config, bot: BotDef) => ({ config, bot, roots: [], sessionId: "s", store: {} as any });

test("parse SKILL.md frontmatter and reject bad ones", () => {
  assert.deepEqual(parseSkillMd("---\nname: a\ndescription: b\n---\nbody here").meta, { name: "a", description: "b" });
  assert.equal(parseSkillMd("---\nname: a\ndescription: b\n---\n\n# Hi\n").body, "# Hi");
  assert.throws(() => parseSkillMd("# no frontmatter"), /frontmatter/);
});

test("add a skill folder, assign it to bots, and read it through the tool", async () => {
  const { config, bot, src } = setup();
  assert.equal(addSkill(config, src, ["ledger"]), "csv-cleanup");
  assert.equal(listSkills(config)[0].description, "Use when a bank CSV has odd columns.");
  assert.deepEqual(skillsForBot(config, bot("ledger")).map((s) => s.name), ["csv-cleanup"]);
  assert.deepEqual(skillsForBot(config, bot("coder")), [], "not assigned to coder");
  assert.equal(skillsForBot(config, bot("coder", ["csv-cleanup"])).length, 1, "bot YAML can list it too");

  const out = await skillsReadTool.run({ name: "csv-cleanup" }, ctxFor(config, bot("ledger")));
  assert.match(out, /# Steps/);
  assert.match(out, /reference\/banks\.md/, "lists the skill's other files");
  assert.match(await skillsReadTool.run({ name: "csv-cleanup", file: "reference/banks.md" }, ctxFor(config, bot("ledger"))), /column 4/);
  await assert.rejects(skillsReadTool.run({ name: "csv-cleanup" }, ctxFor(config, bot("coder"))), /don't have a skill/);

  // Turned off → not offered; prompt only lists name + description.
  const prompt = buildSystemPrompt({ bot: bot("ledger"), tools: [], memory: [], roots: ["/w"], mode: "interactive", skills: skillsForBot(config, bot("ledger")) });
  assert.match(prompt, /- csv-cleanup: Use when a bank CSV has odd columns\./);
  assert.doesNotMatch(prompt, /Look at the header row/, "instructions load on demand, not up front");
  assign(config, "csv-cleanup", ["ledger"], false);
  assert.deepEqual(skillsForBot(config, bot("ledger")), []);

  removeSkill(config, "csv-cleanup");
  assert.deepEqual(listSkills(config), []);
});

test("skill files can't reach outside the skill folder", { skip: process.platform === "win32" }, async () => {
  const { config, bot, src, dir } = setup();
  fs.writeFileSync(path.join(dir, "secret.txt"), "TOP-SECRET\n");
  addSkill(config, src, ["*"]);
  const ctx = ctxFor(config, bot("ledger"));
  await assert.rejects(skillsReadTool.run({ name: "csv-cleanup", file: "../../secret.txt" }, ctx), /outside the skill folder/);
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(config.dataDir, "skills", "csv-cleanup", "link.md"));
  await assert.rejects(skillsReadTool.run({ name: "csv-cleanup", file: "link.md" }, ctx), /link/);
  // Importing a folder that contains a link is refused outright.
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(src, "sneaky.md"));
  assert.throws(() => addSkill(config, src, ["*"], { replace: true }), /contains a link/);
});

test("write, rename and validate skills from the editor", () => {
  const { config, bot } = setup();
  writeSkill(config, { name: "tone", description: "Use for every email.", instructions: "Be brief.", bots: ["*"] });
  assert.equal(skillsForBot(config, bot("anyone")).length, 1);
  writeSkill(config, { name: "email-tone", description: "Use for every email.", instructions: "Be brief.", previousName: "tone" });
  assert.deepEqual(listSkills(config).map((s) => [s.name, s.bots]), [["email-tone", ["*"]]], "rename keeps assignment");
  assert.throws(() => writeSkill(config, { name: "Bad Name", description: "x", instructions: "" }), /lowercase/);
  assert.throws(() => writeSkill(config, { name: "ok", description: "", instructions: "" }), /description/);
  // A hand-made folder whose SKILL.md name doesn't match is listed with an error, not offered.
  fs.mkdirSync(path.join(config.dataDir, "skills", "mismatch"));
  fs.writeFileSync(path.join(config.dataDir, "skills", "mismatch", "SKILL.md"), "---\nname: other\ndescription: d\n---\n");
  assert.match(listSkills(config).find((s) => s.name === "mismatch")!.error!, /folder is "mismatch"/);
});

test("the bundled example skill is valid", () => {
  const root = path.join(import.meta.dirname, "..");
  const config = { rootDir: root, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-skd-")) } as Config;
  const s = listSkills(config).find((x) => x.name === "weekly-money-report");
  assert.ok(s && !s.error, s?.error);
});

test("built-in skills are read-only; your skills live in private data, never the repo", () => {
  const { config, bot } = setup();
  const builtIn = path.join(config.rootDir, "bundled");
  fs.mkdirSync(path.join(builtIn, "tone", "ref"), { recursive: true });
  fs.writeFileSync(path.join(builtIn, "tone", "SKILL.md"), "---\nname: tone\ndescription: Shipped tone guide.\n---\nBe kind.\n");
  fs.writeFileSync(path.join(builtIn, "tone", "ref", "examples.md"), "examples");
  config.bundledSkillsDir = builtIn;
  assert.deepEqual(listSkills(config).map((s) => [s.name, s.bundled]), [["tone", true]]);
  assert.throws(() => removeSkill(config, "tone"), /comes with SlopBot/);

  // Editing a built-in makes a private copy (files included) that replaces it; the bundle is untouched.
  writeSkill(config, { name: "tone", description: "My tone.", instructions: "Be brief.", bots: ["ledger"], previousName: "tone" });
  const mine = listSkills(config).find((s) => s.name === "tone")!;
  assert.equal(mine.bundled, undefined);
  assert.ok(mine.dir.startsWith(config.dataDir));
  assert.ok(fs.existsSync(path.join(mine.dir, "ref", "examples.md")));
  assert.match(fs.readFileSync(path.join(builtIn, "tone", "SKILL.md"), "utf8"), /Be kind/);
  assert.equal(skillsForBot(config, bot("ledger"))[0].description, "My tone.");
  // Deleting your copy brings the built-in back.
  removeSkill(config, "tone");
  assert.equal(listSkills(config)[0].bundled, true);
  assert.ok(fs.existsSync(path.join(config.dataDir, "skills.json")), "assignments are private data");
  assert.ok(!fs.existsSync(path.join(config.rootDir, "slopbot.skills.json")));
});

test("an installed app's old home-folder skills move to private data", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-home-")));
  const builtIn = path.join(home, "seed");
  fs.mkdirSync(path.join(builtIn, "weekly"), { recursive: true });
  fs.writeFileSync(path.join(builtIn, "weekly", "SKILL.md"), "---\nname: weekly\ndescription: d\n---\nx\n");
  fs.mkdirSync(path.join(home, "skills", "weekly"), { recursive: true });
  fs.copyFileSync(path.join(builtIn, "weekly", "SKILL.md"), path.join(home, "skills", "weekly", "SKILL.md")); // seeded copy
  fs.mkdirSync(path.join(home, "skills", "my-own"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "my-own", "SKILL.md"), "---\nname: my-own\ndescription: mine\n---\nx\n");
  fs.writeFileSync(path.join(home, "slopbot.skills.json"), JSON.stringify({ skills: { "my-own": { bots: ["coder"] } } }));
  const config = { rootDir: home, dataDir: path.join(home, "data"), bundledSkillsDir: builtIn } as Config;
  const skills = listSkills(config);
  assert.deepEqual(skills.map((s) => [s.name, !!s.bundled, s.bots]), [["my-own", false, ["coder"]], ["weekly", true, []]]);
  assert.ok(!fs.existsSync(path.join(home, "skills")), "old folder removed after moving");
  assert.ok(!fs.existsSync(path.join(home, "slopbot.skills.json")));
});
