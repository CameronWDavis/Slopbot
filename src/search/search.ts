// Web search through official APIs only (no scraping, no bot-detection workarounds).
//   ollama   – Ollama's web search API (free key from ollama.com)
//   brave    – Brave Search API
//   tavily   – Tavily (built for AI agents)
//   searxng  – your own SearXNG instance (open source, no key)
//   basic    – no key: DuckDuckGo Instant Answers + Wikipedia (encyclopedic results only)
// API keys live in the secret store as search.<provider>.
import type { SecretStore } from "../secrets.js";

export type SearchProvider = "auto" | "ollama" | "brave" | "tavily" | "searxng" | "basic";
export const KEYED: SearchProvider[] = ["ollama", "brave", "tavily"];

export interface SearchConfig {
  provider?: SearchProvider;
  searxngUrl?: string;
  /** Override API base URLs (tests, proxies). */
  endpoints?: Partial<Record<Exclude<SearchProvider, "auto">, string>>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const searchKeyName = (p: SearchProvider) => `search.${p}`;

const UA = "SlopBot/0.1 (+https://github.com/CameronWDavis/SlopBot)";
const stripHtml = (s: string) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Which provider a search will use, and its key. "auto" prefers keyed providers, then SearXNG, then basic. */
export function resolveSearch(cfg: SearchConfig | undefined, secrets: SecretStore): { provider: Exclude<SearchProvider, "auto">; key?: string } {
  const want = cfg?.provider ?? "auto";
  if (want !== "auto") {
    const key = KEYED.includes(want) ? secrets.get(searchKeyName(want)) : undefined;
    if (KEYED.includes(want) && !key) throw new Error(`Web search is set to ${want} but no API key is saved. Add it in Connectors → Web search.`);
    if (want === "searxng" && !cfg?.searxngUrl) throw new Error("Web search is set to SearXNG but no URL is configured.");
    return { provider: want, key };
  }
  for (const p of KEYED) {
    const key = secrets.get(searchKeyName(p));
    if (key) return { provider: p as Exclude<SearchProvider, "auto">, key };
  }
  if (cfg?.searxngUrl) return { provider: "searxng" };
  return { provider: "basic" };
}

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new Error(`Search API rejected the key (HTTP ${res.status}). Check it in Connectors → Web search.`);
  if (res.status === 429) throw new Error("Search API rate limit reached. Try again later.");
  if (!res.ok) throw new Error(`Search API error: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function webSearch(
  query: string,
  opts: { config?: SearchConfig; secrets: SecretStore; max?: number },
): Promise<{ provider: string; results: SearchResult[] }> {
  const q = query.trim();
  if (!q) throw new Error("Empty search query");
  const max = Math.min(Math.max(opts.max ?? 8, 1), 20);
  const { provider, key } = resolveSearch(opts.config, opts.secrets);
  const ep = opts.config?.endpoints ?? {};
  let results: SearchResult[] = [];

  if (provider === "ollama") {
    const d = await getJson(ep.ollama ?? "https://ollama.com/api/web_search", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q, max_results: Math.min(max, 10) }),
    });
    results = (d.results ?? []).map((r: any) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.content ?? "").slice(0, 400) }));
  } else if (provider === "brave") {
    const u = new URL(ep.brave ?? "https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", q);
    u.searchParams.set("count", String(max));
    const d = await getJson(u.toString(), { headers: { "x-subscription-token": key! } });
    results = (d.web?.results ?? []).map((r: any) => ({ title: stripHtml(r.title), url: r.url, snippet: stripHtml(r.description) }));
  } else if (provider === "tavily") {
    const d = await getJson(ep.tavily ?? "https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q, max_results: max }),
    });
    results = (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: String(r.content ?? "").slice(0, 400) }));
  } else if (provider === "searxng") {
    const u = new URL("/search", ep.searxng ?? opts.config!.searxngUrl);
    u.searchParams.set("q", q);
    u.searchParams.set("format", "json");
    const d = await getJson(u.toString()).catch((e) => {
      throw new Error(`${e.message} (is JSON output enabled in your SearXNG settings.yml under search.formats?)`);
    });
    results = (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: stripHtml(r.content) }));
  } else {
    // Basic: official free APIs only; encyclopedic coverage, not a full web index.
    const ddgUrl = new URL(ep.basic ? `${ep.basic}/ddg` : "https://api.duckduckgo.com/");
    for (const [k, v] of Object.entries({ q, format: "json", no_html: "1", skip_disambig: "1" })) ddgUrl.searchParams.set(k, v);
    const wikiUrl = new URL(ep.basic ? `${ep.basic}/wiki` : "https://en.wikipedia.org/w/api.php");
    for (const [k, v] of Object.entries({ action: "query", list: "search", srsearch: q, format: "json", srlimit: String(Math.min(max, 8)) })) wikiUrl.searchParams.set(k, v);
    const [ddg, wiki] = await Promise.all([getJson(ddgUrl.toString()).catch(() => ({})), getJson(wikiUrl.toString()).catch(() => ({}))]);
    if (ddg.AbstractURL && ddg.AbstractText) results.push({ title: ddg.Heading || q, url: ddg.AbstractURL, snippet: ddg.AbstractText.slice(0, 400) });
    const topics: any[] = (ddg.RelatedTopics ?? []).flatMap((t: any) => (t.Topics ? t.Topics : [t]));
    for (const t of topics.slice(0, 4)) if (t.FirstURL && t.Text) results.push({ title: t.Text.split(" - ")[0].slice(0, 120), url: t.FirstURL, snippet: t.Text.slice(0, 300) });
    for (const r of wiki.query?.search ?? []) {
      results.push({ title: r.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`, snippet: stripHtml(r.snippet) });
    }
    const seen = new Set<string>();
    results = results.filter((r) => !seen.has(r.url) && seen.add(r.url));
  }
  return { provider, results: results.filter((r) => r.url).slice(0, max) };
}

export function formatResults(provider: string, query: string, results: SearchResult[]): string {
  if (!results.length) return `No results for "${query}" (${provider}).`;
  const note = provider === "basic" ? "\n(Basic search covers encyclopedia-style sources only. For full web results the user can add a free search key in Connectors → Web search.)" : "";
  return `<untrusted_content source="web.search:${provider}">\n${results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n")}\n</untrusted_content>${note}\nUse http.fetch to read a result in full.`;
}
