// `slopbot daemon`: fires each bot's cron schedules as background-mode runs.
import { Cron } from "croner";
import { loadBots, type BotDef, type Schedule } from "../agent/bot.js";
import { Agent } from "../agent/runtime.js";
import type { Config } from "../config.js";
import type { McpManager } from "../mcp/client.js";
import type { Store } from "../store/store.js";
import { sendMail } from "../tools/email.js";

export async function runScheduled(config: Config, store: Store, bot: BotDef, s: Schedule, log = console.log, mcp?: McpManager) {
  log(`▶ ${bot.name}/${s.name}: ${s.task}`);
  const agent = new Agent(config, store, bot, "background", {}, mcp);
  try {
    const res = await agent.send(s.task);
    log(`✔ ${bot.name}/${s.name} finished in ${res.steps} steps${res.pendingApprovals.length ? `, ${res.pendingApprovals.length} awaiting approval` : ""}`);
    if (s.notify === "email") {
      const footer = res.pendingApprovals.length
        ? `\n\n---\nAwaiting your approval: ${res.pendingApprovals.join(", ")}\nRun: slopbot approvals`
        : "";
      await sendMail(config, { subject: `[SlopBot:${bot.name}] ${s.name}`, body: res.text + footer });
      log(`✉ emailed ${bot.name}/${s.name} report`);
    }
    return res;
  } catch (e: any) {
    log(`✖ ${bot.name}/${s.name}: ${e.message}`);
  }
}

export function startDaemon(config: Config, store: Store, mcp?: McpManager) {
  const bots = loadBots(config);
  const busy = new Set<string>(); // one run per bot at a time
  const jobs: Cron[] = [];

  for (const bot of bots) {
    for (const s of bot.schedules) {
      const job = new Cron(s.cron, { protect: true }, async () => {
        if (busy.has(bot.name)) {
          console.log(`⏭ skipping ${bot.name}/${s.name}: previous run still going`);
          return;
        }
        busy.add(bot.name);
        try {
          await runScheduled(config, store, bot, s, console.log, mcp);
        } finally {
          busy.delete(bot.name);
        }
      });
      jobs.push(job);
      console.log(`⏰ ${bot.name}/${s.name}  "${s.cron}"  next: ${job.nextRun()?.toLocaleString() ?? "never"}`);
    }
  }
  if (!jobs.length) console.log("No schedules defined in any bot. Add `schedules:` to a bot YAML.");
  return jobs;
}
