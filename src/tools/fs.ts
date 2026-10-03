import fs from "node:fs";
import path from "node:path";
import { obj, safePath, type Tool, type ToolContext } from "./types.js";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

function walk(dir: string, depth: number, out: string[], base: string, limit = 500) {
  if (out.length >= limit) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    out.push(path.relative(base, full) + (ent.isDirectory() ? "/" : ""));
    if (out.length >= limit) return;
    if (ent.isDirectory() && depth > 1) walk(full, depth - 1, out, base, limit);
  }
}

/**
 * Read a text file only if its real location (after resolving every symlink) is inside the
 * sandbox. O_NOFOLLOW makes the open fail if the final path component was swapped for a symlink
 * after the check, so the check and the read refer to the same file.
 */
export function readInSandbox(ctx: ToolContext, p: string, maxBytes = Infinity): string {
  const real = safePath(ctx, p); // resolves symlinks and enforces the allowed roots
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`"${p}" is not a regular file`);
    if (st.size > maxBytes) throw new Error(`"${p}" is larger than ${maxBytes} bytes`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Write a file inside the sandbox without following a symlink planted at the final path component. */
export function writeInSandbox(ctx: ToolContext, p: string, content: string): string {
  const file = safePath(ctx, p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  safePath(ctx, path.dirname(file)); // the directory we just created must still be inside
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

export const fsTools: Tool[] = [
  {
    name: "fs.list",
    description: "List files and directories. Relative paths resolve against your workspace.",
    risk: "read",
    parameters: obj({
      path: { type: "string", description: "Directory (default: workspace root)" },
      depth: { type: "integer", description: "Recursion depth, 1-5 (default 2)" },
    }),
    async run({ path: p = ".", depth = 2 }, ctx) {
      const dir = safePath(ctx, p);
      const out: string[] = [];
      walk(dir, Math.min(Math.max(depth, 1), 5), out, dir);
      return `${dir}\n` + (out.join("\n") || "(empty)");
    },
  },
  {
    name: "fs.read",
    description: "Read a text file. Returns numbered lines. Use offset/limit for large files.",
    risk: "read",
    parameters: obj(
      {
        path: { type: "string" },
        offset: { type: "integer", description: "1-based start line" },
        limit: { type: "integer", description: "Max lines (default 400)" },
      },
      ["path"],
    ),
    async run({ path: p, offset = 1, limit = 400 }, ctx) {
      const lines = readInSandbox(ctx, p).split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = start - 1 + limit < lines.length ? `\n… (${lines.length} lines total)` : "";
      return body + more;
    },
  },
  {
    name: "fs.search",
    description: "Search file contents for a regex under a directory. Returns path:line: text matches.",
    risk: "read",
    parameters: obj(
      {
        pattern: { type: "string", description: "JavaScript regular expression" },
        path: { type: "string", description: "Directory to search (default workspace)" },
      },
      ["pattern"],
    ),
    async run({ pattern, path: p = "." }, ctx) {
      const root = safePath(ctx, p);
      const re = new RegExp(pattern, "i");
      const files: string[] = [];
      walk(root, 8, files, root, 5000);
      const hits: string[] = [];
      for (const rel of files) {
        if (rel.endsWith("/")) continue;
        const full = path.join(root, rel);
        let text: string;
        try {
          // Symlinks are resolved and checked per file: one pointing outside the sandbox is skipped.
          text = readInSandbox(ctx, full, 1_000_000);
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue; // binary
        text.split("\n").forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
        if (hits.length >= 200) break;
      }
      return hits.join("\n") || "No matches.";
    },
  },
  {
    name: "fs.write",
    description: "Create or overwrite a file with the given content. Creates parent directories.",
    risk: "write",
    parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    async run({ path: p, content }, ctx) {
      const file = writeInSandbox(ctx, p, content);
      return `Wrote ${Buffer.byteLength(content)} bytes to ${file}`;
    },
  },
  {
    name: "fs.edit",
    description: "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.",
    risk: "write",
    parameters: obj(
      {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      ["path", "old_string", "new_string"],
    ),
    async run({ path: p, old_string, new_string, replace_all = false }, ctx) {
      const text = readInSandbox(ctx, p);
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error("old_string not found in file");
      if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times; add context or set replace_all`);
      const file = writeInSandbox(ctx, p, replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string));
      return `Edited ${file} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})`;
    },
  },
];
