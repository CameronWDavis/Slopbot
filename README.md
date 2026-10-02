# SlopBot 🤖

Open-source, self-hosted **personal AI agents**: an open take on OpenAI *dots* and Meta *Muse*.
Make a bot that manages your finances, codes on your machine, or emails you reports, and run it on
**any model**: your own API key (OpenAI, Anthropic, OpenRouter, Groq…) or a **fully local LLM** (Ollama, LM Studio, vLLM, llama.cpp).

- 🧩 **Bots as YAML**: persona, model, tools, permissions, schedules
- 🔌 **Bring your own model**: mix providers per bot, no key needed for local
- 🛡️ **You stay in control**: allow / ask / deny rules, approval queue, full audit log
- 🧠 **Memory**: bots remember your preferences across sessions
- ⏰ **Always on**: cron schedules with email reports
- 📁 **Local-first**: all state is plain files in `./data`

See **[SPEC.md](SPEC.md)** for the architecture and roadmap.

## Quick start

```bash
npm install
npm run slopbot init          # creates slopbot.config.yaml
```

**Local model (no API key):**

```bash
ollama pull qwen3:8b          # any tool-calling model: qwen3, llama3.1, mistral-nemo, gpt-oss…
npm run slopbot ping
```

**Hosted model:** store your key in the Keychain and reference it from the config:

```bash
npm run slopbot secret set openai      # paste the key; input is hidden
```

```yaml
providers:
  openai: { type: openai, baseUrl: https://api.openai.com/v1, apiKey: "${secret:openai}" }
```

(A `.env` file with `OPENAI_API_KEY=...` also works.) Then set
`defaultModel: openai/gpt-5` or `anthropic/claude-sonnet-5-5` (or `model:` on a single bot).

## Use it

```bash
npm run slopbot bots                                       # list bots
npm run slopbot chat ledger                                # chat with the finance bot
npm run slopbot run ledger "import examples/sample-bank.csv and tell me where my money went"
npm run slopbot run coder "add a --verbose flag to the CLI and run the tests"
npm run slopbot daemon                                     # run schedules (weekly report, digests)
npm run slopbot approvals                                  # review actions bots want to take
npm run slopbot approve ap_1234abcd
npm run slopbot activity -n 30                             # audit trail
```

## Desktop app 🖥️

A native, cyberpunk-themed desktop app with **Bag Buddy**, an animated 3D mascot that reacts to what your bots are actually doing. He thinks while they work, celebrates when they finish, and plays paddle-ball if you leave him alone.

```bash
npm run desktop               # build and launch
npm run desktop:dist:mac      # → release/SlopBot-<version>-arm64.dmg
npm run desktop:dist:win      # → release/SlopBot Setup <version>.exe (best built on Windows)
npm run desktop:dist:linux    # → release/SlopBot-<version>.AppImage
```

It runs fully on your machine, with no web server and no open ports. In dev it uses this folder's `bots/`, config, and `data/`. The packaged app keeps them in `~/Library/Application Support/SlopBot/home` (seeded with the sample bots on first launch). Override with `SLOPBOT_HOME`.

## Local models in one click (Ollama) 🦙

Open **Models** in the desktop app:

- See whether Ollama is installed and running, and **Start / Stop** it (or **Get Ollama ↗** if it isn't installed)
- **Download** recommended open models with a live progress bar. Each shows its real download size and whether it fits your Mac's memory
- Every installed model shows whether it supports **tools** (bots need this), whether it's loaded in memory, and its size
- **Set as default** or **Use for bot…**: SlopBot edits your config/bot YAML for you (keeping comments)
- **Unload** to free memory now, **Delete** to reclaim disk space, or type any model from ollama.com/library

From the terminal: `npm run slopbot models`, `npm run slopbot pull qwen3:8b --default`.

## Give your bots more tools (MCP connectors) 🧩

Open **Connectors** in the desktop app to plug any MCP server into your bots:

- **Sign in with one click:** Notion, Linear, Sentry, Jira & Confluence. SlopBot opens your browser, you approve, and you're done (OAuth, no tokens to copy)
- **Quick add:** Filesystem, Browser (Playwright), GitHub, Knowledge graph, Sequential thinking, Everything (demo)
- **Paste JSON:** copy the `mcpServers` block from Claude Desktop, Cursor, or a server's README
- **Test connection** shows the server's tools before you save, then pick which bots get it

Read-only tools run freely; everything else asks you first, and destructive tools are flagged. API keys and tokens you paste go into your **macOS Keychain** (system keyring on Linux), so `slopbot.mcp.json` only holds references like `${secret:mcp.github.header.Authorization}`.

Lots of connectors on a small local model? Bots automatically get only the tools relevant to your request, plus a `tools.find` tool to look up the rest (`maxTools` in the config or a bot's YAML; `auto` by default). Config lives in `slopbot.mcp.json` (same format as Claude Desktop). From the terminal: `npm run slopbot connectors`.

## Vault: let bots use your accounts without seeing passwords 🔐

Open **Vault** and add an API key or login, plus the websites it's for. It's encrypted on this Mac (the key lives in your Keychain, so the file is useless anywhere else). Bots see only the name; when one calls an API "with credential GitHub", SlopBot attaches the key, **only for the sites you listed**, after asking you, and scrubs it from anything that comes back.

## Web search 🔎

Bots get a `web.search` tool. It works with no setup (Basic: DuckDuckGo instant answers + Wikipedia), or add a free key for full web results in **Connectors → Web search**: Ollama web search, Brave, or Tavily, or point it at your own SearXNG.

## Drive your bots from Claude Code (MCP) 🔌

SlopBot is also an MCP server, so Claude Code, Claude Desktop, or any MCP client can hand your bots tasks:

> "Ask ledger how much I spent on dining last month"

This repo ships a project `.mcp.json`, so Claude Code offers to enable the `slopbot` server when you open the folder. For another client, point it at:

```bash
npx tsx /path/to/SlopBot/src/cli.ts mcp      # set SLOPBOT_HOME=/path/to/SlopBot if launched from elsewhere
```

Tools: `list_bots`, `ask_bot`, `run_schedule`, `list_pending_approvals`, `get_activity`, `get_memory`.

Tasks sent over MCP run unattended (background mode). File writes, shell commands and emails are queued for **you** to approve in the desktop app or with `slopbot approve`. The MCP server has no approve tool on purpose.

## Make your own bot

Drop a YAML file into `bots/`:

```yaml
name: gymbro
description: Tracks workouts and nags me.
model: ollama/llama3.1:8b
persona: |
  You are a supportive but blunt fitness coach...
tools: ["fs.*", "memory.*", "email.send"]
permissions:
  - { tool: "email.send", action: allow }
schedules:
  - { name: nudge, cron: "0 18 * * *", task: "Check my workout log and nudge me if I skipped today.", notify: email }
```

## Tools

`fs.list/read/search/write/edit` · `shell.run` · `http.fetch` · `memory.remember/recall/forget` ·
`email.send/draft` · `finance.import_csv/add/query/summary/categorize`

## Development

```bash
npm test          # end-to-end tests against a mock model server
npm run typecheck
```

MIT licensed.
