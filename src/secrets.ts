// OS-backed secret storage, shared by the desktop app, the CLI, and `slopbot mcp`.
//   macOS → login Keychain via /usr/bin/security (secrets go over stdin as hex, never in argv)
//   Windows → DPAPI (CurrentUser) via PowerShell: files under <data>/secrets that only this
//             Windows login can decrypt
//   Linux → libsecret via secret-tool (GNOME Keyring / KWallet), when installed
//   else  → files under <data>/secrets, readable only by the user (0600)
// Force the file backend with SLOPBOT_SECRETS=file (e.g. headless servers, tests).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SecretStore {
  readonly kind: "keychain" | "dpapi" | "libsecret" | "file";
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const SERVICE = "SlopBot";
const KEY_RE = /^[A-Za-z0-9._:@-]{1,200}$/; // "#n" suffixes are added internally for chunks

function checkKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error(`Invalid secret key "${key}"`);
}

export class MacKeychain implements SecretStore {
  readonly kind = "keychain";
  /**
   * Two quirks of /usr/bin/security shape this:
   *  - `find-generic-password -w` prints hex instead of text for non-ASCII data, so values are
   *    stored base64-encoded (pure ASCII; reads back exactly).
   *  - `security -i` truncates input lines at ~4 KB and stores the truncated value, so long values
   *    are split: `key` holds "slopbot-chunks:<n>" (":" never occurs in base64), `key#0..n` the parts.
   * Every write is read back and compared.
   */
  static CHUNK_CHARS = 1800; // base64 chars per item → 3600 hex chars on the command line
  private static HEADER = "slopbot-chunks:";

  constructor(private service = SERVICE) {
    checkKey(service);
  }

  private raw(key: string): string | undefined {
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-a", key, "-s", this.service, "-w"], { encoding: "utf8" });
    if (r.status === 44) return undefined; // not found
    if (r.status !== 0) throw new Error(`Keychain read failed: ${r.stderr.trim() || `exit ${r.status}`}`);
    return r.stdout.replace(/\n$/, "");
  }

  private write(key: string, ascii: string) {
    const hex = Buffer.from(ascii, "ascii").toString("hex");
    // Interactive mode reads the command from stdin, so the secret never shows up in `ps`.
    const r = spawnSync("/usr/bin/security", ["-i"], {
      input: `add-generic-password -U -a ${key} -s ${this.service} -l ${this.service} -X ${hex}\n`,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`Keychain write failed: ${(r.stderr || r.stdout).split("\n")[0] || `exit ${r.status}`}`);
  }

  private remove(key: string) {
    const r = spawnSync("/usr/bin/security", ["delete-generic-password", "-a", key, "-s", this.service], { encoding: "utf8" });
    if (r.status !== 0 && r.status !== 44) throw new Error(`Keychain delete failed: ${r.stderr.trim()}`);
  }

  private chunkCount(head: string | undefined): number {
    return head?.startsWith(MacKeychain.HEADER) ? Number(head.slice(MacKeychain.HEADER.length)) || 0 : 0;
  }

  get(key: string) {
    checkKey(key);
    const head = this.raw(key);
    if (head === undefined) return undefined;
    let b64 = head;
    const n = this.chunkCount(head);
    if (n) {
      b64 = "";
      for (let i = 0; i < n; i++) {
        const part = this.raw(`${key}#${i}`);
        if (part === undefined) throw new Error(`Keychain item ${key} is incomplete (missing part ${i})`);
        b64 += part;
      }
    }
    return Buffer.from(b64, "base64").toString("utf8");
  }

  set(key: string, value: string) {
    checkKey(key);
    const before = this.chunkCount(this.raw(key));
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const parts: string[] = [];
    if (b64.length <= MacKeychain.CHUNK_CHARS) {
      this.write(key, b64);
    } else {
      for (let i = 0; i < b64.length; i += MacKeychain.CHUNK_CHARS) parts.push(b64.slice(i, i + MacKeychain.CHUNK_CHARS));
      parts.forEach((p, i) => this.write(`${key}#${i}`, p));
      this.write(key, `${MacKeychain.HEADER}${parts.length}`);
    }
    for (let i = parts.length; i < before; i++) this.remove(`${key}#${i}`); // stale pieces
    if (this.get(key) !== value) throw new Error(`Keychain write for ${key} didn't verify`);
  }

  delete(key: string) {
    checkKey(key);
    const n = this.chunkCount(this.raw(key));
    for (let i = 0; i < n; i++) this.remove(`${key}#${i}`);
    this.remove(key);
  }
}

/** Runs a PowerShell script with `input` on stdin and returns stdout. Swappable for tests. */
export type PsRunner = (script: string, input: string) => string;

export const runPowerShell: PsRunner = (script, input) => {
  // -EncodedCommand keeps quoting out of the picture; the secret itself only travels over stdin.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`PowerShell failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout.trim();
};

const DPAPI_SCRIPT = (op: "Protect" | "Unprotect") => `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('SlopBot secret store v1')
$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))`;

/**
 * Windows: values are encrypted with DPAPI for the current Windows user (the same mechanism
 * browsers use for saved passwords), so the files are useless to other accounts or machines.
 */
export class WinDpapi implements SecretStore {
  readonly kind = "dpapi";
  private cache = new Map<string, string | undefined>();

  constructor(
    private dir: string,
    private ps: PsRunner = runPowerShell,
  ) {}

  private file(key: string) {
    checkKey(key);
    return path.join(this.dir, `${key.replace(/[:@]/g, "_")}.dpapi`);
  }

  get(key: string) {
    if (this.cache.has(key)) return this.cache.get(key);
    let value: string | undefined;
    try {
      const blob = fs.readFileSync(this.file(key), "utf8").trim();
      value = Buffer.from(this.ps(DPAPI_SCRIPT("Unprotect"), blob), "base64").toString("utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw new Error(`Couldn't decrypt secret "${key}" (was it created by another Windows user?): ${e.message}`);
    }
    this.cache.set(key, value);
    return value;
  }

  set(key: string, value: string) {
    const blob = this.ps(DPAPI_SCRIPT("Protect"), Buffer.from(value, "utf8").toString("base64"));
    if (!/^[A-Za-z0-9+/=]+$/.test(blob)) throw new Error("DPAPI returned unexpected output");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(key);
    fs.writeFileSync(`${f}.tmp`, blob, { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
    this.cache.set(key, value);
  }

  delete(key: string) {
    fs.rmSync(this.file(key), { force: true });
    this.cache.set(key, undefined);
  }
}

export class LibSecret implements SecretStore {
  readonly kind = "libsecret";
  constructor(private service = SERVICE) {}

  get(key: string) {
    checkKey(key);
    const r = spawnSync("secret-tool", ["lookup", "service", this.service, "account", key], { encoding: "utf8" });
    return r.status === 0 && r.stdout ? r.stdout : undefined;
  }

  set(key: string, value: string) {
    checkKey(key);
    const r = spawnSync("secret-tool", ["store", "--label", `${this.service} ${key}`, "service", this.service, "account", key], { input: value, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Secret Service write failed: ${r.stderr.trim()}`);
  }

  delete(key: string) {
    checkKey(key);
    spawnSync("secret-tool", ["clear", "service", this.service, "account", key]);
  }
}

export class FileSecrets implements SecretStore {
  readonly kind = "file";
  constructor(private dir: string) {}

  private file(key: string) {
    checkKey(key);
    return path.join(this.dir, `${key.replace(/[:@]/g, "_")}.secret`);
  }

  get(key: string) {
    try {
      return fs.readFileSync(this.file(key), "utf8");
    } catch {
      return undefined;
    }
  }

  set(key: string, value: string) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(key);
    fs.writeFileSync(`${f}.tmp`, value, { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }

  delete(key: string) {
    fs.rmSync(this.file(key), { force: true });
  }
}

const hasCommand = (cmd: string) => {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const cache = new Map<string, SecretStore>();

/** The best secret store available on this machine. */
export function openSecretStore(dataDir: string): SecretStore {
  const mode = process.env.SLOPBOT_SECRETS ?? "auto";
  const id = `${mode}|${dataDir}`;
  let store = cache.get(id);
  if (store) return store;
  if (mode !== "file" && process.platform === "darwin" && fs.existsSync("/usr/bin/security")) store = new MacKeychain();
  else if (mode !== "file" && process.platform === "win32") store = new WinDpapi(path.join(dataDir, "secrets"));
  else if (mode !== "file" && process.platform === "linux" && hasCommand("secret-tool")) store = new LibSecret();
  else store = new FileSecrets(path.join(dataDir, "secrets"));
  cache.set(id, store);
  return store;
}

// ── secret references ───────────────────────────────────────────────
// Config files hold `${secret:NAME}`; the value lives in the secret store and is resolved only in
// the process that needs it (never sent to the UI or the model).

export const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9._:@-]{1,200})\}/g;
export const isSecretRef = (v: string) => /^\$\{secret:[A-Za-z0-9._:@-]{1,200}\}$/.test(v);
export const secretRef = (key: string) => `\${secret:${key}}`;

export class MissingSecretError extends Error {
  constructor(public key: string) {
    super(`Secret "${key}" isn't in your ${process.platform === "darwin" ? "Keychain" : process.platform === "win32" ? "Windows secret store" : "secret store"}. Re-enter it (for a connector: Edit → paste the key again).`);
  }
}

/** Replace every ${secret:NAME} in `s` with its stored value. */
export function resolveSecretRefs(s: string, store: SecretStore): string {
  return s.replace(SECRET_REF_RE, (_, key) => {
    const v = store.get(key);
    if (v === undefined) throw new MissingSecretError(key);
    return v;
  });
}

const SECRET_NAME = /(api[-_]?key|apikey|token|secret|passw|pwd|auth|credential|bearer|cookie|session|private[-_]?key|access[-_]?key|(^|[-_])pat($|[-_]))/i;
const SECRET_PREFIX = /^(Bearer\s+\S|Basic\s+\S|sk-|sk_|rk_|pk_live|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|AKIA|ASIA|AIza|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.|hf_|lin_api_|ntn_|secret_|shpat_|SG\.)/;

/** Heuristic: should this env var / header / argument value live in the secret store? */
export function looksSecret(name: string, value: string): boolean {
  if (!value || value.includes("${")) return false; // empty, or already a reference
  if (/^(\/|~|\.{1,2}\/|[A-Za-z]:\\)/.test(value)) return false; // a file path
  if (/^(true|false|\d+)$/i.test(value)) return false;
  if (/^Bearer\s*$/i.test(value)) return false; // placeholder waiting for a token
  if (SECRET_PREFIX.test(value)) return true;
  if (name && SECRET_NAME.test(name)) return true;
  // Long, random-looking strings (no spaces/slashes, mixed letters and digits).
  return value.length >= 24 && !/[\s/]/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

// ── scrubbing secrets out of text that gets written to disk ─────────────
// Logs and saved conversations must not keep keys that happen to appear in messages, URLs,
// request bodies or tool output. Recognizable credential formats are replaced with [redacted].
const SCRUB_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
  [/\b(?:sk-(?:proj-|ant-(?:api\d+-)?)?|sk_(?:live|test)_|rk_(?:live|test)_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpr]-|hf_|lin_api_|ntn_|shpat_|tvly-|gsk_|AIza)[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted jwt]"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, "[redacted]"], // Telegram bot token
  [/(\/\/)[^/\s:@'"]+:[^/\s@'"]+@/g, "$1[redacted]@"], // user:password@ in URLs
  [/([?&](?:api[_-]?key|apikey|key|token|access_token|refresh_token|secret|client_secret|password|pass|auth|sig|signature)=)[^&\s"'<>]+/gi, "$1[redacted]"],
  [/("(?:password|passwd|secret|api_?key|apikey|token|access_token|refresh_token|client_secret|private_key)"\s*:\s*")[^"]{4,}"/gi, '$1[redacted]"'],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SCRUB_PATTERNS) out = out.replace(re, rep);
  return out;
}
