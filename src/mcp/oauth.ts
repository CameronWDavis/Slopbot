// OAuth for remote MCP servers (Notion, Linear, Atlassian, ...). The MCP SDK does discovery,
// dynamic client registration, PKCE and token refresh; this file supplies what a client app must:
// a token store, a loopback redirect listener, and a way to open the user's browser.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretStore } from "../secrets.js";

/** Fixed loopback port: the redirect URI is registered with each server, so it must be stable. */
export const OAUTH_CALLBACK_PORT = Number(process.env.SLOPBOT_OAUTH_PORT ?? 33418);
export const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/oauth/callback`;

interface AuthRecord {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  state?: string;
  savedAt?: string;
}

/**
 * Per-server OAuth state (client registration, tokens, PKCE verifier) in the OS secret store:
 * the macOS Keychain, libsecret on Linux, or 0600 files as a fallback. Token files written by
 * older versions under <data>/mcp-auth are moved into the secret store on first read.
 */
export class AuthStore {
  private cache = new Map<string, { at: number; rec: AuthRecord }>();
  private static TTL_MS = 3000; // the SDK reads tokens on every request; other processes may refresh them

  constructor(
    readonly secrets: SecretStore,
    private legacyDir?: string,
  ) {}

  private key(server: string) {
    return `mcp-oauth:${server.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  }

  private legacyFile(server: string) {
    return this.legacyDir ? path.join(this.legacyDir, `${server.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`) : undefined;
  }

  read(server: string): AuthRecord {
    const hit = this.cache.get(server);
    if (hit && Date.now() - hit.at < AuthStore.TTL_MS) return hit.rec;
    let rec: AuthRecord = {};
    const raw = this.secrets.get(this.key(server));
    if (raw) {
      try {
        rec = JSON.parse(raw);
      } catch {
        rec = {};
      }
    } else {
      const legacy = this.legacyFile(server);
      if (legacy && fs.existsSync(legacy)) {
        rec = JSON.parse(fs.readFileSync(legacy, "utf8"));
        this.secrets.set(this.key(server), JSON.stringify(rec));
        fs.rmSync(legacy, { force: true });
      }
    }
    this.cache.set(server, { at: Date.now(), rec });
    return rec;
  }

  update(server: string, patch: Partial<AuthRecord>) {
    const next: AuthRecord = { ...this.read(server), ...patch, savedAt: new Date().toISOString() };
    for (const k of Object.keys(next) as (keyof AuthRecord)[]) if (next[k] === undefined) delete next[k];
    this.secrets.set(this.key(server), JSON.stringify(next));
    this.cache.set(server, { at: Date.now(), rec: next });
  }

  clear(server: string) {
    this.secrets.delete(this.key(server));
    const legacy = this.legacyFile(server);
    if (legacy) fs.rmSync(legacy, { force: true });
    this.cache.delete(server);
  }

  isSignedIn(server: string) {
    return !!this.read(server).tokens?.access_token;
  }
}

/**
 * The SDK calls this during connect. In interactive mode (the user clicked "Sign in") it opens the
 * browser; otherwise a missing/expired login just fails, so background runs never pop up windows.
 */
export class SlopOAuthProvider implements OAuthClientProvider {
  redirected = false;

  constructor(
    private store: AuthStore,
    private server: string,
    private openUrl?: (url: string) => void | Promise<void>,
  ) {}

  get redirectUrl() {
    return OAUTH_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SlopBot",
      client_uri: "https://github.com/CameronWDavis/SlopBot",
      redirect_uris: [OAUTH_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    const state = crypto.randomBytes(16).toString("hex");
    this.store.update(this.server, { state });
    return state;
  }

  clientInformation() {
    return this.store.read(this.server).client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.store.update(this.server, { client });
  }
  tokens() {
    return this.store.read(this.server).tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.store.update(this.server, { tokens });
  }
  saveCodeVerifier(verifier: string) {
    this.store.update(this.server, { verifier });
  }
  codeVerifier() {
    const v = this.store.read(this.server).verifier;
    if (!v) throw new Error("No PKCE verifier saved");
    return v;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.store.update(this.server, { discovery });
  }
  discoveryState() {
    return this.store.read(this.server).discovery;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") return this.store.clear(this.server);
    const key = ({ client: "client", tokens: "tokens", verifier: "verifier", discovery: "discovery" } as const)[scope];
    this.store.update(this.server, { [key]: undefined });
  }

  async redirectToAuthorization(url: URL) {
    if (!this.openUrl) throw new NeedsSignInError(this.server);
    // The address comes from the server: only ever open a web page with it (never file:, custom
    // schemes or anything the OS would launch). Plain http only for this computer.
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password)
      throw new Error(`"${this.server}" asked to open an unsafe sign-in address (${url.protocol}//…). Not opened.`);
    this.redirected = true;
    await this.openUrl(url.toString());
  }
}

export class NeedsSignInError extends Error {
  constructor(public server: string) {
    super(`"${server}" needs you to sign in. Open Connectors and click Sign in.`);
  }
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#07040d;color:#f6ecff;font:16px system-ui">
<div style="text-align:center;border:1px solid #ff2bd6;box-shadow:0 0 30px rgba(255,43,214,.35);padding:32px 44px">
<div style="font:700 22px system-ui;letter-spacing:.2em;color:#ff7ae6">SLOPBOT</div><h2>${title}</h2><p style="color:#a493c4">${body}</p></div>`;

/**
 * Listen on the loopback redirect URI for one authorization code. Resolves with the code once the
 * browser comes back with a matching `state`.
 */
export function waitForAuthCode(expectedState: () => string | undefined, timeoutMs = 5 * 60_000): { code: Promise<string>; close: () => void } {
  let server: http.Server;
  let timer: NodeJS.Timeout;
  const code = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", OAUTH_REDIRECT);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const c = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (err || !c) {
        res.end(page("Sign-in cancelled", `The server said: ${(url.searchParams.get("error_description") ?? err ?? "no code").replace(/[<>&]/g, "")}`));
        reject(new Error(`Sign-in failed: ${err ?? "no code returned"}`));
      } else if (expectedState() && state !== expectedState()) {
        res.end(page("Sign-in rejected", "The response didn't match this sign-in attempt."));
        reject(new Error("Sign-in failed: state mismatch"));
      } else {
        res.end(page("Signed in ✓", "You can close this tab and go back to SlopBot."));
        resolve(c);
      }
    });
    server.on("error", (e: any) =>
      reject(new Error(e.code === "EADDRINUSE" ? `Port ${OAUTH_CALLBACK_PORT} is busy (another sign-in in progress?)` : e.message)),
    );
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1");
    timer = setTimeout(() => reject(new Error("Sign-in timed out after 5 minutes")), timeoutMs);
  });
  const close = () => {
    clearTimeout(timer);
    server?.close();
  };
  code.finally(close).catch(() => {});
  return { code, close };
}
