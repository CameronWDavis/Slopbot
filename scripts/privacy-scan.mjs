#!/usr/bin/env node
// Pre-release privacy scan: fails if anything that would be published (committed files, or what the
// installer packages) contains credentials, private keys, home-folder paths or personal email
// addresses, or if packaging reaches outside the public folders. Run by CI, the release workflow and
// `npm run desktop:dist`. Usage: node scripts/privacy-scan.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && fs.existsSync(path.join(root, f)));

const TOKENS = [
  [/\b(?:sk-(?:proj-|ant-)?|sk_live_|rk_live_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-|hf_|tvly-|gsk_|AIza)[A-Za-z0-9_-]{16,}/, "API key or token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, "Telegram bot token"],
  [/\bAAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{40,}/, "X bearer token"],
];
const PERSONAL = [
  [/\/Users\/(?!you\b|me\b|example\b|runner\b|Shared\b|<)[A-Za-z][\w.-]+\//, "macOS home-folder path"],
  [/[A-Z]:\\\\?Users\\\\?(?!you\b|Public\b|<|%)[\w.-]+/i, "Windows home-folder path"],
  [/\/home\/(?!runner\b|user\b|you\b|<)[a-z][\w.-]+\//, "Linux home-folder path"],
  [/\b(?!(?:you|me|user|name|someone|jane\.doe|john\.doe)@)[A-Z0-9._%+-]+@(?!(?:[\w-]+\.)*example\.(?:com|org|net)\b|users\.noreply\.github\.com\b|anthropic\.com\b|test\b|localhost\b)[A-Z0-9.-]+\.(com|net|org|io|me|dev|co|us|edu)\b/i, "email address"],
];
// Synthetic credentials in tests are intentionally fake.
const isTest = (f) => f.startsWith("test/");
const binary = /\.(png|jpe?g|gif|ico|icns|glb|blend|webp|mp4|woff2?|ttf|otf|zip|gz|dmg|exe)$/i;

const problems = [];
for (const f of files) {
  if (binary.test(f) || f === "package-lock.json") continue;
  const text = fs.readFileSync(path.join(root, f), "utf8");
  if (text.includes("\u0000")) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [re, what] of [...(isTest(f) ? [] : TOKENS), ...PERSONAL]) {
      const m = line.match(re);
      if (m && !/privacy-scan: allow/.test(line)) problems.push(`${f}:${i + 1}: ${what}: ${m[0].slice(0, 40)}${m[0].length > 40 ? "…" : ""}`);
    }
  });
}

// Packaging must only take public folders.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const allowedFiles = new Set(["dist-desktop/**/*", "package.json"]);
for (const f of pkg.build?.files ?? []) if (!allowedFiles.has(f)) problems.push(`package.json build.files includes "${f}" (only dist-desktop and package.json are allowed)`);
const allowedResources = new Set(["bots", "examples", "skills", "slopbot.config.example.yaml"]);
for (const r of pkg.build?.extraResources ?? []) if (!allowedResources.has(r.from)) problems.push(`package.json build.extraResources includes "${r.from}" (not a public folder)`);
// Private runtime files must never be tracked.
for (const f of files)
  if (/^(data\/|\.env($|\.)(?!example)|slopbot\.config\.yaml$|slopbot\.mcp\.json$|slopbot\.skills\.json$|.*\.(pem|p12|pfx)$)/.test(f)) problems.push(`${f}: private file would be published`);

if (problems.length) {
  console.error(`privacy scan: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`privacy scan: ${files.length} files clean`);
