// Loaded before every test file (see package.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests never touch the real Keychain/DPAPI; the Keychain test targets its own throwaway service explicitly.
process.env.SLOPBOT_SECRETS = "file";
// Tests that run against the repository itself must not touch the developer's real private data.
process.env.SLOPBOT_DEV_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-devdata-"));
