// A fake window.slopbot so the renderer can be previewed in a plain browser (npm run desktop:preview).
// The real app always uses the preload API.
import type { AgentEvent, ApprovalRequest, SlopbotApi } from "../api.js";

export function createMockApi(): SlopbotApi {
  const eventSubs = new Set<(e: AgentEvent) => void>();
  const askSubs = new Set<(r: ApprovalRequest) => void>();
  const answers = new Map<string, (a: string) => void>();
  const emit = (e: AgentEvent) => eventSubs.forEach((cb) => cb(e));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    info: async () => ({ dataDir: "~/SlopBot/data", rootDir: "~/SlopBot", defaultModel: "ollama/qwen3:8b", version: "preview" }),
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
