// A fake window.slopbot so the renderer can be previewed in a plain browser (npm run desktop:preview).
// The real app always uses the preload API.
import type { AgentEvent, ApprovalRequest, McpServerDef, McpServerStatus, McpToolInfo, OllamaStatus, PullProgress, SlopbotApi } from "../api.js";

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
