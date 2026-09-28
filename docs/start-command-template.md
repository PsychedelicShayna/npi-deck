# `/start` command template

npi-deck ships with `NPI_DECK_AUTO_START` **disabled by default**. If you want
the agent to greet you with a workspace summary every time you open a fresh
chat, define `/start` as a user-global slash command and turn the env var on.

## Step 1 — Write the command

omp's user-global slash commands live in `~/.omp/agent/commands/`. Create
`start.md` there:

```md
---
description: Summarize the active workspace and surface anything in-flight
---

Summarize the current workspace's state for me. Cover:

- Active kanban tasks (read via `curl http://127.0.0.1:8787/api/tasks`,
  filtering by `stateId === "s_active"` for the current `cwd`). Show their
  T-ids and titles.
- Recent git activity — last 5 commits (`git log -5 --oneline`) and any
  uncommitted changes (`git status --short`).
- Anything else that looks blocked or unfinished — TODO comments added in the
  last 7 days, untracked files in known scratch directories, etc.

Keep it tight. One section per topic. No more than 12 lines total. End with a
single open question or suggested next step.
```

Customize the body to whatever orientation you want. Some patterns I've seen
people use:

- "What did I leave half-finished yesterday?" — `git log --since=24.hours.ago`.
- "What's on my calendar today?" — assumes an external script that writes a
  YAML file the agent can `read`.
- "Compact orientation for a new contributor" — reads README and last 20
  commits.

## Step 2 — Turn on auto-start

In the deck: **Settings → Env → `NPI_DECK_AUTO_START`**, replace with `/start`,
Save. Hot-applied — no restart needed.

Or via env:

```sh
NPI_DECK_AUTO_START=/start bun run dev
```

Or write to the managed `.env`:

```sh
# ~/.config/npi-deck/.env  (Linux/macOS)
# %LOCALAPPDATA%\npi-deck\.env  (Windows)
NPI_DECK_AUTO_START=/start
```

## Step 3 — Verify

Click "+ new session" in the sidebar. The composer fires `/start` after the
WS subscription lands. You'll see a streaming response within a few seconds.

If nothing fires: the `NPI_DECK_AUTO_START` value isn't visible to the deck
process. Check Settings → Env — the "Source" column should read `env-file` or
`process env` (not `unset`).

If you see the literal text `/start` echoed back by the agent: omp didn't
expand the slash command. Confirm `start.md` is in `~/.omp/agent/commands/`
(not a project-local override), and that it has the `description` frontmatter.

## Passing arguments

Auto-start can pass arguments to the slash command:

```sh
NPI_DECK_AUTO_START="/start --focus 'continue last work'"
```

Inside `start.md`, `$ARGUMENTS` expands to whatever follows the command name.
Add `{{ARGUMENTS}}` (or template syntax of your choice) to the body to use it.
See the omp SDK's slash-command docs for the full templating reference.

## Disabling auto-start

Set the env var to empty, `0`, or `false`. All three disable it.

```sh
NPI_DECK_AUTO_START= bun run dev
```

The Settings UI shows the value as `unset` when empty.
