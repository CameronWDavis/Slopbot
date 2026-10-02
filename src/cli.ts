#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadBot, loadBots } from "./agent/bot.js";
import { Agent, executeApproval, type AgentHooks } from "./agent/runtime.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { resolveModel } from "./providers/index.js";
import { runScheduled, startDaemon } from "./scheduler/scheduler.js";
import { Store } from "./store/store.js";
import { toolsFor } from "./tools/registry.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const HELP = `${c.bold("slopbot")}: open-source personal AI agents

  slopbot init                        create slopbot.config.yaml
  slopbot bots                        list bots
  slopbot chat <bot>                  interactive chat
  slopbot run <bot> "<task>" [--bg]   one-shot task (--bg: background mode, approvals queued)
  slopbot trigger <bot> [schedule]    run a bot's schedule now
  slopbot daemon                      run all schedules
  slopbot approvals                   list pending approvals
  slopbot approve <id> | deny <id>    resolve a pending approval
  slopbot activity [bot] [-n 50]      show the audit log
  slopbot memory <bot>                show what a bot remembers
  slopbot ping [provider/model]       check that a model responds
  slopbot mcp                         run as an MCP server (stdio) for Claude Code etc.
`;

const brief = (args: Record<string, unknown>) => {
  const s = JSON.stringify(args);
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
};

function makeHooks(rl?: readline.Interface): AgentHooks {
  return {
    onToolCall: (call, d) =>
      console.log(c.dim(`  → ${call.name} ${brief(call.args)}`) + (d.action === "deny" ? c.red(`  ✖ ${d.reason}`) : "")),
    onToolResult: (_call, result, ok) => {
      const first = result.split("\n").slice(0, 3).join(" ⏎ ");
      console.log(c.dim(`    ${ok ? "✓" : c.red("✗")} ${first.slice(0, 200)}`));
    },
    approve: rl
      ? async (call, d) => {
          console.log(c.yellow(`\n  ⚠ ${c.bold(call.name)} needs approval (${d.reason})`));
          console.log(c.yellow(JSON.stringify(call.args, null, 2).split("\n").map((l) => "    " + l).join("\n")));
          const a = (await rl.question(c.yellow("  Allow? [y]es / [n]o / [a]lways this session: "))).trim().toLowerCase();
          return a.startsWith("a") ? "always" : a.startsWith("y") ? "yes" : "no";
        }
      : undefined,
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const store = new Store(config.dataDir);

  switch (cmd) {
    case "init": {
      const target = path.join(config.rootDir, CONFIG_FILE);
      if (fs.existsSync(target)) return console.log(`${CONFIG_FILE} already exists.`);
      fs.copyFileSync(path.join(config.rootDir, "slopbot.config.example.yaml"), target);
      console.log(`Created ${CONFIG_FILE}. Edit providers / defaultModel / smtp, then: slopbot chat ledger`);
      return;
    }

    case "bots": {
      for (const b of loadBots(config)) {
        console.log(`${c.bold(c.cyan(b.name))}  ${c.dim(b.model ?? `${config.defaultModel} (default)`)}`);
        if (b.description) console.log(`  ${b.description}`);
        console.log(c.dim(`  tools: ${toolsFor(b.tools).map((t) => t.name).join(", ")}`));
        for (const s of b.schedules) console.log(c.dim(`  ⏰ ${s.name} "${s.cron}": ${s.task.replace(/\s+/g, " ").trim()}`));
      }
      return;
    }

    case "chat": {
      const bot = loadBot(config, need(rest[0], "bot name"));
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const agent = new Agent(config, store, bot, "interactive", makeHooks(rl));
      console.log(c.dim(`Chatting with ${bot.name} (${bot.model ?? config.defaultModel}). /exit to quit.\n`));
      while (true) {
        let line: string;
        try {
          line = (await rl.question(c.bold("you › "))).trim();
        } catch {
          break; // stdin closed
        }
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;
        try {
          const res = await agent.send(line);
          console.log(`\n${c.cyan(bot.name + " ›")} ${res.text}\n`);
        } catch (e: any) {
          console.error(c.red(`error: ${e.message}`));
        }
      }
      rl.close();
      return;
    }

    case "run": {
      const bg = rest.includes("--bg");
      const [name, ...taskParts] = rest.filter((a) => a !== "--bg");
      const bot = loadBot(config, need(name, "bot name"));
      const task = need(taskParts.join(" "), "task");
      const rl = bg ? undefined : readline.createInterface({ input: stdin, output: stdout });
      const agent = new Agent(config, store, bot, bg ? "background" : "interactive", makeHooks(rl));
      const res = await agent.send(task);
      rl?.close();
      console.log(`\n${res.text}\n`);
      console.log(c.dim(`${res.steps} steps · ${res.usage.inputTokens} in / ${res.usage.outputTokens} out tokens`));
      if (res.pendingApprovals.length) console.log(c.yellow(`Pending approvals: ${res.pendingApprovals.join(", ")}. Run: slopbot approvals`));
      return;
    }

    case "trigger": {
      const bot = loadBot(config, need(rest[0], "bot name"));
      const s = rest[1] ? bot.schedules.find((x) => x.name === rest[1]) : bot.schedules[0];
      if (!s) throw new Error(`Bot ${bot.name} has no schedule ${rest[1] ?? ""}`);
      const res = await runScheduled(config, store, bot, s);
      if (res) console.log(`\n${res.text}`);
      return;
    }

    case "daemon": {
      console.log(c.bold("SlopBot daemon started. Ctrl-C to stop."));
      startDaemon(config, store);
      await new Promise(() => {});
      return;
    }

    case "approvals": {
      const pending = store.listApprovals().filter((a) => a.status === "pending");
      if (!pending.length) return console.log("No pending approvals.");
      for (const a of pending) {
        console.log(`${c.bold(a.id)}  ${c.cyan(a.bot)}  ${c.yellow(a.call.name)}  ${c.dim(a.createdAt)}`);
        console.log(JSON.stringify(a.call.args, null, 2).split("\n").map((l) => "    " + l).join("\n"));
      }
      console.log(c.dim("\nslopbot approve <id>  |  slopbot deny <id>"));
      return;
    }

    case "approve": {
      const id = need(rest[0], "approval id");
      const a = store.listApprovals().find((x) => x.id === id);
      if (!a) throw new Error(`No approval ${id}`);
      console.log(await executeApproval(config, store, loadBot(config, a.bot), id));
      return;
    }

    case "deny": {
      const id = need(rest[0], "approval id");
      const a = store.updateApproval(id, { status: "denied", resolvedAt: new Date().toISOString() });
      store.audit({ bot: a.bot, session: a.session, type: "approval", tool: a.call.name, denied: id });
      console.log(`Denied ${id}.`);
      return;
    }

    case "activity": {
      const nIdx = rest.indexOf("-n");
      const limit = nIdx >= 0 ? Number(rest[nIdx + 1]) : 50;
      const bot = rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "-n");
      for (const e of store.readAudit({ bot, limit })) {
        const { ts, bot: b, session, type, ...restEv } = e;
        console.log(`${c.dim(String(ts).slice(0, 19))} ${c.cyan(b)} ${c.bold(type)} ${c.dim(brief(restEv))}`);
      }
      return;
    }

    case "memory": {
      const bot = loadBot(config, need(rest[0], "bot name"));
      const notes = store.readMemory(bot.name);
      if (!notes.length) return console.log(`${bot.name} doesn't remember anything yet.`);
      for (const n of notes) console.log(`${c.dim(n.id)} ${n.text}`);
      return;
    }

    case "ping": {
      const { provider, model } = resolveModel(config, rest[0]);
      const t0 = Date.now();
      const turn = await provider.chat({ model, system: "Reply with exactly: pong", messages: [{ role: "user", content: "ping" }], tools: [] });
      console.log(`${provider.name}/${model} → "${turn.text}" in ${Date.now() - t0}ms`);
      return;
    }

    case "mcp": {
      // stdout is the MCP channel: nothing else may print there.
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createMcpServer } = await import("./mcp/server.js");
      await createMcpServer(config, store).connect(new StdioServerTransport());
      console.error(`slopbot MCP server ready (home: ${config.rootDir})`);
      return;
    }

    default:
      console.log(HELP);
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) {
    console.error(c.red(`Missing ${what}.`) + "\n\n" + HELP);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  console.error(c.red(`error: ${e?.message ?? e}`));
  process.exit(1);
});
