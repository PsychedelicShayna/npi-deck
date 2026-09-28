# Architecture

## High level

```
Browser tabs (Vite dev :5173 · Bun prod :1701)
   │  WS frames (subscribe / prompt / abort) + REST control plane
   ▼
Bun server  (apps/server)
   ├─ AgentBridge interface
   │   └─ InProcessAgentBridge → @oh-my-pi/pi-coding-agent SDK
   │       └─ Map<sessionId, AgentSession>
   ├─ Hono REST router  /api/{health, sessions, tasks, routines, inbox,
   │                         settings, models, marketplace, bridges, slash-commands, fs}
   ├─ Bun.serve WebSocket hub  /ws
   ├─ BroadcastBus (non-session frames: tasks_changed)
   ├─ MarketplaceService (lazy SDK MarketplaceManager wrapper)
   ├─ BridgeSupervisor (telegram and future messaging bridges)
   ├─ Routines runner (croner)
   └─ Static file serving for the built web bundle
```

```
apps/bridges/telegram (standalone Bun process — only when started)
   ├─ Long-poll Telegram API
   ├─ Per-chat session map (SQLite)
   ├─ Deck REST + WS client (talks to the deck like any other client)
   └─ Supervised by the deck's BridgeSupervisor
```

## Workspaces

- **`apps/server`** — Bun + Hono backend. Embeds the omp SDK.
- **`apps/web`** — Vite + React + Tailwind frontend. Pure consumer of the WS
  event stream; reduces events into a structured `SessionUi` in
  `lib/reducer.ts`.
- **`apps/bridges/telegram`** — Standalone Bun process. Independent
  package, depends on `@npi-deck/protocol` for shared types.
- **`packages/protocol`** — Dep-free shared types (REST + WS frames + DB
  shapes). The contract layer.

## The `AgentBridge` interface

`apps/server/src/bridge/types.ts` defines the contract. Current impl is
`InProcessAgentBridge` which embeds the SDK in the same Bun process. A
future subprocess-per-session impl (`omp --mode rpc` over stdio) can drop in
behind the same interface — useful when you want crash isolation per session
or to run sessions on different machines.

Routes never import `@oh-my-pi/pi-coding-agent` directly. Everything
sessions-related flows through `AgentBridge` or `SessionHandle`.

## Frame model

The WS hub maintains:

- **Per-connection subscriptions** — `Set<sessionId>` per WS. Used to
  forward `session_event` frames + per-session bridge frames (UI dialog,
  plan-mode, subagent tree).
- **A global connection set** — `Set<ServerWebSocket>`. Used for broadcast
  frames (`tasks_changed`, `skills_changed`, `kb_changed`, `heartbeat`,
  `notification`) sent to every open client.

The `BroadcastBus` singleton (`apps/server/src/broadcast-bus.ts`) is the
producer side. Routes (`routes-tasks.ts`, `routes-skills.ts`, …) and deck
slash commands (`deck-slash-commands.ts`) call
`broadcastBus.broadcast(frame)`. The hub subscribes once at construction
and relays to every open connection.

Each in-process root subscribes to its own NeoPi `subagentEventBus` and joins
task lifecycle/progress/event updates to the global `AgentRegistry` parentId
chain. Only descendants of that root generation enter its `subagents_snapshot`
frames. `GET /api/subagents/:sessionId/:id/transcript` reads the child JSONL
incrementally; `POST /api/subagents/:sessionId/:id/abort` aborts the exact
registered session and tombstones its ref. Both reject another session's child
with 403. These routes do not resume parked agents or spawn a session while
browsing. Subagents remain visible in the chat's collapsible read-only panel
after completion; cross-process sessions are not part of this feature.

## Synthetic events

"Synthetic" event flavors flow over the same WS as the SDK's own events,
dispatched by the deck-side bridge code so the UI can react without
custom plumbing per feature:

- **`context_usage`** — emitted after every turn-end or compaction so the
  context indicator updates without a re-snapshot.
- **`session_updated`** — emitted after `session.setModel()` so the chat
  header's model label flips immediately.
- **`todo_phases_set`** — emitted after every `todo_write` tool result so
  the Inspector TodoPanel reflects intra-turn changes (the SDK's own
  `todo_reminder` only fires on reminder ticks — typically at turn
  boundaries — leaving the panel stale between cycles).
- **`prompt_queued`** + **`queue_state`** — emitted by the bridge's shadow
  queue when the user sends a prompt while streaming. `queue_state`
  re-broadcasts the canonical queue after every queue mutation (queue,
  cancel, edit, drain) so clients replace `queuedPrompts` wholesale.
- **`plan_mode_changed`**, **`plan_proposed`**, **`plan_proposal_resolved`**
  — plan-mode lifecycle. Pending proposals are replayed to late
  subscribers so a page reload during approval re-renders the card.
- **`ext_ui_dialog_open`** + **`ext_ui_dialog_cancel`** — `ask` tool +
  arbitrary `ctx.ui.*` extension calls. Replayed to late subscribers
  similarly.
- **`message_start` with `synthetic: true`** — emitted by both the SDK
  slash dispatcher and the deck slash dispatcher to inject the user's
  typed command + the handler's output into the transcript. The reducer
  ingests these as regular messages; the UI shows a `SYNTHETIC` badge.

The reducer (`apps/web/src/lib/reducer.ts`) handles each from a single
union case. No special protocol fork.

## Database

SQLite via Bun's built-in `bun:sqlite`. WAL mode, foreign keys on.

Schema lives in `apps/server/src/db/migrations/*.sql`. Migrations are
filename-sorted and applied at boot; a `schema_migrations` table records
which ones have been applied.

Tables:

- `schema_migrations` — applied migrations.
- `task_states` — kanban columns. Configurable.
- `tasks` — backlog/active/blocked/done items. `display_id` for human IDs (`T-1`, ...).
- `inbox_items` — quick captures + promote-to-task records.
- `routines` — cron / webhook / manual / event routine definitions (V0 single-action + V1 multi-step pipelines via `spec_yaml`).
- `routine_runs` — per-run history with status, duration, total cost, and the pinned NeoPi backend identity for runs with agent steps.
- `routine_step_runs` — per-step records inside a V1 run (stdout / stderr excerpts, JSON output, model, tokens, cost, retry attempt).
- `routine_state` — cross-run persistent state per routine, addressable from the templating engine.
- `bridge_state` — supervised bridge process records (currently Telegram).
- `env_settings` — masked secret store backing Settings → Env (atomic writes paired with `env-audit.log`).
- `sequences` — monotonic counters (currently just `tasks`).

On first boot against an empty `tasks` table the deck seeds a single
"Welcome to npi-deck" backlog task — see `apps/server/src/db/index.ts`
`seedWelcomeTaskIfEmpty`.

## Theming

CSS custom properties on `<html data-theme="…">`. Tailwind reads each
color token through `rgb(var(--token) / <alpha-value>)`. An inline script
in `apps/web/index.html`'s `<head>` applies the saved theme **before**
React mounts to avoid flash-of-default. Full reference in
[docs/themes.md](./themes.md).

## Stores

The web frontend uses Zustand (`apps/web/src/lib/store.ts`) as the single
source of truth for sessions, WS connection, workspace metadata, and the
`tasksChangeCounter` that drives live kanban refreshes.

The TasksView, RoutinesView, and InboxView own their own local fetches and
caches — they subscribe to relevant change counters or refetch on mount.
Chat is fully store-driven because it needs cross-session state.

## Build outputs

- `apps/web/dist/` — production static bundle. Served by the deck server
  when `NPI_DECK_WEB_DIST` resolves to it (auto-detected).
- `apps/server/dist/` — bundled server (`bun build --target=bun`). Dev
  mode (`bun run dev` with `bun --hot`) is the supported workflow during
  iteration; production deployments run the bundle via `bun start`.

## Where omp lives

The SDK package is `@oh-my-pi/pi-coding-agent`, pinned in
`apps/server/package.json`. The deck reads from:

- NeoPi's agent dir (`getAgentDir()`, default `~/.omp/agent/`; `PI_CODING_AGENT_DIR` overrides) — sessions JSONL, auth.db,
  marketplaces.json, installed_plugins.json.
- The SDK's in-process `ModelRegistry`, `SessionManager`, `Settings`,
  `MarketplaceManager`, `BUILTIN_SLASH_COMMANDS_INTERNAL`,
  `ACP_BUILTIN_SLASH_COMMANDS`, and friends.

The deck never re-derives state the SDK already knows about — it calls
through.
