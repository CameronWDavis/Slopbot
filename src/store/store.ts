// Plain-file persistence. Everything a bot does is inspectable with `cat`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message, ToolCall } from "../providers/types.js";

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

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export const newId = (prefix = "") => prefix + crypto.randomBytes(4).toString("hex");

export class Store {
  constructor(public dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  workspaceDir(bot: string) {
    return this.p("workspaces", bot);
  }

  // ── audit ──────────────────────────────────────────────
  audit(ev: AuditEvent) {
    const line = JSON.stringify(redact({ ts: new Date().toISOString(), ...ev }));
    fs.appendFileSync(this.p("audit.jsonl"), line + "\n");
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
    this.writeJson(this.p("sessions", bot, `${id}.json`), { bot, id, updatedAt: new Date().toISOString(), messages });
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
