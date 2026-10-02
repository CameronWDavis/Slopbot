// Bag Buddy behavior: the verification scenarios from assets/bag-buddy/skills/bag-buddy-integration/SKILL.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Director, type Manifest, type PlayRequest } from "../desktop/renderer/director.js";

const manifest: Manifest = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../assets/bag-buddy/manifest.json"), "utf8"),
);

function setup(reducedMotion = false) {
  let t = 0;
  const plays: PlayRequest[] = [];
  let staticPoses = 0;
  const d = new Director(manifest, { play: (r) => plays.push(r), showStaticPose: () => staticPoses++ }, () => t, reducedMotion);
  const last = () => plays[plays.length - 1];
  const advance = (sec: number) => {
    // tick at 10 Hz like a throttled frame loop
    for (let i = 0; i < sec * 10; i++) {
      t += 0.1;
      d.tick();
    }
  };
  return { d, plays, last, advance, statics: () => staticPoses };
}

test("idle → thinking → success → idle", () => {
  const { d, last } = setup();
  assert.equal(last().clip, "idle");
  d.workStarted();
  assert.equal(last().clip, "thinking");
  assert.equal(last().loop, true);
  d.workFinished(true);
  assert.equal(last().clip, "celebrating");
  assert.equal(last().loop, false);
  d.clipFinished(last().token);
  assert.equal(last().clip, "idle");
});

test("idle → paddle_ball after 25s, bounded to 3 loops, once per inactivity period", () => {
  const { d, last, advance, plays } = setup();
  advance(24);
  assert.equal(last().clip, "idle");
  advance(2);
  assert.equal(last().clip, "paddle_ball");
  assert.equal(last().repetitions, 3);
  d.clipFinished(last().token); // three loops done
  assert.equal(last().clip, "idle");
  const n = plays.length;
  advance(30); // still inactive: no second episode
  assert.equal(plays.length, n);
  advance(70); // 126s total → sleep
  assert.equal(last().clip, "sleeping");
  advance(60);
  assert.equal(plays.filter((p) => p.clip === "sleeping").length, 1, "sleeping isn't re-triggered every tick");
});

test("paddle_ball is interrupted by work immediately; ambient suppressed while busy", () => {
  const { d, last, advance, plays } = setup();
  advance(26);
  assert.equal(last().clip, "paddle_ball");
  d.workStarted();
  assert.equal(last().clip, "thinking");
  const n = plays.length;
  advance(200); // a very long run: no boredom or sleep while busy
  assert.equal(plays.length, n);
});

test("user activity interrupts sleep and paddle, and resets the boredom budget", () => {
  const { d, last, advance } = setup();
  advance(26);
  assert.equal(last().clip, "paddle_ball");
  d.userActivity();
  assert.equal(last().clip, "idle");
  advance(26);
  assert.equal(last().clip, "paddle_ball", "new inactivity period gets a new episode");
  advance(100);
  assert.equal(last().clip, "sleeping");
  d.userActivity();
  assert.equal(last().clip, "idle");
});

test("user activity during plain idle doesn't restart the idle clip", () => {
  const { d, plays } = setup();
  const n = plays.length;
  d.userActivity();
  assert.equal(plays.length, n);
});

test("laughing plays at most 2 loops → idle", () => {
  const { d, last } = setup();
  d.amused();
  assert.equal(last().clip, "laughing");
  assert.equal(last().repetitions, 2);
  d.clipFinished(last().token);
  assert.equal(last().clip, "idle");
});

test("stale one-shot completion can't overwrite a newer state", () => {
  const { d, last } = setup();
  d.greet();
  const waveToken = last().token;
  d.workStarted();
  d.clipFinished(waveToken); // the wave's finished event arrives late
  assert.equal(d.state, "working");
  assert.equal(last().clip, "thinking");
});

test("one-shot during work returns to thinking, not idle", () => {
  const { d, last } = setup();
  d.workStarted();
  d.approvalRequested();
  assert.equal(last().clip, "curious");
  d.clipFinished(last().token);
  assert.equal(last().clip, "thinking");
});

test("failure plays oops then idle", () => {
  const { d, last } = setup();
  d.workStarted();
  d.workFinished(false);
  assert.equal(last().clip, "oops");
  d.clipFinished(last().token);
  assert.equal(last().clip, "idle");
});

test("reduced motion: static pose, no clips, no ambient", () => {
  const { d, plays, advance, statics } = setup(true);
  assert.equal(statics(), 1);
  d.workStarted();
  d.workFinished(true);
  advance(200);
  assert.equal(plays.length, 0);
});

test("hidden window: clock paused, resume doesn't fast-forward into boredom", () => {
  const { d, last, advance } = setup();
  advance(20);
  d.pause();
  advance(300); // hidden for 5 minutes
  d.resume();
  assert.equal(last().clip, "idle");
  advance(4);
  assert.equal(last().clip, "idle");
  advance(2); // 26s of *visible* inactivity
  assert.equal(last().clip, "paddle_ball");
});
