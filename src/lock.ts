// Single-instance locks (e.g. only one process may poll Telegram or run schedules).
import fs from "node:fs";
import path from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
};

const heldHere = new Set<string>();

/**
 * Take the named lock, or return null if another live process (or another holder in this process)
 * has it. Locks left by crashed processes are reclaimed.
 */
export function acquireLock(dataDir: string, name: string): { release: () => void } | null {
  const file = path.resolve(dataDir, `${name}.lock`);
  if (heldHere.has(file)) return null;
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      heldHere.add(file);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        heldHere.delete(file);
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.rmSync(file);
        } catch {}
      };
      process.once("exit", release);
      return { release };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (pid && pid !== process.pid && alive(pid)) return null;
      fs.rmSync(file, { force: true }); // stale (crashed process) → retry once
    }
  }
  return null;
}
