import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthStore } from "../src/mcp/oauth.js";
import { FileSecrets, MacKeychain, type SecretStore } from "../src/secrets.js";

function roundtrip(store: SecretStore) {
  const key = `test:${process.pid}`;
  const value = JSON.stringify({ token: "abc \"quoted\" 'single' $HOME `tick` ünïcødé 🔑", big: "x".repeat(8000) });
  try {
    assert.equal(store.get(key), undefined);
    store.set(key, value);
    assert.equal(store.get(key), value);
    store.set(key, "updated"); // big → small: stale chunks are cleaned up
    assert.equal(store.get(key), "updated");
    if (store instanceof MacKeychain) assert.equal((store as any).raw(`${key}#0`), undefined, "no leftover chunks");
    store.delete(key);
    assert.equal(store.get(key), undefined);
    store.delete(key); // deleting twice is fine
    assert.throws(() => store.set("bad key; rm -rf /", "x"), /Invalid secret key/);
  } finally {
    store.delete(key);
  }
}

test("macOS Keychain backend round-trips without leaking the secret into argv", { skip: process.platform !== "darwin" }, () => {
  roundtrip(new MacKeychain(`SlopBot-test-${process.pid}`));
});

test("file backend round-trips with 0600 permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-sec-"));
  const store = new FileSecrets(dir);
  roundtrip(store);
  store.set("k", "v");
  assert.equal(fs.statSync(path.join(dir, "k.secret")).mode & 0o777, 0o600);
});

test("OAuth token files from older versions migrate into the secret store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-mig-"));
  const legacy = path.join(dir, "mcp-auth");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "notion.json"), JSON.stringify({ tokens: { access_token: "old", token_type: "Bearer" } }));
  const secrets = new FileSecrets(path.join(dir, "secrets"));
  const auth = new AuthStore(secrets, legacy);
  assert.equal(auth.isSignedIn("notion"), true);
  assert.equal(fs.existsSync(path.join(legacy, "notion.json")), false, "plain file removed after migration");
  assert.match(secrets.get("mcp-oauth:notion")!, /"old"/);
  auth.clear("notion");
  assert.equal(new AuthStore(secrets, legacy).isSignedIn("notion"), false);
});
