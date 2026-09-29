# NPI deck

**A calmer place to drive your coding agent.**

The [`omp`](https://github.com/can1357/oh-my-pi) terminal agent is excellent at the actual coding. But terminals weren't built for everything that comes with running an agent for hours a day: keeping track of what it's working on, glancing at it from another room, picking up where it left off tomorrow, deciding whether to let it execute the thing it just proposed.

pi is known for its flexibility and omp applies some opinions on how to leverage it more effectively. NPI deck is best understood as a web interface for omp with a small set of additional opinions applied on top of omp. 

> **Status:** v0.5.0 — cross-platform CI matrix, Linux container builds and boots, Mac/Linux launcher. See [CHANGELOG.md](./CHANGELOG.md).

![npi-deck chat surface with live tool calls](./docs/screenshots/00-hero-chat-paper.png)

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Kanban](./docs/screenshots/01-kanban-paper.png) | ![Marketplace](./docs/screenshots/03-marketplace-slate.png) |
| Kanban with `T-N` display IDs (paper theme) | Marketplace browser populated with `anthropics/claude-plugins-official` (slate theme) |
| ![Appearance settings](./docs/screenshots/04-settings-appearance-slate.png) | ![Messaging settings](./docs/screenshots/05-settings-messaging-slate.png) |
| Settings → Appearance theme cards | Settings → Messaging with the Telegram bridge supervisor |
| ![Routines builder](./docs/screenshots/06-routines-builder-paper.png) | ![Routines canvas](./docs/screenshots/06-routines-canvas-paper.png) |
| V1 routines builder editing `daily-briefing` in form mode | The same routine in canvas mode — every step is a node |

</details>

## Who this is for

You're already running an agent. You've felt the friction of trying to:

- **Track what it's actually doing for you** as a body of work, not a scroll of terminal output that ends at `Ctrl+L`.
- **Ask it something from somewhere that isn't your laptop** such as the couch, a walk, bed.
- **Decide carefully** when it's about to do something big, instead of trusting it on the first try.
- **Capture an idea or a bug** without breaking your current focus.
- **Have it remember things** across sessions without you stuffing context windows by hand.

NPI deck is the cockpit that holds all of that. The chat surface stays at parity with the terminal,  but everything *around* the chat is built for the rest of the work.

## What you get

**A kanban that's actually yours.** Backlog → Active → Done columns with drag-and-drop. Tasks get `T-N` display IDs you can refer to in conversation (`/task done T-32`). The agent can mutate the board too — its work becomes visible without you doing the bookkeeping.

**Plan mode** — Shift+Tab in the composer enters NeoPi's read-only planning mode. The agent writes a `local://<slug>-plan.md` artifact and submits it through `xd://propose`; the plan appears in the chat for approval, in-place editing, or rejection with feedback. Approval returns the agent to full tools to execute; rejection lets it revise and resubmit. A resumed planning session restores its plan artifact.

**An inbox you can dump into.** Scratch ideas, bug reports, decisions to revisit. One-click promote to task when the dust settles. No mental context-switch from current work.

**A knowledge base over your own markdown.** Point `/kb` at a `~/kb` directory you already keep (or accept the default), and the deck gives you a tree, viewer, editor, Obsidian-style force-directed graph, full-text search, `[[wikilink]]` resolution + create-on-click. Long-term memory that's plaintext-portable and outlives any agent session.

**Routines.** Multi-step pipelines on a cron, webhook, manual, or event trigger — author them visually on a node canvas, or in YAML if you're that kind of person. Ships with a `daily-briefing` template that wakes up, reads your kanban + inbox, and writes you a one-card morning summary back to the inbox. Build your own from there.

**A messaging bridge to your phone.** Telegram now (Slack / Discord / Matrix on the roadmap). DM the agent from anywhere; replies stream live via `editMessageText`. Allowlist-gated so only you (and whoever you invite) can drive it.

**Multi-session.** The chat sidebar lists every session you have open, plus the persisted ones you can resume. Each gets its own kanban scope, its own model, its own queued prompts. Switch between them without losing place.

**A marketplace.** Browse, install, and uninstall skills/plugins/MCPs over the SDK's plugin format. Empty state seeds with `anthropics/claude-plugins-official` so you're never staring at an empty page.

**Settings that respect your `.env`.** Provider API keys, host/port, data dirs — all manageable from a UI with masked secrets, an audit log, and atomic writes. Hot-applied where possible.

**Three themes.** Paper (warm cream + rust accent, engineer's-notebook aesthetic), Slate (dark), Horizon (purple-ink dark). FOUC-free swap — pick one and refresh-proof it.

## Quickstart

NPI deck runs one way: from a git checkout, with a NeoPi source tree prepared by `scripts/neopi-setup.ts` and registered in `~/.npi-deck/config.yml`, started by the `npi-deck` launcher. There is no npm package, Docker image, or Windows launcher, and the deck does not check for updates.

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.3.14 and Git on your `PATH`, a NeoPi checkout for `scripts/neopi-setup.ts` to build from (see [docs/install.md](./docs/install.md#neopi-backend-tree)), and a systemd user manager (or run the launcher with `--no-systemd`).

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts                        # prepare the pinned NeoPi tree, register it in config.yml
ln -s "$PWD/bin/npi-deck" ~/.local/bin/npi-deck   # once
npi-deck
```

`neopi-setup` adds a worktree of the commit in `neopi.pin` under `~/.npi-deck/neopi/`, links its native addon, and records it under `backends` in `~/.npi-deck/config.yml`, making it `activeBackend` if none is set; see [config.yml](./docs/install.md#configyml). `npi-deck` builds the web bundle if needed and serves the deck on <http://127.0.0.1:1701> as the systemd user service `npi-deck` in `neopi-deck.slice`; Ctrl-C stops it, and anything the deck spawned dies with it. See [the launcher](./docs/install.md#the-npi-deck-launcher). For working on the deck itself, `bun run dev` starts an unsupervised server on :1701 and the Vite app with hot reload on <http://127.0.0.1:5173>; see [CONTRIBUTING.md](./CONTRIBUTING.md).

On first run, the deck creates `~/.omp/agent/` from scratch; its own state lives in `~/.npi-deck/` (override with `NPI_DECK_HOME`). If you already use `omp` in a terminal on this machine, your existing `~/.omp/agent` is picked up automatically — no re-auth.

**Authenticate (one-time, in the deck UI):**

- **Claude Pro / Max, ChatGPT Plus / Pro, or any subscription provider** → Settings → Providers → click *Sign in*. Browser OAuth flow handles the rest. Token stored in `~/.omp/agent/auth.db`.
- **Anthropic / OpenAI / OpenRouter / Google / etc. API key** → Settings → Env → paste the key. Saved to the deck-managed `.env` (never logged in clear text).

That's it — pick a model in the chat surface and send a prompt.

Other env knobs: `NPI_DECK_PORT`, `NPI_DECK_HOST`, `NPI_DECK_DB_PATH`, `NPI_DECK_UPLOADS_ROOT` — see [docs/configuration.md](./docs/configuration.md). For the full step-by-step (prerequisites, `neopi-setup` options, `config.yml`, the launcher, uninstalling), see [docs/install.md](./docs/install.md).

## How it compares

omp + NPI deck is one slice of a busy space. The neighbors:

|                                | **omp + NPI deck**                                                                | **[Claude Code](https://github.com/anthropics/claude-code)** | **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** | **[OpenClaw](https://github.com/openclaw/openclaw)**                       |
|--------------------------------|-----------------------------------------------------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------|----------------------------------------------------------------------------|
| Form factor                    | Terminal TUI (omp) + web cockpit (NPI deck)                                       | Terminal CLI / IDE plugin                                    | Terminal TUI + multi-channel gateway                             | Daemon + multi-channel gateway                                             |
| Model support                  | Anthropic, OpenAI, Google AI / Vertex, OpenRouter, Ollama, llama.cpp, LM Studio, any OpenAI-compatible | Anthropic Claude only                                        | Model-agnostic (Nous Portal, OpenRouter, NIM, …)                 | Model-agnostic (profiles in `openclaw.json`, w/ fallback chain)            |
| Hosting                        | Self-hosted Bun process, loopback-only by default                                 | Anthropic-hosted CLI                                         | Local / Docker / SSH / Modal / Daytona / Vercel Sandbox          | Self-hosted on owned host (Mac mini, VPS)                                  |
| Kanban / task board            | Built-in, WS-synced, `T-N` display IDs                                            | —                                                            | —                                                                | —                                                                          |
| Plan mode                      | Shift+Tab / `/plan` → propose → approve/edit/reject before execution              | TUI plan-mode equivalent                                     | —                                                                | —                                                                          |
| Routines / scheduled work      | Multi-step pipelines + visual canvas + per-step observability                     | —                                                            | —                                                                | Heartbeat scheduler (~30 min)                                              |
| Knowledge base                 | `/kb` cockpit over local markdown wiki + graph + backlinks                        | —                                                            | "Deepening user model" (internal, not a markdown wiki)           | —                                                                          |
| Inbox + promote-to-task        | Built-in                                                                          | —                                                            | —                                                                | —                                                                          |
| Messenger bridges              | Telegram (Slack / Discord / Matrix on the roadmap)                                | —                                                            | Telegram, Discord, Slack, WhatsApp, Signal                       | 20+ (WhatsApp, Telegram, Slack, Discord, iMessage, Matrix, Teams, …)       |
| License                        | MIT                                                                               | Proprietary                                                  | Open source                                                      | Open source                                                                |

The short version: **Claude Code** is the polished vendor experience for Claude. **Hermes** is the self-improving agent with serverless backends. **OpenClaw** lives wherever you message from. **omp + NPI deck** is the cockpit shape — a model-agnostic coding agent with a web surface for the work *around* the chat (kanban, routines, KB, inbox, plan-mode approval, messaging bridge).

## A few notes on running it

**It's not a hosted product.** You run it yourself, on your machine or in a VM you own. Defaults are loopback-only — to reach it from your phone, front it with Tailscale Serve, an SSH tunnel, or a reverse proxy with its own auth. See [docs/deployment.md](./docs/deployment.md) for the hardening checklist.

**It's not a replacement for `omp`.** It embeds the same SDK in-process and shares the same `~/.omp/agent` session + auth store. Run both — they coexist. The terminal is still where you'll do quick one-shots; the deck is where work sticks around.

**State is yours.** Tasks, inbox, routines, KB — all SQLite + plain markdown on disk. No telemetry. The deck never logs secret values, only redacted forms.

## Docs

- [Install](./docs/install.md) — `neopi-setup`, `config.yml`, the `npi-deck` launcher, uninstall.
- [Configuration](./docs/configuration.md) — full env reference + restart semantics.
- [Deployment](./docs/deployment.md) — Tailscale, SSH-tunnel, hardening checklist.
- [Slash commands](./docs/slash-commands.md) — deck `/task` + `/plan`, SDK builtins, user/project markdown commands.
- [Marketplaces](./docs/marketplaces.md) — catalog seeding, install semantics, capability badges.
- [Skills](./docs/skills.md) — `/skills` view, plugin → skill hierarchy, scope semantics, REST surface.
- [Telegram bridge](./docs/telegram.md) — DM-driven agent from your phone.
- [Themes](./docs/themes.md) — Paper / Slate / Horizon / adding more.
- [Architecture](./docs/architecture.md) — workspace layout, frame model, synthetic events, theming.
- [TUI parity](./docs/tui-parity.md) — feature matrix vs the omp TUI.
- [Contributing](./CONTRIBUTING.md) — dev loop, code quality, style.

## License

MIT. See [LICENSE](./LICENSE). NPI deck is a fork of [bjb2/omp-deck](https://github.com/bjb2/omp-deck) by Bryan Bartley.
