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

**Hosted model:** put `OPENAI_API_KEY=...` / `ANTHROPIC_API_KEY=...` in `.env`, then set
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
