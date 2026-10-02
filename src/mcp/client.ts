// MCP client side: bots use external MCP servers (GitHub, filesystem, browser, ...) as tools.
//
// Servers live in <home>/slopbot.mcp.json using the same "mcpServers" shape as Claude Desktop /
// Cursor, plus two SlopBot fields: `bots` (which bots get the server; "*" = all) and `enabled`.
// Each server's tools appear to a bot as `mcp.<server>.<tool>`, gated by the normal policy engine.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthStore, NeedsSignInError, SlopOAuthProvider, waitForAuthCode } from "./oauth.js";
import type { Config } from "../config.js";
import type { Risk, Tool } from "../tools/types.js";

export const MCP_FILE = "slopbot.mcp.json";

export interface McpServerDef {
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** remote (Streamable HTTP, falls back to SSE) */
  url?: string;
  headers?: Record<string, string>;
  /** SlopBot extensions */
  bots?: string[]; // bot names, or ["*"]
  enabled?: boolean;
  description?: string;
}

export interface McpToolInfo {
  name: string; // as the server names it
  slopName: string; // mcp.<server>.<tool>
  description: string;
  risk: Risk;
}

export interface McpServerStatus {
  name: string;
  def: McpServerDef;
  state: "disabled" | "idle" | "connecting" | "connected" | "error" | "needs_auth";
  error?: string;
  /** For remote servers that use OAuth instead of a pasted token. */
  oauth?: "signed_in" | "signed_out";
  tools: McpToolInfo[];
}

const CONNECT_TIMEOUT_MS = 90_000; // first `npx` run downloads the package
const CALL_TIMEOUT_MS = 120_000;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "x";

/** Tool name in SlopBot (and, with dots → "__", on the wire). Kept ≤ 64 chars on the wire. */
export function slopToolName(server: string, tool: string): string {
  const s = slug(server);
  let t = tool.replace(/[^a-zA-Z0-9-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "tool";
  const max = 64 - `mcp__${s}__`.length;
  if (t.length > max) t = t.slice(0, max - 7) + "_" + crypto.createHash("sha1").update(tool).digest("hex").slice(0, 6);
  return `mcp.${s}.${t}`;
}

/** Map MCP tool annotations onto SlopBot risk levels (so the policy engine knows what needs approval). */
export function riskFromAnnotations(a: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined): Risk {
  if (a?.readOnlyHint) return "read";
  if (a?.destructiveHint) return "dangerous";
  return "external";
}

const interpolate = (s: string) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "");
const tilde = (s: string) => (s === "~" || s.startsWith("~/") ? path.join(os.homedir(), s.slice(1)) : s);
const interpolateMap = (m?: Record<string, string>) =>
  m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, interpolate(String(v))])) : undefined;

function resultToText(res: any): string {
  const parts: string[] = [];
  for (const c of res.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
    else if (c.type === "resource_link") parts.push(`[resource ${c.uri}]`);
    else parts.push(`[${c.type} omitted]`);
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2));
  return parts.join("\n") || "(no output)";
}

interface Conn {
  client: Client;
  transport: Transport;
  tools: Array<McpToolInfo & { schema: Record<string, unknown> }>;
  stderr: string[];
}

export class McpManager {
  readonly file: string;
  private conns = new Map<string, Conn>();
  private connecting = new Map<string, Promise<Conn>>();
  private errors = new Map<string, string>();

  readonly auth: AuthStore;
  private needsAuth = new Set<string>();

  /**
   * @param openUrl opens the user's browser for OAuth sign-in. Without it (CLI, MCP-server mode)
   *   servers that need a sign-in report "needs_auth" instead of popping up anything.
   */
  constructor(
    private config: Config,
    private openUrl?: (url: string) => void | Promise<void>,
  ) {
    this.file = path.join(config.rootDir, MCP_FILE);
    this.auth = new AuthStore(path.join(config.dataDir, "mcp-auth"));
  }

  // ── config file ──────────────────────────────────────
  readServers(): Record<string, McpServerDef> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")).mcpServers ?? {};
    } catch {
      return {};
    }
  }

  private writeServers(servers: Record<string, McpServerDef>) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }

  async saveServer(name: string, def: McpServerDef, previousName?: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,40}$/.test(name)) throw new Error("Name: letters, numbers, spaces, - _ . (max 40)");
    if (!def.command && !def.url) throw new Error("A server needs either a command or a URL");
    const servers = this.readServers();
    if (previousName && previousName !== name) {
      delete servers[previousName];
      await this.disconnect(previousName);
    }
    servers[name] = def;
    this.writeServers(servers);
    await this.disconnect(name); // reconnect lazily with the new settings
  }

  async removeServer(name: string) {
    const servers = this.readServers();
    delete servers[name];
    this.writeServers(servers);
    await this.disconnect(name);
    this.auth.clear(name);
  }

  /**
   * Import Claude Desktop / Cursor style config: {"mcpServers": {...}}, a bare map of servers,
   * or a single server object (needs `name`). Returns the imported names.
   */
  async importJson(json: string, bots: string[] = ["*"]): Promise<string[]> {
    let data: any;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("That isn't valid JSON");
    }
    let map: Record<string, McpServerDef>;
    if (data?.mcpServers) map = data.mcpServers;
    else if (data?.command || data?.url) {
      if (!data.name) throw new Error('Single server JSON needs a "name" field');
      const { name, ...def } = data;
      map = { [name]: def };
    } else if (data && typeof data === "object" && Object.values(data).every((v: any) => v?.command || v?.url)) map = data;
    else throw new Error('Expected {"mcpServers": {...}} like Claude Desktop uses');

    const names: string[] = [];
    for (const [name, raw] of Object.entries(map)) {
      const def: McpServerDef = { ...raw, url: raw.url ?? (raw as any).serverUrl, bots: raw.bots ?? bots, enabled: raw.enabled ?? true };
      delete (def as any).serverUrl;
      delete (def as any).type;
      await this.saveServer(name, def);
      names.push(name);
    }
    return names;
  }

  serversForBot(bot: string): string[] {
    return Object.entries(this.readServers())
      .filter(([, d]) => d.enabled !== false && (d.bots ?? []).some((b) => b === "*" || b === bot))
      .map(([n]) => n);
  }

  // ── connections ──────────────────────────────────────
  /** Remote servers use OAuth unless the user supplied their own Authorization header. */
  private usesOAuth(def: McpServerDef) {
    return !!def.url && !Object.keys(def.headers ?? {}).some((h) => h.toLowerCase() === "authorization");
  }

  private remoteOpts(name: string, def: McpServerDef, interactive = false) {
    return {
      requestInit: { headers: interpolateMap(def.headers) },
      authProvider: this.usesOAuth(def) ? new SlopOAuthProvider(this.auth, name, interactive ? this.openUrl : undefined) : undefined,
    };
  }

  private makeTransport(name: string, def: McpServerDef, stderr: string[]): Transport {
    if (def.url) return new StreamableHTTPClientTransport(new URL(def.url), this.remoteOpts(name, def));
    const t = new StdioClientTransport({
      command: tilde(def.command!),
      args: (def.args ?? []).map((a) => tilde(interpolate(a))),
      env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? "", ...interpolateMap(def.env) },
      cwd: def.cwd ? tilde(def.cwd) : undefined,
      stderr: "pipe",
    });
    t.stderr?.on("data", (d: Buffer) => {
      stderr.push(...d.toString().split("\n").filter(Boolean));
      if (stderr.length > 40) stderr.splice(0, stderr.length - 40);
    });
    return t;
  }

  private async open(name: string, def: McpServerDef): Promise<Conn> {
    const stderr: string[] = [];
    const attempt = async (transport: Transport) => {
      const client = new Client({ name: "slopbot", version: "0.1.0" });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS))),
        ]);
      } catch (e) {
        await client.close().catch(() => {});
        throw e;
      } finally {
        clearTimeout(timer);
      }
      return client;
    };

    let transport = this.makeTransport(name, def, stderr);
    let client: Client;
    try {
      client = await attempt(transport);
    } catch (e: any) {
      if (!def.url) {
        // Keep the lines that explain the failure; drop npm's boilerplate.
        const hint = stderr
          .filter((l) => !/complete log of this run|Note that you can also install|tarball, folder, http url|^npm error (404|code \w+)?\s*$/i.test(l))
          .slice(-3)
          .join(" ⏎ ");
        throw new Error(`${e?.message ?? e}${hint ? ` (server said: ${hint})` : ""}`);
      }
      if (isAuthError(e)) throw this.usesOAuth(def) ? new NeedsSignInError(name) : new Error("Unauthorized (401): check the token in this server's Authorization header");
      // Older remote servers speak SSE instead of Streamable HTTP.
      transport = new SSEClientTransport(new URL(def.url), this.remoteOpts(name, def));
      try {
        client = await attempt(transport);
      } catch (e2: any) {
        if (isAuthError(e2) && this.usesOAuth(def)) throw new NeedsSignInError(name);
        throw new Error(e?.message ?? String(e));
      }
    }

    const tools: Conn["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          slopName: slopToolName(name, t.name),
          description: (t.description ?? t.title ?? t.name).slice(0, 1000),
          risk: riskFromAnnotations(t.annotations),
          schema: { type: "object", properties: {}, ...(t.inputSchema as object) },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { client, transport, tools, stderr };
  }

  /** Connect (once) and return the live connection; concurrent callers share the attempt. */
  async connect(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    const inflight = this.connecting.get(name);
    if (inflight) return inflight;
    const def = this.readServers()[name];
    if (!def) throw new Error(`No MCP server named "${name}"`);
    const p = this.open(name, def)
      .then((c) => {
        this.conns.set(name, c);
        this.errors.delete(name);
        this.needsAuth.delete(name);
        c.client.onclose = () => this.conns.delete(name);
        return c;
      })
      .catch((e) => {
        this.errors.set(name, e?.message ?? String(e));
        if (e instanceof NeedsSignInError) this.needsAuth.add(name);
        throw e;
      })
      .finally(() => this.connecting.delete(name));
    this.connecting.set(name, p);
    return p;
  }

  /** Connect to an unsaved definition just to list its tools ("Test connection"). */
  async test(name: string, def: McpServerDef): Promise<McpToolInfo[]> {
    const c = await this.open(name, def);
    await c.client.close().catch(() => {});
    return c.tools.map(({ schema, ...t }) => t);
  }

  async disconnect(name: string) {
    const c = this.conns.get(name);
    this.conns.delete(name);
    this.errors.delete(name);
    this.needsAuth.delete(name);
    await c?.client.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }

  status(): McpServerStatus[] {
    return Object.entries(this.readServers()).map(([name, def]) => {
      const conn = this.conns.get(name);
      const state: McpServerStatus["state"] =
        def.enabled === false
          ? "disabled"
          : conn
            ? "connected"
            : this.connecting.has(name)
              ? "connecting"
              : this.needsAuth.has(name)
                ? "needs_auth"
                : this.errors.has(name)
                  ? "error"
                  : "idle";
      return {
        name,
        def,
        state,
        error: this.errors.get(name),
        tools: conn?.tools.map(({ schema, ...t }) => t) ?? [],
        oauth: this.usesOAuth(def) ? (this.auth.isSignedIn(name) ? "signed_in" : "signed_out") : undefined,
      };
    });
  }

  // ── OAuth ────────────────────────────────────────────
  /**
   * Interactive sign-in: opens the browser at the server's login page, waits for the redirect on
   * the loopback URI, exchanges the code for tokens, then connects for real.
   */
  async signIn(name: string): Promise<void> {
    const def = this.readServers()[name];
    if (!def?.url) throw new Error(`"${name}" isn't a remote server`);
    if (!this.usesOAuth(def)) throw new Error(`"${name}" uses a token header, so there's nothing to sign in to`);
    if (!this.openUrl) throw new Error("Sign-in needs a browser. Use the SlopBot desktop app.");
    await this.disconnect(name);

    const waiter = waitForAuthCode(() => this.auth.read(name).state);
    try {
      const opts = this.remoteOpts(name, def, true);
      const transport = new StreamableHTTPClientTransport(new URL(def.url), opts);
      const client = new Client({ name: "slopbot", version: "0.1.0" });
      try {
        await client.connect(transport); // already authorized (e.g. tokens refreshed)
      } catch (e) {
        if (!opts.authProvider?.redirected) throw e;
        await transport.finishAuth(await waiter.code);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      waiter.close();
    }
    this.needsAuth.delete(name);
    await this.connect(name);
  }

  async signOut(name: string) {
    this.auth.clear(name);
    await this.disconnect(name);
  }

  // ── tools for the agent runtime ──────────────────────
  private toTool(server: string, t: Conn["tools"][number]): Tool {
    return {
      name: t.slopName,
      description: `[MCP: ${server}] ${t.description}`,
      risk: t.risk,
      parameters: t.schema,
      run: async (args) => {
        const conn = await this.connect(server);
        const res: any = await conn.client.callTool({ name: t.name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
        const text = resultToText(res);
        if (res.isError) throw new Error(text);
        return `<untrusted_content source="mcp:${server}">\n${text}\n</untrusted_content>`;
      },
    };
  }

  /** All MCP tools available to a bot. Servers that fail to connect are skipped and reported. */
  async toolsForBot(bot: string): Promise<{ tools: Tool[]; errors: Record<string, string> }> {
    const tools: Tool[] = [];
    const errors: Record<string, string> = {};
    await Promise.all(
      this.serversForBot(bot).map(async (name) => {
        try {
          const c = await this.connect(name);
          tools.push(...c.tools.map((t) => this.toTool(name, t)));
        } catch (e: any) {
          errors[name] = e?.message ?? String(e);
        }
      }),
    );
    return { tools: tools.sort((a, b) => a.name.localeCompare(b.name)), errors };
  }

  /** Look up an MCP tool by its SlopBot name (used when executing a queued approval). */
  async findTool(slopName: string): Promise<Tool | undefined> {
    for (const name of Object.keys(this.readServers())) {
      if (!slopName.startsWith(`mcp.${slug(name)}.`)) continue;
      const c = await this.connect(name);
      const t = c.tools.find((x) => x.slopName === slopName);
      if (t) return this.toTool(name, t);
    }
    return undefined;
  }
}

function isAuthError(e: any): boolean {
  return e instanceof UnauthorizedError || e instanceof NeedsSignInError || e?.code === 401 || /\b401\b|unauthori[sz]ed|invalid_token/i.test(String(e?.message ?? e));
}
