import { spawn } from "node:child_process";
import { obj, safePath, type Tool } from "./types.js";

const MAX_OUTPUT = 64_000;

export const shellTools: Tool[] = [
  {
    name: "shell.run",
    description:
      "Run a shell command (bash -lc) with the working directory inside your sandbox. Use for builds, tests, git, scripts. Returns exit code, stdout, and stderr.",
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
        const child = spawn("bash", ["-lc", command], { cwd: dir, env: { ...process.env, CI: "1" } });
        let out = "";
        const add = (b: Buffer) => {
          if (out.length < MAX_OUTPUT) out += b.toString();
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
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
