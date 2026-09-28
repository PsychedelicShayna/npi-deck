# Installing omp-deck

omp-deck is the cockpit UI for [`oh-my-pi`](https://github.com/can1357/oh-my-pi)
(`omp`).

The deck runs from a git checkout. There is no npm package, Docker image, or
Windows launcher; an `npi-deck` launcher is planned but not available yet.

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts   # prepare the pinned NeoPi tree (see below)
bun run dev                  # server on :8787, Vite app on :5173
```

`bun run start` serves the built web app from the server on :8787 instead;
run `bun run build` first. Two flavors depending on whether you already use
omp on this machine:

- [Path A — You already have omp installed and authenticated](#path-a--existing-omp-user)
- [Path B — Fresh install (no omp yet)](#path-b--fresh-install)
- [Verifying the install](#verifying-the-install)
- [Where state lives](#where-state-lives)
- [Uninstall / clean slate](#uninstall--clean-slate)

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3.14 | Runtime for both the deck server and the web bundler. |
| Git | any recent | To clone the repo. |
| A modern browser | Chrome / Edge / Firefox / Safari, recent | Renders the deck. WebSocket support is required. |

You do **not** need Node.js — Bun runs everything.

## NeoPi backend tree

The deck no longer installs `@oh-my-pi/*` from npm. It loads NeoPi from a
source tree pinned in `neopi.pin`. Prepare that tree once per pin:

```bash
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts            # the pinned commit
bun scripts/neopi-setup.ts <sha>      # another commit
bun scripts/neopi-setup.ts --path DIR # an existing NeoPi tree, prepared in place
```

The script:

1. Adds a detached worktree at `~/.npi-deck/neopi/<sha>` from the NeoPi
   checkout (`--source`, or `NPI_DECK_NEOPI_SOURCE`).
2. Runs `bun install --frozen-lockfile --ignore-scripts` and `gen:tool-views`
   inside it.
3. Links in a prebuilt `pi_natives` addon whose version sentinel matches the
   tree's `packages/natives` version. It searches `--native-dir` (repeatable)
   or `NPI_DECK_NATIVE_DIRS` (`:`-separated). `--copy` copies the file
   instead of symlinking it. If no addon matches, it prints the
   `build:native` command and exits. `--build-native` runs that build.
4. Registers the tree under `backends` in `~/.npi-deck/config.yml`, and sets
   `activeBackend` if it isn't set yet.
5. For the pinned commit (or with `--tsconfig`), writes the gitignored
   `tsconfig.neopi.json`. `apps/server` extends it, so typechecking the server
   needs this step first.

`NPI_DECK_HOME` overrides `~/.npi-deck`. Re-running the script is safe.

---

## Path A — Existing omp user

If `omp` already works in a terminal on this machine, your `~/.omp/agent`
directory is already authenticated and populated with sessions. The deck will
pick it up automatically — no re-auth needed.

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts
bun run dev
```

Open <http://127.0.0.1:5173>. Your existing sessions appear in the sidebar.
Pick a workspace, create a session, send a prompt.

That's it.

### Optional: custom data dir

The deck writes its own SQLite database, env file, and bridge state under
`%LOCALAPPDATA%/omp-deck` (Windows) or `$XDG_CONFIG_HOME/omp-deck` (Linux /
macOS). To override, set `OMP_DECK_DATA_DIR` before `bun run dev`.

---

## Path B — Fresh install

You don't have omp on this machine. We'll install the agent globally, then
clone and run the deck.

### 1. Install Bun

Follow <https://bun.sh>. The one-liner is:

```sh
curl -fsSL https://bun.sh/install | bash      # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"  # Windows
```

Confirm with `bun --version`.

### 2. Install the omp CLI

```sh
bun add -g @oh-my-pi/pi-coding-agent
```

This installs the `omp` binary. omp-deck embeds the SDK in-process, so the
global CLI is optional for running the deck — but installing it gives you the
terminal experience too, and the auth flow is friendlier from a TTY.

### 3. Authenticate

Run `omp` once in any terminal. The first launch prompts you to pick a
provider:

- **Subscription / OAuth** (Claude / GPT) — opens a browser tab.
- **API key** — paste it directly.

The credentials are written to `~/.omp/agent/auth.db`. The deck reads from the
same file.

If you'd rather skip the CLI and configure keys via the deck itself, you can
proceed to step 4 — then go to Settings → Env in the deck UI and paste your
provider API key(s) there. The deck will write them to its managed `.env`.

### 4. Clone and run the deck

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts
bun run dev
```

Open <http://127.0.0.1:5173>.

You'll see a single "Welcome to omp-deck" task in the kanban. Read it; it
covers the next 10 minutes of orientation.

---

## Verifying the install

A quick smoke list after either path:

1. **Health endpoint**: `curl http://127.0.0.1:8787/api/health` returns `{"ok":true,...}`.
2. **Web bundle**: opening <http://127.0.0.1:5173> shows the chat view (or
   the kanban — there's no auth, so any route works).
3. **First session**: click "+ new session" in the sidebar, send any prompt.
   You should see streaming text within a couple of seconds.
4. **Settings**: navigate to `/settings`. The Env section lists
   `OMP_DECK_HOST`, `OMP_DECK_PORT`, `OMP_MODEL`, provider keys (masked), etc.

If any of those fail, see [troubleshooting](#troubleshooting) below.

---

## Where state lives

- **omp session/auth data**: `~/.omp/agent/` (override via `OMP_AGENT_DIR`).
- **Deck kanban + routines + inbox**: `apps/server/data/deck.db` by default;
  override via `OMP_DECK_DB_PATH`.
- **Deck-managed env file + audit log**: `<dataDir>/.env` and
  `<dataDir>/env-audit.log` — see [configuration.md](./configuration.md)
  for `dataDir` resolution rules.
- **Telegram bridge mapping DB**: `<dataDir>/telegram-bridge.db` (only created
  when the bridge runs).
- **Marketplace state**: `~/.omp/plugins/installed_plugins.json` and
  `~/.omp/plugins/marketplaces.json` (managed by the SDK).

---

## Uninstall / clean slate

To wipe deck state while preserving omp's own data:

```sh
# Stop the deck (Ctrl+C in its terminal)
rm -rf apps/server/data/                    # kanban + routines + inbox
rm -rf ~/.config/omp-deck/                  # Linux/macOS dataDir
rmdir /S /Q %LOCALAPPDATA%\omp-deck         # Windows dataDir
```

To also drop omp:

```sh
bun pm ls -g | grep oh-my-pi
bun remove -g @oh-my-pi/pi-coding-agent
rm -rf ~/.omp/                              # sessions + auth
```

---

## Troubleshooting

**`bun install` fails on a network error.** Bun caches packages globally;
retry usually succeeds. If you're behind a corporate proxy, set
`BUN_INSTALL_CACHE_DIR` and `HTTPS_PROXY`.

**Port 8787 is already in use.** Set `OMP_DECK_PORT=8788` (or any free port)
before `bun run dev`. The vite proxy auto-follows.

**No models appear in the model picker.** Open Settings → Env and confirm
at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. is set. If you
authenticated via `omp` CLI, the provider entries surface via the SDK's auth
store rather than env vars — switching to the deck-managed env doesn't break
that.

**Marketplace is empty.** Click "Add" on the suggested
`anthropics/claude-plugins-official` card. The deck shells out to git under
the hood, so git must be installed.

**The kanban is empty and there's no welcome task.** That means `tasks` had
rows once — the welcome seed only fires against a truly empty table. Run
`/task add <title>` in chat, or click + on the Backlog column.
