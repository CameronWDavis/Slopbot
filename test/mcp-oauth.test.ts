// OAuth sign-in for remote MCP servers, against a local server that implements the real flow:
// protected-resource + auth-server discovery, dynamic client registration, PKCE, bearer tokens.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Config } from "../src/config.js";
import { McpManager } from "../src/mcp/client.js";
import { NeedsSignInError } from "../src/mcp/oauth.js";

process.env.SLOPBOT_SECRETS = "file"; // tests never touch the real Keychain

let base = "";
let srv: http.Server;
const challenges = new Map<string, string>(); // code → PKCE challenge
const log: string[] = [];
let validToken = "tok-1";

before(async () => {
  srv = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const body = await new Promise<string>((r) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => r(b));
    });
    const json = (code: number, data: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      log.push("register");
      return json(201, { ...JSON.parse(body), client_id: "client-123" });
    }
    if (url.pathname === "/authorize") {
      log.push("authorize");
      const code = crypto.randomBytes(8).toString("hex");
      challenges.set(code, url.searchParams.get("code_challenge")!);
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      log.push(`token:${form.get("grant_type")}`);
      if (form.get("grant_type") === "authorization_code") {
        const expected = challenges.get(form.get("code")!);
        const actual = crypto.createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
        if (!expected || expected !== actual) return json(400, { error: "invalid_grant" });
      }
      return json(200, { access_token: validToken, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${validToken}`) {
        return res
          .writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
          .end();
      }
      const server = new McpServer({ name: "notes-cloud", version: "1" });
      server.registerTool("list_pages", { description: "List pages", annotations: { readOnlyHint: true } }, async () => ({
        content: [{ type: "text", text: "Groceries, Budget 2026" }],
      }));
      server.registerTool("create_page", { description: "Create a page", inputSchema: { title: z.string() } }, async ({ title }) => ({
        content: [{ type: "text", text: `created ${title}` }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
after(() => srv.close());

function setup(openUrl?: (u: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-oauth-"));
  const config = { rootDir: dir, dataDir: path.join(dir, "data"), botsDir: dir, providers: {}, policy: { rules: [] }, maxToolOutputChars: 1e4 } as Config;
  return new McpManager(config, openUrl);
}

/** Plays the user's browser: follow the authorize redirect back to SlopBot's loopback listener. */
const fakeBrowser = async (url: string) => {
  const r = await fetch(url, { redirect: "manual" });
  const back = r.headers.get("location")!;
  void fetch(back).then((x) => x.text());
};

test("without signing in, an OAuth server reports needs_auth instead of opening anything", async () => {
  const mcp = setup(); // no browser available (background/CLI)
  await mcp.saveServer("notes", { url: `${base}/mcp`, bots: ["*"] });
  await assert.rejects(mcp.connect("notes"), NeedsSignInError);
  const st = mcp.status()[0];
  assert.equal(st.state, "needs_auth");
  assert.equal(st.oauth, "signed_out");
  const { tools, errors } = await mcp.toolsForBot("ledger");
  assert.equal(tools.length, 0);
  assert.match(errors.notes, /needs you to sign in/);
});

test("sign in: discovery → registration → browser → PKCE token → connected, then persists", async () => {
  log.length = 0;
  const opened: string[] = [];
  const mcp = setup(async (u) => {
    opened.push(u);
    await fakeBrowser(u);
  });
  await mcp.saveServer("notes", { url: `${base}/mcp`, bots: ["*"] });
  await mcp.signIn("notes");

  assert.equal(opened.length, 1);
  const auth = new URL(opened[0]);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("redirect_uri"), "http://127.0.0.1:33418/oauth/callback");
  assert.deepEqual(log, ["register", "authorize", "token:authorization_code"]);

  const st = mcp.status()[0];
  assert.equal(st.state, "connected");
  assert.equal(st.oauth, "signed_in");
  assert.deepEqual(st.tools.map((t) => [t.name, t.risk]), [["list_pages", "read"], ["create_page", "external"]]);

  // Tokens are stored privately and reused by a fresh manager (e.g. the CLI or a restart) with no browser.
  assert.equal(mcp.auth.secrets.kind, "file");
  const file = path.join((mcp as any).config.dataDir, "secrets", "mcp-oauth_notes.secret");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).tokens.access_token, "tok-1");
  await mcp.closeAll();
  const later = new McpManager((mcp as any).config);
  const { tools } = await later.toolsForBot("ledger");
  assert.match(await tools.find((t) => t.name === "mcp.notes.list_pages")!.run({}, {} as any), /Groceries/);
  await later.closeAll();

  // Sign out forgets the tokens.
  await mcp.signOut("notes");
  assert.equal(mcp.status()[0].oauth, "signed_out");
});

test("a server with its own Authorization header never uses OAuth", async () => {
  const mcp = setup(async () => assert.fail("should not open a browser"));
  await mcp.saveServer("notes", { url: `${base}/mcp`, headers: { Authorization: "Bearer wrong" }, bots: ["*"] });
  await assert.rejects(mcp.connect("notes"), /Unauthorized \(401\): check the token/);
  assert.equal(mcp.status()[0].oauth, undefined);
  await assert.rejects(mcp.signIn("notes"), /uses a token header/);
});
