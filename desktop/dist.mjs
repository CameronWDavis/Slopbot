// Runs electron-builder without publishing. On macOS it does NOT auto-use a signing certificate
// from your keychain unless you opt in (SLOPBOT_SIGN=1) or provide CSC_LINK: a personal
// "Apple Development" certificate would embed your Apple ID email and Team ID in the app's
// signature. Unsigned builds are ad-hoc signed by desktop/after-pack.cjs instead.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Nothing personal goes into an installer: stop if the privacy scan finds anything.
const scan = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/privacy-scan.mjs", import.meta.url))], { stdio: "inherit" });
if (scan.status !== 0) process.exit(scan.status ?? 1);

const env = { ...process.env };
if (!env.CSC_LINK && env.SLOPBOT_SIGN !== "1") env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const bin = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const r = spawnSync(bin, [...process.argv.slice(2), "--publish", "never"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
