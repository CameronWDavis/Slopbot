// Optional deal sources that need your own account: the X (Twitter) API and page-rendering
// services. Keys are entered by you, stored in the OS credential store (Keychain / DPAPI /
// libsecret), shown masked, and never written to config files, logs or builds.
import dns from "node:dns/promises";
import net from "node:net";
import type { SecretStore } from "../secrets.js";
import { guardedFetcher, isPrivateIp } from "../tools/netguard.js";

export type SourceId = "x" | "scrapingbee" | "scraperapi";

export const SOURCE_KEYS: Record<SourceId, string> = {
  x: "deals.x.bearer",
  scrapingbee: "deals.scrapingbee.key",
  scraperapi: "deals.scraperapi.key",
};

export const SOURCE_INFO: Record<SourceId, { label: string; keyLabel: string; getKey: string; note: string }> = {
  x: {
    label: "X (Twitter) API",
    keyLabel: "Bearer token",
    getKey: "https://developer.x.com/en/portal/dashboard",
    note: "Reads posts from accounts or searches you choose. Your X developer plan must include reading posts, and each post read counts toward its monthly limit.",
  },
  scrapingbee: {
    label: "ScrapingBee",
    keyLabel: "API key",
    getKey: "https://app.scrapingbee.com/account/manage/api_key",
    note: "Renders store pages that need a full browser when the shopping browser can't read them. The service sees the product addresses you watch.",
  },
  scraperapi: {
    label: "ScraperAPI",
    keyLabel: "API key",
    getKey: "https://dashboard.scraperapi.com/",
    note: "Renders store pages that need a full browser when the shopping browser can't read them. The service sees the product addresses you watch.",
  },
};

/** "••••••ab12": enough to recognize a key, never enough to use it. */
export const maskSecret = (v?: string) => (v ? `${"•".repeat(6)}${v.slice(-4)}` : "");

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
  }
}

export class SourceError extends Error {
  constructor(
    message: string,
    /** What the user can do about it. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

async function getJson(url: string, headers: Record<string, string>, allowPrivate: string[] = []) {
  const target = new URL(url);
  const n = guardedFetcher(target, allowPrivate);
  try {
    const res = await n.fetch(target, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { res, body };
  } finally {
    n.close();
  }
}

// ── X API ─────────────────────────────────────────────
export interface XPost {
  id: string;
  text: string;
  createdAt?: string;
  /** Expanded links in the post (t.co resolved by X). */
  urls: string[];
  url: string;
}

export class XClient {
  constructor(
    private token: string,
    private base = process.env.SLOPBOT_X_API ?? "https://api.x.com",
    private allowPrivate: string[] = [],
  ) {}

  private async call(path: string) {
    const { res, body } = await getJson(`${this.base}${path}`, { authorization: `Bearer ${this.token}`, "user-agent": "SlopBot/0.1" }, this.allowPrivate);
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000 || Date.now() + 15 * 60_000;
      throw new RateLimitError(`X rate limit reached; trying again at ${new Date(reset).toLocaleTimeString()}`, reset);
    }
    if (res.status === 401) throw new SourceError("X didn't accept the bearer token.", "Copy the Bearer Token again from your X developer portal (Keys and tokens) and save it in Deal sources.");
    if (res.status === 403)
      throw new SourceError("Your X developer plan doesn't allow reading posts.", "Reading posts needs an X API plan with read access. Check your plan in the X developer portal, or watch the same deals through an RSS feed.");
    if (!res.ok) throw new SourceError(`X API answered ${res.status}: ${typeof body === "object" ? (body?.title ?? body?.detail ?? "") : String(body).slice(0, 120)}`);
    return { body, remaining: Number(res.headers.get("x-rate-limit-remaining") ?? NaN) };
  }

  /** Cheap call to check the token works. */
  async test(): Promise<string> {
    const { body, remaining } = await this.call("/2/users/by/username/X");
    return `Connected to X${body?.data?.id ? "" : " (token accepted)"}${Number.isFinite(remaining) ? ` · ${remaining} requests left in this 15-minute window` : ""}`;
  }

  /**
   * Recent posts matching `query` (an account watch is `from:handle`), newest first, only those
   * newer than `sinceId`. `max` posts are read at most (each counts toward your plan's monthly limit).
   */
  async search(query: string, sinceId?: string, max = 10): Promise<XPost[]> {
    const p = new URLSearchParams({ query, max_results: String(Math.min(100, Math.max(10, max))), "tweet.fields": "created_at,entities" });
    if (sinceId) p.set("since_id", sinceId);
    const { body } = await this.call(`/2/tweets/search/recent?${p}`);
    return ((body?.data ?? []) as any[]).map((t) => ({
      id: String(t.id),
      text: String(t.text ?? ""),
      createdAt: t.created_at,
      urls: ((t.entities?.urls ?? []) as any[]).map((u) => String(u.unwound_url ?? u.expanded_url ?? u.url ?? "")).filter((u) => /^https?:\/\//.test(u) && !/^https?:\/\/(x|twitter)\.com\//i.test(u)),
      url: `https://x.com/i/web/status/${t.id}`,
    }));
  }
}

/** Turn what the user typed into an X search: "@deals" or "deals" → from:deals; else a search. */
export function xQueryFor(kind: "x_account" | "x_search", value: string): string {
  const v = value.trim();
  if (kind === "x_account") {
    const handle = v.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    if (!/^\w{1,15}$/.test(handle)) throw new SourceError(`"${value}" isn't an X handle`, "Use the account's @handle, e.g. @BAPCSalesBot.");
    return `from:${handle} -is:retweet`;
  }
  if (!v || v.length > 512) throw new SourceError("Enter what to search for on X", "e.g. rtx 4070 deal -is:retweet");
  return v;
}

// ── page-rendering services ───────────────────────────
/** Refuse to hand a private/local address to a third-party service. */
export async function assertPublicTarget(url: string, allowPrivate: string[] = []) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new SourceError("Only http(s) pages can be rendered");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (allowPrivate.includes(host)) return;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (/^(localhost|.*\.localhost)$/i.test(host) || addrs.some(isPrivateIp)) throw new SourceError(`${host} is a private or local address; it won't be sent to a rendering service.`);
}

export async function renderWithService(provider: "scrapingbee" | "scraperapi", key: string, url: string, opts: { allowPrivate?: string[]; base?: string } = {}): Promise<string> {
  await assertPublicTarget(url, opts.allowPrivate);
  const endpoint =
    provider === "scrapingbee"
      ? `${opts.base ?? process.env.SLOPBOT_SCRAPINGBEE_API ?? "https://app.scrapingbee.com"}/api/v1/?${new URLSearchParams({ api_key: key, url, render_js: "true" })}`
      : `${opts.base ?? process.env.SLOPBOT_SCRAPERAPI_API ?? "https://api.scraperapi.com"}/?${new URLSearchParams({ api_key: key, url, render: "true" })}`;
  const target = new URL(endpoint);
  const n = guardedFetcher(target, opts.allowPrivate ?? []);
  try {
    const res = await n.fetch(target, { redirect: "error", signal: AbortSignal.timeout(70_000) });
    if (res.status === 401 || res.status === 403) throw new SourceError(`${SOURCE_INFO[provider].label} rejected the API key.`, "Check the key in your account dashboard and save it again in Deal sources.");
    if (res.status === 429) throw new RateLimitError(`${SOURCE_INFO[provider].label} rate limit or credits used up`, Date.now() + 30 * 60_000);
    if (!res.ok) throw new SourceError(`${SOURCE_INFO[provider].label} answered ${res.status}`);
    return (await res.text()).slice(0, 4 * 1024 * 1024);
  } finally {
    n.close();
  }
}

// ── credentials ───────────────────────────────────────
export interface SourceStatus {
  id: SourceId;
  label: string;
  keyLabel: string;
  getKey: string;
  note: string;
  configured: boolean;
  masked: string;
  lastTest?: { ok: boolean; message: string; at: string };
}

export class SourceCredentials {
  constructor(private secrets: SecretStore) {}
  get(id: SourceId) {
    return this.secrets.get(SOURCE_KEYS[id]) || undefined;
  }
  set(id: SourceId, value: string) {
    const v = value.trim();
    if (!v) throw new SourceError("Paste the key first");
    if (/\s/.test(v) || v.length > 512) throw new SourceError("That doesn't look like a key (it has spaces or is very long)");
    this.secrets.set(SOURCE_KEYS[id], v);
  }
  remove(id: SourceId) {
    this.secrets.delete(SOURCE_KEYS[id]);
  }
}
