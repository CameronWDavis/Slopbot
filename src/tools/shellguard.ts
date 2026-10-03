// Limits what an approved shell.run command can touch. Approval says "run this command", not
// "this command may read my SSH keys": so commands get a stripped environment (no API keys from
// .env or the parent process) and, where the OS supports it, a filesystem sandbox:
//   macOS  – sandbox-exec: writes only inside the bot's folders, temp and package caches; no reads of
//            SSH/cloud/browser credentials or SlopBot's own data; no Keychain access.
//   Linux  – bubblewrap (bwrap) if installed: same idea using a read-only view of the system.
//   Windows / Linux without bwrap – environment stripping only.
// Network access is not restricted (builds and git need it); http requests the bot makes itself
// go through http.fetch, which is policed separately.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP", "TZ", "PWD",
  "COLORTERM", "EDITOR", "PAGER", "NVM_DIR", "NVM_BIN", "PYENV_ROOT", "GOPATH", "GOROOT", "JAVA_HOME", "HOMEBREW_PREFIX",
  // Windows essentials
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "PSMODULEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);

/** Only the variables a build/test/git command needs. API keys and tokens never reach the shell. */
export function minimalEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const K = k.toUpperCase();
    if (KEEP_ENV.has(K) || K.startsWith("LC_")) out[k] = v;
  }
  out.CI = "1";
  return out;
}

/** Credential and private-data locations under the home folder that commands never get to see. */
const HOME_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc",
  ".git-credentials", ".config/gh", ".config/hub", ".password-store", ".terraform.d", ".vault-token",
  "Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Safari",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/SlopBot", ".config/google-chrome", ".mozilla", ".config/chromium", ".local/share/keyrings",
];
/** Caches package managers write to (so `npm install`, `pip install` etc. still work). */
const HOME_CACHES = [".npm", ".cache", ".pnpm-store", ".yarn", ".cargo/registry", ".cargo/git", ".gradle", ".m2", "Library/Caches", "go/pkg"];

export interface SandboxSpec {
  roots: string[];
  dataDir: string;
  rootDir: string;
  home?: string;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/** Files in the project folder holding keys (.env, .env.local, connector list, config). */
function projectSecretFiles(rootDir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(rootDir);
  } catch {}
  return names.filter((n) => /^\.env(\..+)?$/.test(n) && n !== ".env.example").concat(["slopbot.mcp.json", "slopbot.config.yaml"]).map((n) => path.join(real(rootDir), n));
}

const sbStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** sandbox-exec profile (later rules take precedence over earlier ones). */
export function macProfile(spec: SandboxSpec): string {
  const home = real(spec.home ?? os.homedir());
  const roots = spec.roots.map(real);
  const data = real(spec.dataDir);
  const tmp = [...new Set([real(os.tmpdir()), "/private/tmp", "/private/var/folders"])];
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${sbStr(p)})`).join(" ");
  const lit = (ps: string[]) => ps.map((p) => `(literal ${sbStr(p)})`).join(" ");
  const rootsInData = roots.filter((r) => inside(r, data));
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${sub([...roots, ...tmp, ...HOME_CACHES.map((c) => path.join(home, c))])} (regex #"^/dev/"))`,
    `(deny file-read-data file-write* ${sub([...HOME_SECRETS.map((s) => path.join(home, s)), data])})`,
    // A bot's own workspace normally lives in data/workspaces/<bot>; give that back.
    rootsInData.length ? `(allow file-read-data file-write* ${sub(rootsInData)})` : "",
    `(deny file-read-data file-write* ${lit(projectSecretFiles(spec.rootDir))})`,
    // No Keychain: `security find-generic-password` would otherwise hand over saved keys.
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
  ]
    .filter(Boolean)
    .join("\n");
}

/** bubblewrap arguments: read-only system, writable roots/temp/caches, secrets hidden. */
export function bwrapArgs(spec: SandboxSpec): string[] {
  const home = real(spec.home ?? os.homedir());
  const roots = spec.roots.map(real);
  const data = real(spec.dataDir);
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent"];
  for (const c of HOME_CACHES.map((c) => path.join(home, c))) if (fs.existsSync(c)) args.push("--bind", c, c);
  for (const s of [...HOME_SECRETS.map((s) => path.join(home, s)), data]) {
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).isDirectory()) args.push("--tmpfs", s);
    else args.push("--ro-bind", "/dev/null", s);
  }
  for (const r of roots) args.push("--bind", r, r);
  for (const f of projectSecretFiles(spec.rootDir)) if (fs.existsSync(f)) args.push("--ro-bind", "/dev/null", f);
  return args;
}

let bwrapWorks: boolean | undefined;
function haveBwrap(): boolean {
  // Some distros ship bwrap but block unprivileged namespaces; probe once.
  bwrapWorks ??= spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { timeout: 5000 }).status === 0;
  return bwrapWorks;
}

export type SandboxKind = "macos-sandbox" | "bubblewrap" | "env-only" | "off";

/** Wrap a shell invocation in the OS sandbox when one is available. */
export function sandboxed(
  sh: { file: string; args: string[] },
  spec: SandboxSpec,
  opts: { enabled?: boolean; platform?: NodeJS.Platform } = {},
): { file: string; args: string[]; kind: SandboxKind } {
  const platform = opts.platform ?? process.platform;
  if (opts.enabled === false) return { ...sh, kind: "off" };
  if (platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return { file: "/usr/bin/sandbox-exec", args: ["-p", macProfile(spec), sh.file, ...sh.args], kind: "macos-sandbox" };
  }
  if (platform === "linux" && haveBwrap()) {
    return { file: "bwrap", args: [...bwrapArgs(spec), "--", sh.file, ...sh.args], kind: "bubblewrap" };
  }
  return { ...sh, kind: "env-only" };
}
