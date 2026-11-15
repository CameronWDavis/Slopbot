// The background-work optimizations: shopping state in memory, cached skills, reading the log tail.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import { listSkills, writeSkill } from "../src/skills/skills.js";
import { ShoppingState } from "../src/shopping/state.js";
import { Store } from "../src/store/store.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("activity: the newest entries come from the end of a large log, oldest first", () => {
  const dir = tmp("slopbot-audit-");
  const store = new Store(dir);
  // ~3 MB, with multi-byte characters so lines straddle 64 KB chunk boundaries.
  const lines: string[] = [];
  for (let i = 0; i < 12_000; i++) lines.push(JSON.stringify({ ts: new Date().toISOString(), bot: i % 3 ? "ledger" : "coder", session: "s", type: "tool", n: i, pad: "é✓".repeat(100) }));
  fs.writeFileSync(path.join(dir, "audit.jsonl"), lines.join("\n") + "\n{broken line\n" + lines.slice(-1)[0].replace('"n":11999', '"n":12000') + "\n");
  const last = store.readAudit({ limit: 100 });
  assert.equal(last.length, 100);
  assert.deepEqual([last[0].n, last.at(-1)!.n], [11901, 12000]);
  const coder = store.readAudit({ bot: "coder", limit: 5 });
  assert.deepEqual(coder.map((e) => e.n), [11985, 11988, 11991, 11994, 11997]);
  assert.equal(store.readAudit({ limit: 50_000 }).length, 12_001, "small files / big limits read everything");
  assert.deepEqual(new Store(tmp("slopbot-empty-")).readAudit(), []);
});

test("skills are cached between agent steps and refreshed when changed through SlopBot", () => {
  const dir = tmp("slopbot-skc-");
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), bundledSkillsDir: path.join(dir, "none") } as Config;
  writeSkill(config, { name: "tone", description: "Be brief.", instructions: "x", bots: ["*"] });
  assert.equal(listSkills(config)[0].description, "Be brief.");
  // An edit outside SlopBot isn't re-read on every step...
  const md = path.join(config.dataDir, "skills", "tone", "SKILL.md");
  fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace("Be brief.", "Be kind."));
  assert.equal(listSkills(config)[0].description, "Be brief.");
  // ...but changes made through SlopBot show up immediately.
  writeSkill(config, { name: "tone", description: "Be warm.", instructions: "x", previousName: "tone" });
  assert.equal(listSkills(config)[0].description, "Be warm.");
  // Callers can't corrupt the cache.
  listSkills(config)[0].bots.push("evil");
  assert.deepEqual(listSkills(config)[0].bots, ["*"]);
});

test("shopping state: routine status is batched, purchases are written at once, nothing is lost", async () => {
  const dir = tmp("slopbot-st-");
  const st = new ShoppingState(dir);
  const w = st.saveWatch({ kind: "product", url: "https://www.newegg.com/p/1" });
  const onDisk = () => JSON.parse(fs.readFileSync(st.file, "utf8"));
  assert.equal(onDisk().watches.length, 1, "creating a watch is saved immediately");
  st.patchWatch(w.id, { lastSummary: "checked" });
  assert.equal(st.watches()[0].lastSummary, "checked", "visible right away in memory");
  assert.equal(onDisk().watches[0].lastSummary, undefined, "…but not written yet");
  // A deal (purchase-relevant) is durable at once, and carries the pending status write with it.
  st.addDeal({ watchId: w.id, watchName: "w", key: "k", sources: ["x"], listing: { url: "https://www.newegg.com/p/1", title: "t", price: { minor: 100, currency: "USD" }, checkedAt: "" }, cap: { minor: 115, currency: "USD" } }, 30);
  assert.equal(onDisk().deals.length, 1);
  assert.equal(onDisk().watches[0].lastSummary, "checked");
  st.patchWatch(w.id, { lastSummary: "again" });
  st.flush();
  assert.equal(onDisk().watches[0].lastSummary, "again", "flush (on quit) writes batched changes");
  // Reads are copies: changing them doesn't change the state.
  st.watches()[0].name = "hacked";
  assert.notEqual(st.watches()[0].name, "hacked");
  // The batch timer writes on its own.
  ShoppingState.BATCH_MS = 20;
  st.patchWatch(w.id, { lastSummary: "timer" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(onDisk().watches[0].lastSummary, "timer");
});
