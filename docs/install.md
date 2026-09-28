# Installing npi-deck

npi-deck is the cockpit UI for [`oh-my-pi`](https://github.com/can1357/oh-my-pi)
(`omp`).

The deck runs from a git checkout. There is no npm package, Docker image, or
Windows launcher.

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts                        # prepare the pinned NeoPi tree (see below)
ln -s "$PWD/bin/npi-deck" ~/.local/bin/npi-deck   # once
npi-deck                                          # http://127.0.0.1:1701
```

For development, `bun run dev` runs the server on :1701 and the Vite app with
hot reload on :5173 (open the latter). Two flavors depending on whether you
already use omp on this machine:

- [Path A — You already have omp installed and authenticated](#path-a--existing-omp-user)
- [Path B — Fresh install (no omp yet)](#path-b--fresh-install)
- [The npi-deck launcher](#the-npi-deck-launcher)
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

The server imports NeoPi from the selected tree at startup; `NPI_DECK_BACKEND`
(a backend id from `config.yml`, or an absolute tree path) overrides
`activeBackend`. To check a tree against everything the deck uses:

```bash
bun apps/server/src/backend/contract.ts   # isolated; no provider requests
```

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

The deck keeps its SQLite database, managed env file, uploads, bridge state,
backend trees and run state in one directory, `~/.npi-deck`. To use another
one, set `NPI_DECK_HOME` in the environment that starts the deck. It is not
read from the managed `.env`, which lives inside it.

Nothing is read from the old `~/.omp-deck` or `~/.config/omp-deck` dirs.

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

This installs the `omp` binary. npi-deck embeds the SDK in-process, so the
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

You'll see a single "Welcome to npi-deck" task in the kanban. Read it for a
quick tour of the deck.

---

## The npi-deck launcher

`bin/npi-deck` is the everyday way to run the deck. Link it into your `PATH`
once; the link resolves back to the checkout, so it works from any cwd:

```sh
ln -s "$PWD/bin/npi-deck" ~/.local/bin/npi-deck
npi-deck [--port N] [--host H] [--unit NAME] [--rebuild] [--no-systemd]
```

What it does:

- Builds the web bundle (`apps/web/dist`) when it is missing or older than
  its sources (`--rebuild` forces it), and serves it from the server.
- Refuses to start a second instance. The lock is `~/.npi-deck/run/launcher.lock`
  (a lock left by a dead launcher is taken over), and a unit that is already
  active is refused too.
- Runs the server as the transient systemd user service `npi-deck.service` in
  `neopi-deck.slice` (under `neopi.slice`), with `KillMode=control-group`.
  When the server exits for any reason, `kill -9` and OOM included, systemd
  kills everything left in the unit's cgroup: MCP servers, shells, routine
  steps, setsid'd daemons. The launcher follows the unit's journal in the
  foreground.
- Ctrl-C (or SIGTERM/SIGHUP) on the launcher stops the unit. If the launcher
  itself is killed, the server notices within a second (it watches
  `NPI_DECK_LAUNCHER_PID`) and shuts down, which empties the cgroup.
- Settings → Restart makes the server exit with the reserved status 75;
  systemd restarts it on exactly that status (`RestartForceExitStatus`) and
  clears the cgroup between generations. It gives up after 5 starts in 60 s.
  A server started with `bun run dev` or `bun run start` has no supervisor,
  so its restart button reports that instead.

Without a systemd user manager the launcher refuses to start unless given
`--no-systemd`. Then the server is a direct child, run under
`setpriv --pdeathsig KILL` in its own process group, so it dies with the
launcher. When the server exits, the launcher kills its process group and
every process that still carries its generation marker (`NPI_DECK_GEN`).
Descendants of a server whose launcher was also killed are cleaned up at the
next start.

Status and logs: `systemctl --user status npi-deck`,
`journalctl --user -u npi-deck`, `systemd-cgls --user-unit npi-deck.service`.

## Verifying the install

A quick smoke list after either path:

1. **Health endpoint**: `curl http://127.0.0.1:1701/api/health` returns `{"ok":true,...}`.
2. **Web bundle**: opening <http://127.0.0.1:5173> shows the chat view (or
   the kanban — there's no auth, so any route works).
3. **First session**: click "+ new session" in the sidebar, send any prompt.
   You should see streaming text within a couple of seconds.
4. **Settings**: navigate to `/settings`. The Env section lists
   `NPI_DECK_HOST`, `NPI_DECK_PORT`, `OMP_MODEL`, provider keys (masked), etc.

If any of those fail, see [troubleshooting](#troubleshooting) below.

---

## Where state lives

Deck state lives in `~/.npi-deck` (`NPI_DECK_HOME` overrides):

- **Kanban, routines, inbox**: `deck.db` (`NPI_DECK_DB_PATH` overrides), with
  pasted images under `uploads/`.
- **Managed env file and audit log**: `.env` and `env-audit.log`.
- **Telegram bridge mapping DB**: `telegram-bridge.db` (only created when the
  bridge runs).
- **Backend trees and selection**: `neopi/<sha>/` and `config.yml`.
- **Run state**: `run/` (launcher lock, generation and owned-process
  journals).

Elsewhere:

- **omp session/auth data**: `~/.omp/agent/` (NeoPi's `getAgentDir()`; `PI_CODING_AGENT_DIR` overrides).
- **Marketplace state**: `~/.omp/plugins/installed_plugins.json` and
  `~/.omp/plugins/marketplaces.json` (managed by the SDK).

---

## Uninstall / clean slate

To wipe deck state while preserving omp's own data:

```sh
# Stop the deck first (Ctrl+C in the launcher's terminal)
rm -rf ~/.npi-deck/                         # all deck state, including backend trees
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

**Port 1701 is already in use.** Pass `npi-deck --port 1702` (or any free
port), or set `NPI_DECK_PORT` before `bun run dev`; the Vite proxy follows it.

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
