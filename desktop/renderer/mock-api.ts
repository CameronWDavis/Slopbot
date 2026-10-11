// A fake window.slopbot so the renderer can be previewed in a plain browser (npm run desktop:preview).
// The real app always uses the preload API.
import type { AgentEvent, ApprovalRequest, McpServerDef, McpServerStatus, McpToolInfo, OllamaStatus, PullProgress, SearchSettings, ShoppingSnapshot, SkillInfo, SlopbotApi, SourceInfo, VaultEntryInfo } from "../api.js";

export function createMockApi(): SlopbotApi {
  const eventSubs = new Set<(e: AgentEvent) => void>();
  const askSubs = new Set<(r: ApprovalRequest) => void>();
  const answers = new Map<string, (a: string) => void>();
  const emit = (e: AgentEvent) => eventSubs.forEach((cb) => cb(e));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pullSubs = new Set<(p: PullProgress) => void>();
  const ol: OllamaStatus = {
    running: true,
    version: "0.35.0",
    installed: true,
    baseUrl: "http://localhost:11434",
    ramBytes: 36e9,
    provider: "ollama",
    defaultModel: "ollama/qwen3:8b",
    bots: [
      { name: "coder", model: "" },
      { name: "ledger", model: "" },
      { name: "reporter", model: "" },
    ],
    models: [
      { name: "qwen3:8b", size: 5.23e9, family: "qwen3", parameterSize: "8.2B", quantization: "Q4_K_M", capabilities: ["completion", "tools", "thinking"], loaded: true },
      { name: "gemma3:4b", size: 3.34e9, family: "gemma3", parameterSize: "4.3B", quantization: "Q4_K_M", capabilities: ["completion", "vision"] },
    ],
    pulling: [],
  };
  const cancelled = new Set<string>();
  let vault: VaultEntryInfo[] = [
    { id: "v1", name: "GitHub", kind: "api_key", domains: ["github.com"], sendAs: "bearer", bots: ["*"], createdAt: "", updatedAt: "", lastUsedAt: new Date(Date.now() - 3600e3).toISOString(), hasSecret: true },
  ];
  let skills: (SkillInfo & { instructions: string })[] = [
    { name: "weekly-report", description: "Use when writing the weekly spending report: format, sections and tone.", bots: ["reporter"], yamlBots: ["ledger"], enabled: true, files: 1, instructions: "# Weekly report\n\n1. Run finance.summary for the last 7 days.\n2. Lead with total spent vs. last week." },
    { name: "pdf-forms", description: "Fill in and read PDF forms. Use when the user mentions a PDF form or fillable fields.", bots: [], yamlBots: [], enabled: true, license: "Apache-2.0", files: 4, instructions: "# PDF forms\n\nRun scripts/fill.py …" },
  ];
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const usd = (major: number) => ({ minor: Math.round(major * 100), currency: "USD" });
  const soon = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const shop: ShoppingSnapshot = {
    watches: [
      { id: "w1", name: "RTX 4070 Super", kind: "product", url: "https://www.newegg.com/p/N82E16814137840", keywords: [], exclude: [], variants: ["4070 SUPER"], sellers: ["Newegg"], target: usd(549), currency: "USD", everyMinutes: 5, enabled: true, createdAt: ago(600), lastCheckedAt: ago(2), lastSuccessAt: ago(2), nextCheckAt: soon(3), failures: 0, lastSummary: "$589.99, in stock, sold by Newegg ($589.99 is above your $549.00)", lastPrice: usd(589.99), lastInStock: true },
      { id: "w2", name: "r/buildapcsales", kind: "feed", url: "https://www.reddit.com/r/buildapcsales/new/.rss", keywords: ["ssd", "2tb"], exclude: ["refurb"], variants: [], sellers: [], target: usd(110), currency: "USD", everyMinutes: 3, enabled: true, createdAt: ago(900), lastCheckedAt: ago(1), lastSuccessAt: ago(1), nextCheckAt: soon(2), failures: 0, lastSummary: "4 new posts, 1 matched (store check: $129.99 is above your $110.00)" },
      { id: "w3", name: "@SomeDealsAccount", kind: "x_account", xQuery: "@SomeDealsAccount", keywords: ["4090"], exclude: [], variants: [], sellers: [], currency: "USD", everyMinutes: 15, enabled: true, createdAt: ago(900), lastCheckedAt: ago(40), lastSuccessAt: ago(400), nextCheckAt: soon(80), failures: 3, lastError: "No X API token saved", lastHint: "Add your X bearer token in Deal sources, or watch an RSS feed instead." },
    ],
    deals: [
      { id: "d1", watchId: "w2", watchName: "r/buildapcsales", sources: ["r/buildapcsales"], listing: { url: "https://www.amazon.com/dp/B0B7CMZ3QH", title: "WD_BLACK 2TB SN850X NVMe Internal Gaming SSD", price: usd(99.99), seller: "Amazon.com", inStock: true, checkedAt: ago(3) }, quantity: 1, cap: usd(114.99), approval: { nonce: "abc", expiresAt: soon(27) }, status: "pending", foundAt: ago(3), updatedAt: ago(3) },
      { id: "d2", watchId: "w1", watchName: "RTX 4070 Super", sources: ["product page"], listing: { url: "https://www.newegg.com/p/N82E16814137840", title: "MSI Ventus 2X RTX 4070 SUPER 12G", price: usd(539.99), seller: "Newegg", inStock: true, checkedAt: ago(30) }, quantity: 1, cap: usd(620.99), status: "uncertain", note: "An order may have been placed, but no order number was shown. Check your newegg.com account before doing anything else. SlopBot won't retry this.", foundAt: ago(40), updatedAt: ago(30), execution: { total: usd(583.19), submittedAt: ago(31) } },
      { id: "d0", watchId: "w1", watchName: "RTX 4070 Super", sources: ["product page"], listing: { url: "https://www.newegg.com/p/N82E16814137841", title: "MSI Ventus 2X RTX 4070", price: usd(499.99), seller: "Newegg", checkedAt: ago(3000) }, quantity: 1, cap: usd(574.99), status: "confirmed", foundAt: ago(3000), updatedAt: ago(2990), execution: { total: usd(541.24), orderId: "284019331" } },
    ],
    settings: {
      extraAllowancePct: 15,
      approvalMinutes: 30,
      renderService: "none",
      xMonthlyLimit: 100,
      xUsage: { month: new Date().toISOString().slice(0, 7), posts: 20, requests: 4 },
      savedFeeds: [
        { label: "r/buildapcsales", url: "https://www.reddit.com/r/buildapcsales/new/.rss" },
        { label: "r/hardwareswap", url: "https://www.reddit.com/r/hardwareswap/new/.rss" },
        { label: "Slickdeals frontpage", url: "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1" },
      ],
    },
    model: { model: "ollama/qwen3:8b", local: true },
    autoBuy: false,
    buying: false,
  };
  const sources: SourceInfo[] = [
    { id: "x", label: "X (Twitter) API", keyLabel: "Bearer token", getKey: "https://developer.x.com/en/portal/dashboard", note: "Reads posts from accounts or searches you choose. Your X developer plan must include reading posts.", configured: false, masked: "" },
    { id: "scrapingbee", label: "ScrapingBee", keyLabel: "API key", getKey: "https://app.scrapingbee.com/", note: "Renders store pages that need a full browser.", configured: true, masked: "••••••9f2c", lastTest: { ok: true, message: "Rendered a test page", at: ago(60) } },
    { id: "scraperapi", label: "ScraperAPI", keyLabel: "API key", getKey: "https://dashboard.scraperapi.com/", note: "Renders store pages that need a full browser.", configured: false, masked: "" },
  ];
  const search: SearchSettings = { provider: "auto", searxngUrl: "", keys: { ollama: false, brave: false, tavily: false }, active: "basic", problem: "" };
  const servers = new Map<string, McpServerStatus>([
    [
      "knowledge-graph",
      { name: "knowledge-graph", def: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], bots: ["*"], enabled: true }, state: "idle", tools: [] },
    ],
  ]);
  const fakeTools = (name: string): McpToolInfo[] =>
    [
      ["read_graph", "read"],
      ["search_nodes", "read"],
      ["create_entities", "external"],
      ["delete_entities", "dangerous"],
    ].map(([t, risk]) => ({ name: t, slopName: `mcp.${name}.${t}`, description: `${t} (mock)`, risk: risk as McpToolInfo["risk"] }));
  const connectMock = async (name: string, def: McpServerDef) => {
    await sleep(900);
    if (!def.url && !/^(npx|uvx|node|docker)$/.test(def.command ?? "")) throw new Error(`spawn ${def.command} ENOENT`);
    if (def.url && /Bearer\s*$/.test(def.headers?.Authorization ?? "")) throw new Error("HTTP 401: Bad credentials");
    if (def.url && !def.headers?.Authorization) throw new Error(`"${name}" needs you to sign in. Open Connectors and click Sign in.`);
    return fakeTools(name);
  };

  return {
    info: async () => ({ dataDir: "~/SlopBot/data", rootDir: "~/SlopBot", homeDir: "/Users/you", defaultModel: "ollama/qwen3:8b", version: "preview", secrets: "keychain" }),
    listBots: async () => [
      { name: "ledger", description: "Personal finance bot. Imports bank CSVs, categorizes spending, answers questions, sends weekly reports.", model: "ollama/qwen3:8b", tools: ["finance.summary", "email.send"], schedules: [{ name: "weekly-report", cron: "0 8 * * MON", task: "Weekly report" }] },
      { name: "coder", description: "Coding bot. Reads, edits, and tests code in folders you allow.", model: "ollama/qwen3:8b", tools: ["fs.read", "shell.run"], schedules: [] },
      { name: "reporter", description: "Research & digest bot. Reads the pages you care about and emails you a summary.", model: "ollama/qwen3:8b", tools: ["http.fetch"], schedules: [] },
    ],
    listModels: async () => ["ollama/qwen3:8b", "anthropic/claude-sonnet-5-5", "openai/gpt-5"],
    async send(bot, text) {
      emit({ type: "run.start", bot });
      await sleep(900);
      emit({ type: "tool.call", bot, id: "c1", name: "finance.summary", args: { from: "2026-09-01", to: "2026-09-30" }, decision: "allow", reason: "default" });
      await sleep(1200);
      emit({ type: "tool.result", bot, id: "c1", name: "finance.summary", ok: true, result: "Income: $6400.00   Spending: -$2186.66\n\nBy category:\n  Housing  -$1650.00 (1 txn)" });
      if (/email|send/i.test(text)) {
        const id = "ask_mock";
        emit({ type: "tool.call", bot, id: "c2", name: "email.send", args: { subject: "September report", body: "…" }, decision: "ask", reason: "bot rule \"email.send: ask\"" });
        askSubs.forEach((cb) => cb({ id, bot, tool: "email.send", args: { subject: "September report", body: "Income $6,400 · Spending $2,186.66" }, reason: 'bot rule "email.send: ask"' }));
        const a = await new Promise<string>((r) => answers.set(id, r));
        emit({ type: "tool.result", bot, id: "c2", name: "email.send", ok: a !== "no", result: a === "no" ? "BLOCKED: user declined" : "Sent to you@example.com" });
      }
      await sleep(900);
      if (/fail|error/i.test(text)) {
        emit({ type: "run.error", bot, error: "[ollama] can't reach http://localhost:11434/v1 (ECONNREFUSED). Is your local model server running?" });
        return;
      }
      emit({ type: "run.end", bot, text: "**September at a glance**\n\n- Income: $6,400.00\n- Spending: $2,186.66\n- Biggest: rent, `$1,650.00`\n\nDining ($57.85) is under your $150 budget.", steps: 3, tokens: 4211, pending: [] });
    },
    reset: async () => {},
    answerApproval: async (id, answer) => {
      answers.get(id)?.(answer);
      answers.delete(id);
    },
    listApprovals: async () => [
      { id: "ap_1a2b3c4d", bot: "ledger", tool: "email.send", args: { subject: "[SlopBot:ledger] weekly-report", body: "Your weekly report…" }, reason: "default for external tools in background mode", createdAt: new Date().toISOString() },
    ],
    resolveApproval: async (_id, approve) => (approve ? "Sent." : "Denied."),
    activity: async () => [
      { ts: new Date().toISOString(), bot: "ledger", type: "run.end", summary: "finished in 3 steps" },
      { ts: new Date().toISOString(), bot: "ledger", type: "tool", summary: "finance.summary → allow" },
      { ts: new Date().toISOString(), bot: "ledger", type: "run.start", summary: "interactive run on ollama/qwen3:8b: where did my money go" },
    ],
    memory: async () => [{ id: "m_83aee128", text: "Monthly dining budget is $150" }],
    openDataDir: async () => {},
    mcpList: async () => [...servers.values()].map((s) => ({ ...s, state: s.def.enabled === false ? "disabled" : s.state })),
    async mcpConnect(name) {
      const s = servers.get(name)!;
      try {
        s.tools = await connectMock(name, s.def);
        s.state = "connected";
        s.error = undefined;
      } catch (e: any) {
        s.state = "error";
        s.error = e.message;
        s.tools = [];
      }
      return { ...s };
    },
    mcpTest: (name, def) => connectMock(name, def),
    async mcpSave(name, def, previousName) {
      if (previousName && previousName !== name) servers.delete(previousName);
      const prev = servers.get(name);
      const changed = !prev || JSON.stringify({ ...prev.def, bots: 0, enabled: 0 }) !== JSON.stringify({ ...def, bots: 0, enabled: 0 });
      servers.set(name, { name, def, state: changed ? "idle" : prev!.state, tools: changed ? [] : prev!.tools, error: changed ? undefined : prev!.error });
    },
    mcpRemove: async (name) => void servers.delete(name),
    async mcpSignIn(name) {
      await sleep(1500);
      const s = servers.get(name)!;
      Object.assign(s, { state: "connected", oauth: "signed_in", error: undefined, tools: fakeTools(name) });
      return { ...s };
    },
    async mcpSignOut(name) {
      const s = servers.get(name)!;
      Object.assign(s, { state: "needs_auth", oauth: "signed_out", tools: [] });
    },
    async mcpImport(json, bots) {
      const data = JSON.parse(json);
      const map = data.mcpServers ?? data;
      for (const [n, d] of Object.entries<McpServerDef>(map)) servers.set(n, { name: n, def: { ...d, bots: d.bots ?? bots, enabled: true }, state: "idle", tools: [] });
      return Object.keys(map);
    },
    shoppingState: async () => structuredClone(shop),
    async shoppingSaveWatch(w) {
      if (!w.kind.startsWith("x_") && !/^https?:\/\//.test(w.url ?? "")) throw new Error("Enter the full web address, starting with https://");
      const prev = shop.watches.find((x) => x.id === w.id);
      const next = { keywords: [], exclude: [], variants: [], sellers: [], currency: "USD", everyMinutes: 5, enabled: true, createdAt: new Date().toISOString(), failures: 0, ...prev, ...w, name: w.name || w.url || w.xQuery || "watch", target: w.targetPrice ? usd(Number(w.targetPrice)) : undefined, maxTotal: w.maxTotal ? usd(Number(w.maxTotal)) : undefined, id: w.id ?? String(Math.random()) } as any;
      shop.watches = prev ? shop.watches.map((x) => (x.id === w.id ? next : x)) : [...shop.watches, next];
      return next;
    },
    shoppingRemoveWatch: async (id) => void (shop.watches = shop.watches.filter((w) => w.id !== id)),
    shoppingSetEnabled: async (id, on) => void (shop.watches = shop.watches.map((w) => (w.id === id ? { ...w, enabled: on } : w))),
    shoppingCheck: async () => (await sleep(800), { ok: true, summary: "$589.99, in stock" }),
    shoppingBuy: async (id) => void (shop.deals = shop.deals.map((d) => (d.id === id ? { ...d, status: "reviewing" } : d))),
    shoppingSkip: async (id) => void (shop.deals = shop.deals.map((d) => (d.id === id ? { ...d, status: "skipped" } : d))),
    shoppingRecheck: async () => {},
    shoppingResume: async () => {},
    shoppingCancel: async (id) => void (shop.deals = shop.deals.map((d) => (d.id === id ? { ...d, status: "failed" } : d))),
    shoppingResolve: async (id, ordered) => void (shop.deals = shop.deals.map((d) => (d.id === id ? { ...d, status: ordered ? "confirmed" : "failed" } : d))),
    shoppingSaveSettings: async (p) => (shop.settings = { ...shop.settings, ...p }),
    shoppingOpenBrowser: async () => {},
    shoppingClearHistory: async () => void (shop.deals = shop.deals.filter((d) => ["pending", "uncertain"].includes(d.status))),
    shoppingClearSignIns: async () => {},
    sourcesList: async () => structuredClone(sources),
    sourcesSave: async (id, key) => {
      const s = sources.find((x) => x.id === id)!;
      Object.assign(s, { configured: true, masked: `••••••${key.slice(-4)}`, lastTest: { ok: false, message: "X didn't accept the bearer token.", at: new Date().toISOString() } });
      return s.lastTest!;
    },
    sourcesRemove: async (id) => void Object.assign(sources.find((x) => x.id === id)!, { configured: false, masked: "", lastTest: undefined }),
    sourcesTest: async () => ({ ok: true, message: "ok" }),
    onShoppingChanged: () => () => {},
    onShowShopping: () => () => {},
    skillsList: async () => skills.map(({ instructions, ...s }) => s),
    skillsGet: async (name) => {
      const s = skills.find((x) => x.name === name)!;
      return { name: s.name, description: s.description, instructions: s.instructions, files: s.files > 1 ? ["SKILL.md", "scripts/fill.py", "reference.md", "forms.md"] : ["SKILL.md"] };
    },
    async skillsSave(d) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.name)) throw new Error(`Skill name "${d.name}" must be lowercase letters, digits and hyphens`);
      if (!d.description) throw new Error(`Skill "${d.name}" needs a description (it's how the bot knows when to use it)`);
      const prev = skills.find((x) => x.name === (d.previousName ?? d.name));
      const next = { ...(prev ?? { enabled: true, files: 1, yamlBots: [] }), name: d.name, description: d.description, instructions: d.instructions, bots: d.bots };
      skills = prev ? skills.map((x) => (x === prev ? next : x)) : [...skills, next];
      return d.name;
    },
    skillsImport: async () => null,
    skillsAssign: async (name, bots, enabled) => void (skills = skills.map((s) => (s.name === name ? { ...s, bots, enabled } : s))),
    skillsRemove: async (name) => void (skills = skills.filter((s) => s.name !== name)),
    skillsReveal: async () => {},
    vaultList: async () => structuredClone(vault),
    async vaultSave(input) {
      if (!input.domains?.length) throw new Error("Add at least one website (domain) this credential is for");
      const { secret, ...rest } = input as any;
      const e = { ...vault.find((x) => x.id === input.id), ...rest, id: input.id ?? String(Math.random()), hasSecret: true, bots: input.bots ?? ["*"], createdAt: "", updatedAt: "" } as VaultEntryInfo;
      vault = input.id ? vault.map((x) => (x.id === input.id ? e : x)) : [...vault, e];
      return e;
    },
    vaultRemove: async (id) => void (vault = vault.filter((x) => x.id !== id)),
    searchGet: async () => structuredClone(search),
    searchSave: async (s) => {
      search.provider = s.provider;
      if (s.key?.value) search.keys[s.key.provider] = true;
      search.active = s.provider === "auto" ? (Object.entries(search.keys).find(([, v]) => v)?.[0] ?? "basic") : s.provider;
    },
    searchForgetKey: async (p) => void (search.keys[p] = false),
    searchTest: async () => ({ provider: search.active, results: [{ title: "Model Context Protocol", url: "https://en.wikipedia.org/wiki/Model_Context_Protocol", snippet: "" }] }),
    telegramStatus: async () => ({ configured: false, enabled: false, running: false, linked: false, rejected: 0 }),
    telegramSetToken: async () => "SlopTestBot",
    telegramPair: async () => ({ code: "483912", expiresAt: Date.now() + 600000 }),
    telegramUnlink: async () => {},
    telegramSetDefaultBot: async () => {},
    telegramSetEnabled: async () => {},
    telegramRemoveToken: async () => {},
    onTelegramStatus: () => () => {},
    ollamaStatus: async () => structuredClone(ol),
    ollamaStart: async () => {
      await sleep(800);
      ol.running = true;
      return "0.35.0";
    },
    ollamaStop: async () => {
      await sleep(500);
      ol.running = false;
    },
    ollamaDownload: async () => {},
    async ollamaPull(model) {
      const total = 2.5e9;
      for (let done = 0; done <= total; done += total / 25) {
        if (cancelled.delete(model)) {
          pullSubs.forEach((cb) => cb({ model, status: "cancelled", completed: 0, total: 0, error: "Cancelled" }));
          return;
        }
        pullSubs.forEach((cb) => cb({ model, status: "pulling", completed: done, total }));
        await sleep(120);
      }
      ol.models.push({ name: model, size: total, parameterSize: "4B", quantization: "Q4_K_M", capabilities: ["completion", "tools"] });
      pullSubs.forEach((cb) => cb({ model, status: "success", completed: total, total, done: true }));
    },
    ollamaCancel: async (model) => void cancelled.add(model),
    ollamaDelete: async (model) => void (ol.models = ol.models.filter((m) => m.name !== model)),
    ollamaUnload: async (model) => void ol.models.forEach((m) => m.name === model && (m.loaded = false)),
    ollamaSetDefault: async (model) => void (ol.defaultModel = `ollama/${model}`),
    ollamaUseForBot: async (bot, model) => void ol.bots.forEach((b) => b.name === bot && (b.model = model ? `ollama/${model}` : "")),
    onPullProgress(cb) {
      pullSubs.add(cb);
      return () => pullSubs.delete(cb);
    },
    onEvent(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onApprovalRequest(cb) {
      askSubs.add(cb);
      return () => askSubs.delete(cb);
    },
  };
}
