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
import { McpManager } from "./mcp/client.js";
import { openSecretStore } from "./secrets.js";
import { TelegramChannel } from "./channels/telegram.js";
import { acquireLock } from "./lock.js";
import { Ollama, ollamaProviderName, ollamaUrl } from "./ollama/ollama.js";
import { ensureOllamaProvider, setDefaultModel } from "./config-edit.js";
import { Store } from "./store/store.js";
import { toolsFor } from "./tools/registry.js";
import { addSkill, assign, listSkills, removeSkill, skillsDir } from "./skills/skills.js";
import { ShoppingService } from "./shopping/service.js";
import { formatMoney } from "./shopping/money.js";

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
  slopbot connectors                  list MCP servers your bots use, and test them
  slopbot secret set <name>           store an API key in the Keychain; use it as \${secret:<name>}
  slopbot secret rm <name>            delete a stored secret
  slopbot skills                      list skills (SKILL.md) and which bots use them
  slopbot skills add <path> [--bots a,b]   add a skill folder or SKILL.md (default: all bots)
  slopbot skills use <skill> <bots|*>      choose which bots use a skill (comma-separated)
  slopbot skills rm <skill>           delete a skill
  slopbot shop                        list deal watches and recent deals (manage them in the app's Shopping tab)
  slopbot shop check <url> [EUR]      test whether SlopBot can read a product page (price, stock, seller)
  slopbot models                      local Ollama models (and whether Ollama is running)
  slopbot pull <model> [--default]    download an Ollama model (optionally make it the default)
`;

const brief = (args: Record<string, unknown>) => {
  const s = JSON.stringify(args);
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
};

let searchHintShown = false;

function makeHooks(rl?: readline.Interface): AgentHooks {
  return {
    onToolCall: (call, d) =>
      console.log(c.dim(`  → ${call.name} ${brief(call.args)}`) + (d.action === "deny" ? c.red(`  ✖ ${d.reason}`) : "")),
    onToolResult: (call, result, ok) => {
      const first = result.split("\n").slice(0, 3).join(" ⏎ ");
      console.log(c.dim(`    ${ok ? "✓" : c.red("✗")} ${first.slice(0, 200)}`));
      if (call.name === "web.search" && ok && !searchHintShown && /source="web\.search:basic"/.test(result)) {
        searchHintShown = true;
        console.log(c.yellow("    tip: search is limited to encyclopedia-style results. Add a free key for the full web:"));
        console.log(c.yellow("         npm run slopbot secret set search.brave   (or search.ollama / search.tavily)"));
      }
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

let mcpManager: McpManager | undefined;
const LONG_RUNNING = new Set(["daemon", "mcp"]);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const store = new Store(config.dataDir, { retentionDays: config.retentionDays });
  const mcp = (mcpManager = new McpManager(config));

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
      const agent = new Agent(config, store, bot, "interactive", makeHooks(rl), mcp);
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
      const agent = new Agent(config, store, bot, bg ? "background" : "interactive", makeHooks(rl), mcp);
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
      const res = await runScheduled(config, store, bot, s, console.log, mcp);
      if (res) console.log(`\n${res.text}`);
      return;
    }

    case "daemon": {
      if (!acquireLock(config.dataDir, "scheduler")) throw new Error("Schedules are already running in another SlopBot process (the desktop app or another daemon).");
      console.log(c.bold("SlopBot daemon started. Ctrl-C to stop."));
      const telegram = new TelegramChannel({ config, store, mcp, secrets: openSecretStore(config.dataDir), log: (m) => console.log(c.dim(m)) });
      if (await telegram.start()) console.log(`📱 Telegram connected as @${telegram.status().botUsername}${telegram.status().linked ? ` (linked to ${telegram.status().ownerName})` : " (not linked yet: open the desktop app → Channels)"}`);
      else if (telegram.status().error) console.log(c.yellow(`Telegram: ${telegram.status().error}`));
      startDaemon(config, store, mcp, { telegram: (t, x) => telegram.report(t, x) });
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
      console.log(await executeApproval(config, store, loadBot(config, a.bot), id, mcp));
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

    case "secret": {
      const [sub, name] = rest;
      const store = openSecretStore(config.dataDir);
      const where =
        store.kind === "keychain"
          ? "your macOS Keychain"
          : store.kind === "dpapi"
            ? "Windows-encrypted storage (DPAPI)"
            : store.kind === "libsecret"
              ? "your system keyring"
              : `${config.dataDir}/secrets`;
      if (sub === "set") {
        need(name, "secret name");
        const value = await readSecret(`Paste the value for ${name} (input hidden): `);
        if (!value) throw new Error("Nothing entered");
        store.set(name, value);
        console.log(`${c.green("✓")} Saved ${name} in ${where}. Reference it in config as \${secret:${name}}`);
      } else if (sub === "rm") {
        store.delete(need(name, "secret name"));
        console.log(`Removed ${name}.`);
      } else if (sub === "check") {
        console.log(store.get(need(name, "secret name")) === undefined ? `${name}: not set` : `${name}: set (in ${where})`);
      } else console.log("Usage: slopbot secret set|rm|check <name>");
      return;
    }

    case "skills":
    case "skill": {
      const [sub, a1, a2] = rest;
      const botsFlag = rest.indexOf("--bots");
      const bots = botsFlag >= 0 ? String(rest[botsFlag + 1] ?? "").split(",").filter(Boolean) : ["*"];
      if (!sub || sub === "list") {
        const skills = listSkills(config);
        const allBots = loadBots(config);
        if (!skills.length) return console.log(`No skills yet. Add one with: slopbot skills add <folder or SKILL.md>  (library: ${skillsDir(config)})`);
        for (const s of skills) {
          const viaYaml = allBots.filter((b) => b.skills?.includes(s.name) || b.skills?.includes("*")).map((b) => `${b.name} (yaml)`);
          const who = s.bots.includes("*") ? "all bots" : [...s.bots, ...viaYaml.filter((y) => !s.bots.includes(y.split(" ")[0]))].join(", ") || "no bots yet";
          console.log(`${c.bold(c.cyan(s.name))}  ${s.error ? c.red(`✗ ${s.error}`) : c.dim(who + (s.enabled ? "" : " (off)"))}`);
          if (s.description) console.log(`  ${s.description}`);
        }
      } else if (sub === "add") {
        const name = addSkill(config, need(a1, "path to a skill folder or SKILL.md"), bots);
        console.log(`${c.green("✓")} Added skill ${c.bold(name)} for ${bots.includes("*") ? "all bots" : bots.join(", ")}.`);
      } else if (sub === "use") {
        need(a1, "skill name");
        if (!listSkills(config).some((s) => s.name === a1)) throw new Error(`No skill "${a1}"`);
        assign(config, a1, need(a2, "bots (comma-separated, or *)").split(",").filter(Boolean));
        console.log(`${c.green("✓")} ${a1} → ${a2}`);
      } else if (sub === "rm") {
        removeSkill(config, need(a1, "skill name"));
        console.log(`Removed ${a1}.`);
      } else console.log("Usage: slopbot skills [list] | add <path> [--bots a,b] | use <skill> <bots> | rm <skill>");
      return;
    }

    case "shop": {
      const [sub, url, cur] = rest;
      const shop = new ShoppingService(config, store);
      if (sub === "check") {
        need(url, "product page URL");
        const currency = (cur ?? "USD").toUpperCase();
        try {
          const info = await shop.readListing(url, currency);
          console.log(`${c.green("✓")} ${info.title ?? ""}`);
          console.log(`  price: ${formatMoney(info.price)}  stock: ${info.inStock === undefined ? "not shown" : info.inStock ? "in stock" : "sold out"}  seller: ${info.seller ?? "not shown"}  (from ${info.source})`);
        } catch (e: any) {
          console.log(c.red(`✗ ${e.message}`));
          if (e.hint) console.log(c.dim(`  ${e.hint}`));
          console.log(c.dim("  In the desktop app, pages that block plain downloads are also tried in the shopping browser."));
        }
        return;
      }
      const s = shop.state.read();
      if (!s.watches.length) console.log("No watches yet. Add them in the desktop app (Shopping).");
      for (const w of s.watches) {
        const last = w.lastError ? c.red(w.lastError) : (w.lastSummary ?? "");
        console.log(`${c.bold(c.cyan(w.name))} ${c.dim(w.kind)} ${w.enabled ? "" : c.dim("(paused)")}  ${last}`);
      }
      for (const d of s.deals.slice(-10).reverse()) console.log(c.dim(`  ${d.status.padEnd(10)} ${d.listing.title.slice(0, 60)} ${formatMoney(d.execution?.total ?? d.listing.price)}`));
      return;
    }

    case "models": {
      const ollama = new Ollama(ollamaUrl(config));
      const v = await ollama.version();
      if (!v) {
        const inst = Ollama.detect();
        return console.log(inst.binary || inst.app ? "Ollama is installed but not running. Start it with: ollama serve" : "Ollama isn't installed: https://ollama.com/download");
      }
      console.log(c.dim(`Ollama ${v} at ${ollama.baseUrl} · default model: ${config.defaultModel}`));
      const prov = ollamaProviderName(config);
      for (const m of await ollama.list()) {
        const tools = m.capabilities ? (m.capabilities.includes("tools") ? c.green("tools") : c.yellow("chat-only")) : "";
        const def = config.defaultModel === `${prov}/${m.name}` ? c.bold(c.cyan(" (default)")) : "";
        console.log(`${m.name.padEnd(28)} ${(m.parameterSize ?? "").padEnd(7)} ${(m.size / 1e9).toFixed(1).padStart(5)} GB  ${tools}${m.loaded ? c.dim(" in-memory") : ""}${def}`);
      }
      return;
    }

    case "pull": {
      const model = need(rest.find((a) => !a.startsWith("--")), "model name");
      const ollama = new Ollama(ollamaUrl(config));
      if (!(await ollama.version())) throw new Error("Ollama isn't running. Start it with: ollama serve");
      let last = 0;
      await ollama.pull(model, (p) => {
        const pct = p.total ? Math.floor((p.completed / p.total) * 100) : 0;
        if (p.done || pct !== last) {
          last = pct;
          process.stdout.write(`\r${model}: ${p.total ? `${pct}% of ${(p.total / 1e9).toFixed(1)} GB` : p.status}`.padEnd(60));
        }
      });
      console.log(`\n${c.green("✓")} ${model} downloaded`);
      if (rest.includes("--default")) {
        const prov = ensureOllamaProvider(config.rootDir, `${ollama.baseUrl}/v1`);
        setDefaultModel(config.rootDir, `${prov}/${model}`);
        console.log(`Default model is now ${prov}/${model}`);
      }
      return;
    }

    case "connectors": {
      const servers = mcp.readServers();
      if (!Object.keys(servers).length) return console.log(`No MCP servers yet. Add them in the desktop app (Connectors) or ${mcp.file}`);
      for (const [name, def] of Object.entries(servers)) {
        const where = def.url ?? [def.command, ...(def.args ?? [])].join(" ");
        process.stdout.write(`${c.bold(c.cyan(name))} ${c.dim(where)}  bots: ${(def.bots ?? []).join(", ") || "none"}  `);
        if (def.enabled === false) {
          console.log(c.dim("disabled"));
          continue;
        }
        try {
          const conn = await mcp.connect(name);
          console.log(c.green(`✓ ${conn.tools.length} tools`) + c.dim(`  ${conn.tools.map((t) => t.name).join(", ").slice(0, 160)}`));
        } catch (e: any) {
          console.log(c.red(`✗ ${e.message}`));
        }
      }
      return;
    }

    case "mcp": {
      // stdout is the MCP channel: nothing else may print there.
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createMcpServer } = await import("./mcp/server.js");
      await createMcpServer(config, store, "0.1.0", mcp).connect(new StdioServerTransport());
      console.error(`slopbot MCP server ready (home: ${config.rootDir})`);
      return;
    }

    default:
      console.log(HELP);
  }
}

/** Read a secret without echoing it (TTY), or the whole of stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("Cancelled"));
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function need(v: string | undefined, what: string): string {
  if (!v) {
    console.error(c.red(`Missing ${what}.`) + "\n\n" + HELP);
    process.exit(1);
  }
  return v;
}

main()
  .then(async () => {
    // One-shot commands: shut down MCP server subprocesses so the CLI can exit.
    if (!LONG_RUNNING.has(process.argv[2])) await mcpManager?.closeAll();
  })
  .catch(async (e) => {
    console.error(c.red(`error: ${e?.message ?? e}`));
    await mcpManager?.closeAll();
    process.exit(1);
  });
