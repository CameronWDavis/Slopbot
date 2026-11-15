// Making and editing bots from the app: saved in private data, built-ins untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { botDraft, deleteBot, editableBotFile, saveBot, type BotDraft } from "../src/agent/bot-edit.js";
import { loadBot, loadBots } from "../src/agent/bot.js";
import type { Config } from "../src/config.js";

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-bots-")));
  const botsDir = path.join(dir, "bots");
  fs.mkdirSync(botsDir);
  fs.copyFileSync(path.join(import.meta.dirname, "../bots/ledger.yaml"), path.join(botsDir, "ledger.yaml"));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir } as Config;
  return { config, builtIn: path.join(botsDir, "ledger.yaml") };
}
const draft = (o: Partial<BotDraft> = {}): BotDraft => ({
  name: "gym-coach",
  description: "Tracks workouts.",
  persona: "You are a blunt fitness coach.\n- Keep it short.",
  tools: ["memory.*", "web.search"],
  allowedPaths: [],
  sites: ["https://www.strava.com/athletes"],
  schedules: [{ name: "Nudge", cron: "0 18 * * *", task: "Nudge me if I skipped today.", notify: "telegram" }],
  ...o,
});

test("a new bot is saved in private data and loads like any other", () => {
  const { config } = setup();
  assert.equal(saveBot(config, draft()), "gym-coach");
  const file = path.join(config.dataDir, "bots", "gym-coach.yaml");
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = loadBot(config, "gym-coach");
  assert.deepEqual([b.custom, b.persona, b.tools, b.network?.allow, b.schedules[0].name], [true, "You are a blunt fitness coach.\n- Keep it short.\n", ["memory.*", "web.search"], ["www.strava.com"], "nudge"]);
  assert.deepEqual(loadBots(config).map((x) => x.name), ["gym-coach", "ledger"]);
  assert.throws(() => saveBot(config, draft()), /already a bot named "gym-coach"/);
});

test("bad input is refused with a clear reason", () => {
  const { config } = setup();
  for (const [o, err] of [
    [{ name: "Gym Coach!" }, /lowercase/],
    [{ persona: " " }, /instructions/],
    [{ tools: ["nope.tool"] }, /No tool matches "nope.tool"/],
    [{ model: "qwen3" }, /provider\/model/],
    [{ schedules: [{ name: "x", cron: "every day", task: "t", notify: "none" }] }, /isn't a valid cron time/],
    [{ schedules: [{ name: "x", cron: "0 8 * * *", task: "", notify: "none" }] }, /needs a task/],
    [{ sites: ["not a site"] }, /isn't a website name/],
    [{ maxSteps: 500 }, /between 1 and 100/],
  ] as [Partial<BotDraft>, RegExp][])
    assert.throws(() => saveBot(config, draft(o)), err);
  assert.ok(!fs.existsSync(path.join(config.dataDir, "bots", "gym-coach.yaml")));
});

test("editing keeps settings the editor doesn't show; renaming moves the file", () => {
  const { config } = setup();
  saveBot(config, draft());
  const file = path.join(config.dataDir, "bots", "gym-coach.yaml");
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, YAML.stringify({ ...doc, permissions: [{ tool: "email.send", action: "deny" }], maxTools: 12 }));
  saveBot(config, { ...botDraft(loadBot(config, "gym-coach")), name: "coach", description: "New desc", previousName: "gym-coach" });
  assert.ok(!fs.existsSync(file));
  const b = loadBot(config, "coach");
  assert.deepEqual([b.description, b.permissions, b.maxTools], ["New desc", [{ tool: "email.send", action: "deny" }], 12]);
});

test("editing a built-in bot saves your own copy; deleting it brings the original back", () => {
  const { config, builtIn } = setup();
  const original = fs.readFileSync(builtIn, "utf8");
  saveBot(config, { ...botDraft(loadBot(config, "ledger")), description: "My ledger", previousName: "ledger" });
  assert.equal(fs.readFileSync(builtIn, "utf8"), original, "the built-in file is untouched");
  const mine = loadBot(config, "ledger");
  assert.deepEqual([mine.description, mine.custom, mine.overridesBuiltIn], ["My ledger", true, true]);
  assert.equal(loadBots(config).filter((b) => b.name === "ledger").length, 1);
  assert.deepEqual(mine.schedules.map((s) => s.name), ["weekly-report"], "schedules carried over");
  deleteBot(config, "ledger");
  assert.equal(loadBot(config, "ledger").custom, undefined);
  assert.throws(() => deleteBot(config, "ledger"), /comes with SlopBot/);
  // Changing just the model (Models tab) also goes to your copy.
  const f = editableBotFile(config, "ledger");
  assert.ok(f.startsWith(config.dataDir));
  assert.equal(fs.readFileSync(builtIn, "utf8"), original);
});

test("a broken bot file doesn't hide the others", () => {
  const { config } = setup();
  fs.mkdirSync(path.join(config.dataDir, "bots"), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, "bots", "broken.yaml"), "name: Broken Name\n");
  assert.deepEqual(loadBots(config).map((b) => b.name), ["ledger"]);
});
