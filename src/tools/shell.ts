import { spawn, spawnSync } from "node:child_process";
import { obj, safePath, type Tool } from "./types.js";

const MAX_OUTPUT = 64_000;

/** The shell for this OS: bash on macOS/Linux, PowerShell on Windows. */
export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; name: string } {
  if (platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], name: "PowerShell" };
  }
  return { file: "bash", args: ["-lc", command], name: "bash" };
}

const SHELL_NAME = shellCommand("").name;

export const shellTools: Tool[] = [
  {
    name: "shell.run",
    description:
      `Run a ${SHELL_NAME} command with the working directory inside your sandbox (this computer runs ${process.platform === "win32" ? "Windows, so use PowerShell syntax" : process.platform === "darwin" ? "macOS" : "Linux"}). Use for builds, tests, git, scripts. Returns exit code, stdout, and stderr.`,
    risk: "dangerous",
    parameters: obj(
      {
        command: { type: "string" },
        cwd: { type: "string", description: "Working directory (default workspace)" },
        timeout_sec: { type: "integer", description: "Default 120, max 900" },
      },
      ["command"],
    ),
    async run({ command, cwd = ".", timeout_sec = 120 }, ctx) {
      const dir = safePath(ctx, cwd);
      const timeout = Math.min(Math.max(timeout_sec, 1), 900) * 1000;
      return new Promise((resolve) => {
        const sh = shellCommand(command);
        const child = spawn(sh.file, sh.args, { cwd: dir, env: { ...process.env, CI: "1" }, windowsHide: true });
        let out = "";
        const add = (b: Buffer) => {
          if (out.length < MAX_OUTPUT) out += b.toString();
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        const timer = setTimeout(() => {
          // On Windows, kill the whole process tree (child.kill only stops the shell itself).
          if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          else child.kill("SIGKILL");
          out += `\n[killed after ${timeout / 1000}s timeout]`;
        }, timeout);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(`exit code: ${code}\n${out.slice(0, MAX_OUTPUT)}`);
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve(`failed to start: ${e.message}`);
        });
      });
    },
  },
];
