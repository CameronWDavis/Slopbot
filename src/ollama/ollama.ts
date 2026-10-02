// Talks to a local Ollama server (https://github.com/ollama/ollama/blob/main/docs/api.md) and
// manages the Ollama process, so people can get open models running without a terminal.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";

export interface OllamaModel {
  name: string;
  size: number; // bytes on disk
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  /** From /api/show: "completion", "tools", "thinking", "vision", ... (undefined if unknown) */
  capabilities?: string[];
  /** Currently loaded in memory (from /api/ps). */
  loaded?: boolean;
  vram?: number;
}

export interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  done?: boolean;
  error?: string;
}

export interface OllamaInstall {
  binary?: string;
  app?: string; // macOS Ollama.app path
}

const DEFAULT_URL = "http://localhost:11434";

/** The Ollama base URL from config: the provider named "ollama", or any on port 11434. */
export function ollamaUrl(config: Config): string {
  const entries = Object.entries(config.providers);
  const p = entries.find(([n]) => n === "ollama")?.[1] ?? entries.find(([, v]) => /:11434\b/.test(v.baseUrl ?? ""))?.[1];
  return (p?.baseUrl ?? DEFAULT_URL).replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

/** The provider name SlopBot uses for Ollama models ("ollama" unless configured differently). */
export function ollamaProviderName(config: Config): string {
  const entries = Object.entries(config.providers);
  return entries.find(([n]) => n === "ollama")?.[0] ?? entries.find(([, v]) => /:11434\b/.test(v.baseUrl ?? ""))?.[0] ?? "ollama";
}

export class Ollama {
  private spawned?: ReturnType<typeof spawn>;

  constructor(public baseUrl = DEFAULT_URL) {}

  private async api<T>(p: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await fetch(`${this.baseUrl}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body;
      try {
        msg = JSON.parse(body).error ?? body;
      } catch {}
      throw new Error(`Ollama ${p}: ${res.status} ${msg}`.trim());
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Server version, or null if Ollama isn't running. */
  async version(): Promise<string | null> {
    try {
      return (await this.api<{ version: string }>("/api/version", { timeoutMs: 1500 })).version ?? "unknown";
    } catch {
      return null;
    }
  }

  async list(): Promise<OllamaModel[]> {
    const [tags, ps] = await Promise.all([
      this.api<{ models?: any[] }>("/api/tags"),
      this.api<{ models?: any[] }>("/api/ps").catch(() => ({ models: [] as any[] })),
    ]);
    const loaded = new Map((ps.models ?? []).map((m: any) => [m.name ?? m.model, m.size_vram ?? m.size]));
    const models: OllamaModel[] = (tags.models ?? []).map((m: any) => ({
      name: m.name ?? m.model,
      size: m.size ?? 0,
      modifiedAt: m.modified_at,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      loaded: loaded.has(m.name ?? m.model),
      vram: loaded.get(m.name ?? m.model),
    }));
    // Capabilities tell us whether a model can call tools (bots need that).
    await Promise.all(
      models.map(async (m) => {
        try {
          m.capabilities = (await this.api<{ capabilities?: string[] }>("/api/show", { method: "POST", body: JSON.stringify({ model: m.name }) })).capabilities;
        } catch {
          /* older Ollama: unknown */
        }
      }),
    );
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Download a model, reporting overall progress across all its layers. Resolves when done;
   * rejects on error or abort.
   */
  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama pull failed: ${res.status} ${await res.text()}`);
    const layers = new Map<string, { total: number; completed: number }>();
    let buf = "";
    let status = "starting";
    const decoder = new TextDecoder();
    const emit = (extra: Partial<PullProgress> = {}) => {
      let total = 0;
      let completed = 0;
      for (const l of layers.values()) (total += l.total), (completed += l.completed);
      onProgress({ model, status, completed, total, ...extra });
    };
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        status = ev.status ?? status;
        if (ev.digest && ev.total) layers.set(ev.digest, { total: ev.total, completed: ev.completed ?? 0 });
        if (ev.status === "success") return void emit({ done: true });
        emit();
      }
    }
    throw new Error("Pull ended before Ollama reported success");
  }

  async delete(model: string) {
    await this.api("/api/delete", { method: "DELETE", body: JSON.stringify({ model }) });
  }

  /** Free the model's memory now instead of waiting for Ollama's idle timeout. */
  async unload(model: string) {
    await this.api("/api/generate", { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }), timeoutMs: 30_000 });
  }

  // ── process management ────────────────────────────
  static detect(): OllamaInstall {
    const install: OllamaInstall = {};
    for (const app of ["/Applications/Ollama.app", path.join(os.homedir(), "Applications/Ollama.app")]) {
      if (fs.existsSync(app)) install.app = app;
    }
    try {
      install.binary = execFileSync("/bin/sh", ["-c", "command -v ollama"], { encoding: "utf8" }).trim() || undefined;
    } catch {
      /* not on PATH */
    }
    if (!install.binary && install.app && fs.existsSync(`${install.app}/Contents/Resources/ollama`)) {
      install.binary = `${install.app}/Contents/Resources/ollama`;
    }
    return install;
  }

  /** Start Ollama (the menu-bar app if installed, else `ollama serve`) and wait until it answers. */
  async start(timeoutMs = 20_000): Promise<string> {
    if (await this.version()) return (await this.version())!;
    const install = Ollama.detect();
    if (process.platform === "darwin" && install.app) {
      spawnSync("open", ["-a", install.app]);
    } else if (install.binary) {
      this.spawned = spawn(install.binary, ["serve"], { detached: true, stdio: "ignore" });
      this.spawned.unref();
    } else {
      throw new Error("Ollama isn't installed. Get it from https://ollama.com/download");
    }
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await this.version();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("Ollama didn't start in time");
  }

  /** Stop Ollama, however it was started. */
  async stop(timeoutMs = 10_000): Promise<void> {
    if (this.spawned?.pid) {
      try {
        process.kill(this.spawned.pid);
      } catch {}
      this.spawned = undefined;
    }
    if (process.platform === "darwin") spawnSync("osascript", ["-e", 'if application "Ollama" is running then quit app "Ollama"']);
    spawnSync("pkill", ["-f", "ollama serve"]);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && (await this.version())) await new Promise((r) => setTimeout(r, 300));
    if (await this.version()) throw new Error("Ollama is still running");
  }
}
