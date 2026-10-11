// Plain-file persistence. Everything a bot does is inspectable with `cat`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message, ToolCall } from "../providers/types.js";
import { scrubSecrets } from "../secrets.js";

export interface AuditEvent {
  ts?: string;
  bot: string;
  session: string;
  type: "run.start" | "run.end" | "model" | "tool" | "approval" | "error";
  [k: string]: unknown;
}

export interface Approval {
  id: string;
  bot: string;
  session: string;
  call: ToolCall;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt?: string;
  result?: string;
}

export interface MemoryNote {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
}

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization/i;

/**
 * Remove secrets before anything is written to disk: values under secret-looking keys, and
 * recognizable credentials inside any string (URLs, bodies, messages, tool output).
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export const newId = (prefix = "") => prefix + crypto.randomBytes(4).toString("hex");

export interface StoreOptions {
  /** Delete saved conversations, activity entries and resolved approvals older than this. 0 = keep forever. */
  retentionDays?: number;
}

export class Store {
  constructor(
    public dataDir: string,
    opts: StoreOptions = {},
  ) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.lockDown();
    this.prune(opts.retentionDays ?? 30);
  }

  /** The data folder is private to this user: 0700 folder, 0600 files (no effect on Windows). */
  private lockDown() {
    if (process.platform === "win32") return;
    const fix = (p: string, mode: number) => {
      try {
        if ((fs.statSync(p).mode & 0o777) !== mode) fs.chmodSync(p, mode);
      } catch {}
    };
    fix(this.dataDir, 0o700);
    for (const f of ["audit.jsonl", "approvals.json"]) fix(this.p(f), 0o600);
    for (const f of ["scheduler.lock"]) fix(this.p(f), 0o600);
    for (const dir of ["sessions", "memory", "channels", "workspaces", "shopping", "skills"]) {
      const walk = (d: string) => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        fix(d, 0o700);
        for (const e of entries) e.isDirectory() ? walk(path.join(d, e.name)) : fix(path.join(d, e.name), 0o600);
      };
      walk(this.p(dir));
    }
  }

  /** Keep only recent history (the user can set retentionDays: 0 to keep everything). */
  private prune(days: number) {
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    // Conversations
    try {
      for (const bot of fs.readdirSync(this.p("sessions"))) {
        const dir = this.p("sessions", bot);
        for (const f of fs.readdirSync(dir)) {
          const file = path.join(dir, f);
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        }
      }
    } catch {}
    // Activity log
    try {
      const lines = fs.readFileSync(this.p("audit.jsonl"), "utf8").split("\n").filter(Boolean);
      const keep = lines.filter((l) => {
        try {
          return Date.parse(JSON.parse(l).ts) >= cutoff;
        } catch {
          return false;
        }
      });
      if (keep.length !== lines.length) {
        fs.writeFileSync(this.p("audit.jsonl"), keep.map((l) => l + "\n").join(""), { mode: 0o600 });
      }
    } catch {}
    // Resolved approvals (pending ones stay until you decide)
    const approvals = this.listApprovals();
    const keep = approvals.filter((a) => a.status === "pending" || Date.parse(a.resolvedAt ?? a.createdAt) >= cutoff);
    if (keep.length !== approvals.length) this.writeJson(this.p("approvals.json"), keep);
  }

  private p(...parts: string[]) {
    return path.join(this.dataDir, ...parts);
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  workspaceDir(bot: string) {
    return this.p("workspaces", bot);
  }

  // ── audit ──────────────────────────────────────────────
  audit(ev: AuditEvent) {
    const line = JSON.stringify(redact({ ts: new Date().toISOString(), ...ev }));
    fs.appendFileSync(this.p("audit.jsonl"), line + "\n", { mode: 0o600 });
  }

  readAudit(opts: { bot?: string; limit?: number } = {}): AuditEvent[] {
    let text = "";
    try {
      text = fs.readFileSync(this.p("audit.jsonl"), "utf8");
    } catch {
      return [];
    }
    let events = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent);
    if (opts.bot) events = events.filter((e) => e.bot === opts.bot);
    return events.slice(-(opts.limit ?? 50));
  }

  // ── sessions ───────────────────────────────────────────
  saveSession(bot: string, id: string, messages: Message[]) {
    // Saved conversations get the same secret scrubbing as the activity log.
    this.writeJson(this.p("sessions", bot, `${id}.json`), redact({ bot, id, updatedAt: new Date().toISOString(), messages }));
  }

  // ── approvals ──────────────────────────────────────────
  listApprovals(): Approval[] {
    return this.readJson<Approval[]>(this.p("approvals.json"), []);
  }

  addApproval(a: Omit<Approval, "id" | "status" | "createdAt">): Approval {
    const all = this.listApprovals();
    const approval: Approval = { ...a, id: newId("ap_"), status: "pending", createdAt: new Date().toISOString() };
    all.push(approval);
    this.writeJson(this.p("approvals.json"), all);
    return approval;
  }

  updateApproval(id: string, patch: Partial<Approval>): Approval {
    const all = this.listApprovals();
    const a = all.find((x) => x.id === id);
    if (!a) throw new Error(`No approval ${id}`);
    Object.assign(a, patch);
    this.writeJson(this.p("approvals.json"), all);
    return a;
  }

  // ── memory ─────────────────────────────────────────────
  readMemory(bot: string): MemoryNote[] {
    return this.readJson<MemoryNote[]>(this.p("memory", `${bot}.json`), []);
  }

  writeMemory(bot: string, notes: MemoryNote[]) {
    this.writeJson(this.p("memory", `${bot}.json`), notes);
  }
}
