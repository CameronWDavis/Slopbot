// Where private, per-user data lives. Conversations, watches, purchase history, Telegram settings,
// your own skills and browser sign-ins never live inside the source checkout, even in development,
// so they can't end up in a commit or a release build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The per-user application data folder: ~/Library/Application Support/SlopBot, %APPDATA%\SlopBot, ~/.config/SlopBot. */
export function appDataRoot(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "SlopBot");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "SlopBot");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "SlopBot");
}

/** True when `dir` is a SlopBot source checkout (a developer running from the repository). */
export function isSourceCheckout(dir: string): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) return true;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "slopbot";
  } catch {
    return false;
  }
}

/** Private data for a developer running from source (kept apart from the installed app's data). */
export function devDataDir(): string {
  return process.env.SLOPBOT_DEV_DATA ? path.resolve(process.env.SLOPBOT_DEV_DATA) : path.join(appDataRoot(), "dev", "data");
}

/**
 * The data folder for a SlopBot home: `<home>/data` for an installed app (its home is already in the
 * per-user app data folder), or the private dev folder when running from a source checkout.
 * Data left inside a checkout by older versions is copied out once.
 */
export function defaultDataDir(rootDir: string): string {
  if (!isSourceCheckout(rootDir)) return path.join(rootDir, "data");
  const target = devDataDir();
  const legacy = path.join(rootDir, "data");
  if (!fs.existsSync(target) && fs.existsSync(legacy) && fs.readdirSync(legacy).length) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(legacy, target, { recursive: true });
    console.error(`slopbot: moved your data out of the source folder to ${target}. You can delete ${legacy} once you've checked it.`);
  }
  return target;
}
