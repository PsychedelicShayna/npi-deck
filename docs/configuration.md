# Configuration

npi-deck reads configuration from three layers, in priority order:

1. **Process environment** — values set in the launching shell (or systemd
   unit). Always win.
2. **Deck-managed `.env`** — file the deck writes when you save through the
   Settings → Env UI. Loaded into `process.env` at boot.
3. **Built-in defaults** — declared in
   `apps/server/src/config.ts` and `apps/server/src/env-schema.ts`.

The Settings → Env UI edits layer 2 only. It never overwrites layer 1: if you
launched the deck with `NPI_DECK_PORT=9000` in the shell, the Settings page
still shows port 9000 as the active value with source `process env`, and
saving a new value writes to the managed `.env` (where it will take effect
only after you remove the shell override and restart).

See [.env.example](../.env.example) for a copy-paste template with comments.

## The data dir

Everything the deck keeps lives in one directory: `~/.npi-deck`, or
`NPI_DECK_HOME` if set. `NPI_DECK_HOME` must come from the launching
environment; the managed `.env` lives inside the data dir, so it cannot move
it. The old `~/.omp-deck`, `~/.config/omp-deck` and `NPI_DECK_DATA_DIR`
locations are not read.

The managed `.env` is `<data dir>/.env`. The same directory holds:

- `env-audit.log` — append-only `timestamp | key | action (set/unset/reveal)`.
  Values are never logged.
- `telegram-bridge.db` — chat→session map (only when the bridge runs).
- `deck.db` and `uploads/` — kanban, routines, inbox, pasted images.
- `config.yml` and `neopi/<sha>/` — backend trees and the active backend.
- `run/` — launcher lock, generation and owned-process journals.

## Variable reference

### Network

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_HOST` | `127.0.0.1` | yes | Bind host. Loopback by default — never `0.0.0.0` without an auth layer. |
| `NPI_DECK_PORT` | `1701` | yes | HTTP + WebSocket port. |
| `NPI_DECK_WEB_PORT` | `5173` | yes | Vite dev server port (dev only). Proxies `/api` and `/ws` to `NPI_DECK_PORT`. |
| `NPI_DECK_API_BASE` | derived | no | Loopback URL standalone bridge processes use. Derived from host+port when unset. |

### Workspaces

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_DEFAULT_CWD` | `process.cwd()` | next session | Working dir for new chat sessions. |
| `NPI_DECK_WORKSPACES` | _(none)_ | next session | Comma-separated extra workspace roots shown in the picker. |

### NeoPi SDK and new-chat models

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `PI_NO_TITLE` | _(unset)_ | next session | Set truthy to disable SDK auto-title generation. |

New deck chats without an explicitly selected model start on **Opus 5.5
(`medium`)**. The deck chooses the first authenticated provider: Anthropic,
GitHub Copilot, then OpenRouter. The only retry fallback is **GPT-6 Sol
(`medium`)**, preferring OpenAI Codex, then GitHub Copilot, then OpenRouter.
If no Sol provider is authenticated, the fallback still targets OpenAI Codex
and requires sign-in before it can serve a request. If no Opus provider is
authenticated, creating a new chat reports an error instead of silently
switching to an unrelated model.

This policy applies only to new deck chats. It does not rewrite NeoPi's
`config.yml`, affect CLI sessions or resumed chats, or replace an explicit
model selection in the chat header. `OMP_MODEL` and NeoPi's global default
model do not override the deck's new-chat default.

### Sessions

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_IDLE_TIMEOUT_MS` | `300000` (5 min) | no | Milliseconds before an unsubscribed idle session is reaped. `0` disables reaping. |

### Storage

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `NPI_DECK_HOME` | `~/.npi-deck` | yes | The data dir. Launching environment only. |
| `NPI_DECK_DB_PATH` | `<data dir>/deck.db` | yes | SQLite database path. |
| `NPI_DECK_UPLOADS_ROOT` | `uploads/` next to the db | yes | Pasted-image store. |
| `NPI_DECK_WEB_DIST` | `apps/web/dist` once built | yes | Static web bundle dir. The launcher sets it. |

### Set by the launcher and the server

Not settings; listed so they are recognizable in `/proc/<pid>/environ`.

| Var | Set by | Notes |
|---|---|---|
| `NPI_DECK_LAUNCHER_PID`, `NPI_DECK_LAUNCHER_STARTTIME` | `npi-deck` launcher | The server shuts down when this process is gone. Without them, the restart button reports that no supervisor is present. |
| `NPI_DECK_GEN` | server, at boot | Generation marker inherited by every descendant. The next boot (and the launcher, once its server is gone) kills processes of dead generations. |
| `NPI_DECK_TELEGRAM_BRIDGE_ENTRY` | you, rarely | Override the Telegram bridge entry script. |

### Logging

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `LOG_LEVEL` | `info` | no | `debug` / `info` / `warn` / `error`. Hot-applied. |

### Telegram bridge

The bridge is a separate Bun process (`apps/bridges/telegram/`) supervised by
the deck. None of these vars are required for the deck itself.

| Var | Default | Restart? | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | _(unset)_ | bridge | From @BotFather. Sensitive. |
| `TELEGRAM_ALLOWED_USERS` | _(unset)_ | bridge | Comma-separated numeric Telegram user IDs. Required. |
| `TELEGRAM_BRIDGE_DB_PATH` | `<data dir>/telegram-bridge.db` | bridge | SQLite chat→session map. |

See [docs/telegram.md](./telegram.md) for the full bridge setup.

### Provider API keys

Read by the omp SDK directly from `process.env`. The deck Settings UI shows
them masked; reveal requires a loopback request.

| Var | Sensitive? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API. |
| `OPENAI_API_KEY` | yes | OpenAI API. |
| `OPENROUTER_API_KEY` | yes | OpenRouter aggregator. |
| `GROQ_API_KEY` | yes | Groq API. |
| `GOOGLE_API_KEY` | yes | Gemini API. |
| `XAI_API_KEY` | yes | xAI / Grok API. |

If you authenticated via `omp` CLI (OAuth), the SDK reads credentials from
`~/.omp/agent/auth.db` instead of env vars. Either path works.

## Restart semantics

Vars with `Restart?: yes` need a full server restart to take effect — typically
because they affect the bind socket, the SQLite file path, or the web bundle
location. The Settings UI surfaces a "Restart server to apply" banner with a
one-click button (`POST /api/server/restart`) when you save one.

Vars with `Restart?: no` hot-apply: `LOG_LEVEL` flips the logger threshold,
`NPI_DECK_IDLE_TIMEOUT_MS` re-arms the reaper, etc.

Vars with `Restart?: bridge` mean the deck server keeps running, but the
relevant bridge process (e.g. telegram) must be restarted via Settings →
Messaging → Restart.

Vars with `Restart?: next session` apply only to sessions created **after**
the change — existing in-memory sessions keep their original values.
