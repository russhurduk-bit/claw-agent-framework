# Claw — Telegram-native Multi-Agent Assistant Framework

Claw is a small, production-shaped framework for building a **persistent AI
assistant you talk to over Telegram**. It wraps the [Claude Agent
SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) in the parts
a real assistant needs but the SDK doesn't give you: a chat transport, durable
per-chat sessions, a memory layer, a scheduler, a multi-agent "crew" for larger
jobs, and a pluggable integration contract.

It runs as a single long-lived Node process. Message a Telegram bot; Claw builds
memory context, runs an agentic loop with tool access on the host, and streams
the answer back — text, voice, images, or documents.

> This is a sanitized public extract of a personal assistant that ran on the
> author's server. Private service integrations (banking, a school portal, a
> home router, etc.) were removed and replaced with a single generic
> integration example. Everything here is original framework code.

## Highlights

- **Agent loop** (`src/agent.ts`) — wraps the Claude Agent SDK: multimodal input
  (images / video frames), session resume, keyword-triggered skill injection,
  MCP server loading, a curated tool allow-list, custom subagents, and graceful
  crash/timeout recovery.
- **Telegram bot** (`src/bot.ts`) — grammY bot handling text, voice, photos,
  documents, and video; Markdown → Telegram-HTML formatting; message chunking;
  a typing indicator; and per-chat commands.
- **Crew orchestration** (`src/crew-orchestrator.ts`, `src/crew.ts`,
  `src/crew-runner.ts`) — a message-bus multi-agent system. A role-based team
  (orchestrator, manager, engineer, tester, designer, researcher, devops,
  analyst, planner) collaborates on a project through a lifecycle state machine.
  Routing is LLM-driven when a model key is present, with a deterministic
  fallback so the crew keeps moving regardless.
- **Scheduler** (`src/scheduler.ts`, `src/schedule-cli.ts`) — cron-based tasks
  that run through the agent with strict guardrails; simple reminders short-circuit
  the LLM entirely.
- **Memory** (`src/memory.ts`, `src/db.ts`) — a three-tier store (permanent /
  semantic / episodic) over SQLite + FTS5, with message classification, entity
  extraction, topic routing, deduplication, and per-chat conversation history.
- **Self-learning crew** (`src/crew-learning.ts`) — agents record lessons after
  each task and get relevant past experience injected before the next one, all
  in local SQLite.
- **Pluggable integrations** (`src/integrations/`) — a small `Integration`
  contract plus a working example, so you can teach the assistant to talk to any
  external service without touching the core.

## Architecture

```
Telegram ──▶ bot.ts ──▶ memory.ts (context)         db.ts (SQLite + FTS5)
                 │            │                        ▲  sessions / memory
                 ▼            ▼                        │  chat history / tasks
              agent.ts ──▶ Claude Agent SDK ──▶ tools (Bash, Read/Write, MCP, Web)
                 ▲
   scheduler.ts ─┘  (cron tasks run through the same agent)

crew-cli.ts ──▶ crew-orchestrator.ts ──▶ crew-runner.ts ──▶ Claude Agent SDK
                     (message bus, crew-db.ts)          (one session per agent)
```

Two execution modes share the same SQLite store:

1. **Single-agent** — the default. One Telegram chat → one resumable Claude
   session, wrapped with memory and scheduling.
2. **Crew** — a background daemon that decomposes a project and routes tasks
   between specialized agents until it's delivered.

## Getting started

Requires Node.js 20+. Optional host tools: `ffmpeg`/`ffprobe` (video frames),
`exiftool` (metadata stripping).

```bash
npm install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN at minimum
npm run dev               # or: npm run build && npm start
```

On first run leave `ALLOWED_CHAT_IDS` empty, message the bot, send `/chatid`,
paste your id into `.env`, and restart to lock it down.

### Bot commands

| Command | What it does |
|---|---|
| `/start` | Health check |
| `/chatid` | Print this chat's id |
| `/newchat`, `/forget` | Reset the session and chat history |
| `/voice` | Toggle spoken replies (needs ElevenLabs) |
| `/memory [stats\|permanent\|recent]` | Inspect the memory store |
| `/remember <text>` | Save a permanent memory |
| `/schedule [list\|delete\|pause\|resume]` | Manage scheduled tasks |

Send a photo, voice note, document, or video and it's passed to the agent
natively (video is sampled into frames for multimodal analysis).

### Scheduler

```bash
npm run schedule create "Summarize my inbox" "0 9 * * *" <chat_id>
npm run schedule list
```

### Crew

```bash
npm run crew daemon                                   # start the orchestrator
npm run crew new "Acme" "@acme" "Landing page" "..."  # start a project
npm run crew status
```

## Configuration

All configuration is environment-based (`.env`, parsed by `src/env.ts`). See
`.env.example` for the full list. Only `TELEGRAM_BOT_TOKEN` is required;
everything else (voice, multimodal, crew routing, userbot) is optional and
degrades gracefully when unset.

## Writing an integration

Implement the `Integration` contract in `src/integrations/index.ts` and register
it, or expose your service as a CLI the agent calls via Bash and describe it in a
`.claude/skills/*.md` file so it's auto-loaded on matching messages. See
`src/integrations/example-integration.ts` for a complete, key-free example.

## Tests

```bash
npm test        # vitest: formatting, DB/memory, env parsing
npm run typecheck
```

## Project layout

```
src/
  index.ts             Process bootstrap, single-instance lock, wiring
  config.ts / env.ts   Environment configuration
  agent.ts             Core agent loop (Claude Agent SDK)
  bot.ts               Telegram bot (grammY) + message handling
  memory.ts / db.ts    Memory layer + SQLite/FTS5 storage
  scheduler.ts         Cron task runner
  schedule-cli.ts      Scheduler CLI
  voice.ts             STT (Whisper) + TTS (ElevenLabs)
  media.ts             Telegram media download helpers
  youtube.ts           YouTube URL enrichment (pluggable webhook)
  crew.ts              Agent role definitions
  crew-orchestrator.ts Multi-agent router / lifecycle daemon
  crew-runner.ts       Runs one agent task via the SDK
  crew-db.ts           Crew persistence (projects, tasks, messages)
  crew-learning.ts     Per-agent lessons + experience
  crew-cli.ts          Crew CLI
  integrations/        Pluggable integration contract + example + userbot client
```

## License

MIT.
