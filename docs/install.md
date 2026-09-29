# Installing npi-deck

npi-deck is the web cockpit for NeoPi, a fork of
[`oh-my-pi`](https://github.com/can1357/oh-my-pi) (`omp`).

There is one supported way to install and run it: a git checkout of the deck,
a NeoPi source tree prepared by `scripts/neopi-setup.ts` and registered in
`~/.npi-deck/config.yml`, and the `npi-deck` launcher. There is no npm
package, Docker image, or Windows launcher, and the deck does not check for or
install updates.

```sh
git clone https://github.com/PsychedelicShayna/npi-deck.git
cd npi-deck
bun install --frozen-lockfile --ignore-scripts
# prepare the pinned NeoPi tree and register it in ~/.npi-deck/config.yml
bun scripts/neopi-setup.ts --source /path/to/neopi --native-dir /path/to/prebuilt-natives
#   no prebuilt addon? replace --native-dir … with --build-native (cold Rust build)
mkdir -p ~/.local/bin
ln -s "$PWD/bin/npi-deck" ~/.local/bin/npi-deck   # once
npi-deck                                          # http://127.0.0.1:1701
```

Without flags, `neopi-setup` falls back to the maintainer's layout:
`--source` defaults to `~/source/github/PsychedelicShayna/neopi` (env
`NPI_DECK_NEOPI_SOURCE`) and `--native-dir` to
`~/source/github/PsychedelicShayna/neopi-sync-v18.3.2` (env
`NPI_DECK_NATIVE_DIRS`, `:`-separated). Pass both unless your checkouts live
there. `--native-dir` is searched only when the tree has no matching addon
yet, both directly and under `packages/natives/native`, so a NeoPi checkout
that has run `build:native` works as the directory.

Every later `neopi-setup` run (a pin change, an upgrade, a rollback) needs the
same two locations. Export them once, for example in your shell profile, and
the flags can be left off from then on:

```sh
export NPI_DECK_NEOPI_SOURCE=/path/to/neopi
export NPI_DECK_NATIVE_DIRS=/path/to/prebuilt-natives   # `:`-separated for several
```

An explicit `--source` or `--native-dir` still wins over the variable.

- [Prerequisites](#prerequisites)
- [NeoPi backend tree](#neopi-backend-tree)
- [config.yml](#configyml)
- [The npi-deck launcher](#the-npi-deck-launcher)
- [Sign in to a provider](#sign-in-to-a-provider)
- [Verifying the install](#verifying-the-install)
- [Where state lives](#where-state-lives)
- [Development servers](#development-servers)
- [Uninstall / clean slate](#uninstall--clean-slate)
- [Troubleshooting](#troubleshooting)

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3.14 | Runs the deck, the launcher, `neopi-setup` and the web build. |
| Git | any recent | Clones the deck and adds the NeoPi worktree. |
| A NeoPi checkout | contains the commit in `neopi.pin` | `neopi-setup` adds its backend tree from it (`--source`). |
| A prebuilt `pi_natives` addon | built from the same native sources as the tree | `neopi-setup` links it into the tree (`--native-dir`). Without one, `--build-native` builds it, which needs the tree's Rust toolchain. |
| A systemd user manager | — | The launcher runs the server as a user service. Without one, pass `--no-systemd`; `setpriv` (util-linux) is then used when present. |
| A modern browser | recent Chrome / Edge / Firefox / Safari | Renders the deck. WebSocket support is required. |

You do **not** need Node.js — Bun runs everything.

## NeoPi backend tree

The deck does not install `@oh-my-pi/*` packages. It loads NeoPi from a
source tree pinned in `neopi.pin`. Prepare that tree once per pin:

```bash
bun install --frozen-lockfile --ignore-scripts
# the pinned commit
bun scripts/neopi-setup.ts --source /path/to/neopi --native-dir /path/to/prebuilt-natives
# another commit
bun scripts/neopi-setup.ts <sha> --source /path/to/neopi --native-dir /path/to/prebuilt-natives
# an existing NeoPi tree, prepared in place (--source is not used)
bun scripts/neopi-setup.ts --path DIR --native-dir /path/to/prebuilt-natives
```

With `NPI_DECK_NEOPI_SOURCE` and `NPI_DECK_NATIVE_DIRS` exported, drop the
flags.

If dependencies are already provisioned in the target tree, pass
`--skip-install` to avoid any package-manager operation. The script checks that
the coding-agent workspace link resolves inside that tree; the caller remains
responsible for matching the tree's lockfile and dependency versions.

The script:

1. Adds a detached worktree at `~/.npi-deck/neopi/<sha>` from the NeoPi
   checkout (`--source`, or `NPI_DECK_NEOPI_SOURCE`).
2. Checks the Bun running the script, and the `bun` on `PATH`, against the
   tree's `engines.bun` (`packages/utils/package.json`, `>=1.3.14` at the pin)
   and stops on an older Bun.
3. Runs `bun install --frozen-lockfile --ignore-scripts` unless
   `--skip-install` was passed, then runs `gen:tool-views` inside the tree.
4. Provides the `pi_natives` addon. The version sentinel is not enough: every
   commit of a release carries the same one. The script fingerprints the
   tree's native inputs (`packages/natives`, `crates`, `Cargo.toml`,
   `Cargo.lock`, `rust-toolchain.toml`, `.cargo`; tracked and untracked
   non-ignored files, as they are on disk) and reuses an addon only when it
   was built from the same fingerprint, for this platform and CPU variant.
   Evidence for a candidate is, in order: this tree's record for those exact
   bytes, the record in the checkout holding the file, or that checkout's own
   native inputs (reported as `derived`: the sources match, the build itself
   was not observed). It searches `--native-dir` (repeatable) or
   `NPI_DECK_NATIVE_DIRS` (`:`-separated); `--copy` copies the file instead of
   symlinking it. If nothing matches, including an addon already in the tree
   that was built from other sources, it prints the `build:native` command and
   exits; `--build-native` runs that build. The accepted addon's fingerprint,
   platform, CPU variant and file sha256 are written to
   `<tree>/node_modules/.npi-deck/native-addon.json`.
5. Registers the tree under `backends` in `~/.npi-deck/config.yml`, and sets
   `activeBackend` if it isn't set yet (see [config.yml](#configyml)).
6. For the pinned commit (or with `--tsconfig`), writes the gitignored
   `tsconfig.neopi.json`. `apps/server` extends it, so typechecking the server
   needs this step first.

`NPI_DECK_HOME` overrides `~/.npi-deck`. Re-running the script is safe. To
check a tree against everything the deck uses:

```bash
bun apps/server/src/backend/contract.ts   # isolated; no provider requests
```

## config.yml

`~/.npi-deck/config.yml` lists the prepared backend trees and names the one the
deck loads. `neopi-setup` writes it; you rarely edit it by hand:

```yaml
backends:
  - id: 7290c5ab68       # 10-character short commit; neopi-setup uses it as the id
    kind: source
    path: /home/you/.npi-deck/neopi/7290c5ab683243072805db0aa6bdbdbb4988a887
activeBackend: 7290c5ab68
```

- `kind: source` is the only kind the deck loads; `kind: gateway` is reserved
  and cannot be selected.
- `activeBackend` is set by the first `neopi-setup` run and changed by
  **Settings → Backend**. A later `neopi-setup` run registers its tree without
  switching to it.
- `NPI_DECK_BACKEND` (a backend id from `config.yml`, or an absolute tree
  path) overrides `activeBackend` for the whole launch, including the source
  shown in Settings; remove it and restart the launcher to switch from the UI.

The server imports NeoPi from the selected tree at startup. If no backend is
configured, the deck still starts: kanban, inbox, routine editing and settings
remain available. Agent-backed endpoints return HTTP 503 with
`backend_unavailable`. Open **Settings → Backend** to choose a prepared source
tree. The picker runs an isolated preflight (Bun engine, dependencies, native
addon version sentinel and recorded fingerprint, required SDK exports) before
switching. It reports the tree's commit, version and whether it matches
`neopi.pin`. A tree prepared before the fingerprint record existed, or whose
native sources changed since, fails preflight until `neopi-setup` is re-run
for it.

A normal switch refuses while work is active, listing live sessions and
prompts without changing the running backend. **Force —
abort all work** stops them before restarting the worker through the launcher.
The worker rolls back to the previous backend if the candidate cannot start;
if the previous backend also fails, it starts without a backend. Browser tabs
reconnect to the new worker generation without replaying prompts queued while
offline. Existing transcripts remain available for explicit resume. The
backend picker requires the `npi-deck` launcher, not a directly started
server process.

## The npi-deck launcher

`bin/npi-deck` is how the deck runs. Link it into your `PATH` once; the link
resolves back to the checkout, so it works from any cwd:

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
  `NPI_DECK_LAUNCHER_PID`) and shuts down. A hung shutdown is forced after
  three seconds so systemd can empty the unit's cgroup within five seconds.
- Settings → Restart makes the server exit with the reserved status 75;
  systemd restarts it on exactly that status (`RestartForceExitStatus`) and
  clears the cgroup between generations. Force-switching a backend uses the
  same restart status. Both restarts force worker exit after three seconds if
  active work blocks teardown; systemd then kills remaining processes in the
  old cgroup. It gives up after 5 starts in 60 s. A server started with
  `bun run dev` or `bun run start` has no supervisor, so its restart button
  reports that instead.

Without a systemd user manager the launcher refuses to start unless given
`--no-systemd`. Then the server is a direct child, run under
`setpriv --pdeathsig KILL` in its own process group, so it dies with the
launcher. When the server exits, the launcher kills its process group and
every process that still carries its generation marker (`NPI_DECK_GEN`).
Descendants of a server whose launcher was also killed are cleaned up at the
next start.

Server child processes carry a per-spawn group marker. Group cleanup checks
the original leader or a marked descendant before signaling its process group,
so a recycled group ID cannot target an unrelated process. Blocking git and
preflight probes use the same parent-death protection. The generation sweep
remains the fallback for descendants that leave their original group.

Status and logs: `systemctl --user status npi-deck`,
`journalctl --user -u npi-deck`, `systemd-cgls --user-unit npi-deck.service`.

At launch the deck copies any missing starter skills and extensions into the
NeoPi agent dir. **Settings → Starters** (or `NPI_DECK_INSTALL_STARTER_SKILLS`
/ `NPI_DECK_INSTALL_STARTER_EXTENSIONS` set to `0`) turns that off.

## Sign in to a provider

NeoPi keeps sessions and credentials in `~/.omp/agent/`. If you already use
`omp` or NeoPi in a terminal on this machine, the deck picks that directory up
and needs no new sign-in; your existing sessions appear in the sidebar.

Otherwise, sign in from the deck:

- **Subscription / OAuth** (Claude Pro / Max, ChatGPT Plus / Pro, …) —
  Settings → Providers → *Sign in*. The token is written to
  `~/.omp/agent/auth.db`.
- **API key** (Anthropic / OpenAI / OpenRouter / Google / …) — Settings → Env,
  paste the key. It is saved to the deck's managed `.env`.

On a fresh machine you'll see a single "Welcome to NPI deck" task in the
kanban. Read it for a quick tour of the deck.

## Verifying the install

A quick smoke list:

1. **Health endpoint**: `curl http://127.0.0.1:1701/api/health` returns `{"ok":true,...}`.
2. **Web bundle**: opening <http://127.0.0.1:1701> shows the chat view (or
   the kanban — there's no auth, so any route works).
3. **Backend**: Settings → Backend shows the tree from `config.yml` as active,
   matching `neopi.pin`.
4. **First session**: click "+ new session" in the sidebar, send any prompt.
   You should see streaming text within a couple of seconds.
5. **Settings**: navigate to `/settings`. The Env section lists
   `NPI_DECK_HOST`, `NPI_DECK_PORT`, `OMP_MODEL`, provider keys (masked), etc.

If any of those fail, see [troubleshooting](#troubleshooting) below.

## Where state lives

Deck state lives in `~/.npi-deck` (`NPI_DECK_HOME` overrides; it is read from
the environment that starts the deck, not from the managed `.env` inside it):

- **Backend trees and selection**: `neopi/<sha>/` and `config.yml`.
- **Kanban, routines, inbox**: `deck.db` (`NPI_DECK_DB_PATH` overrides), with
  pasted images under `uploads/`.
- **Managed env file and audit log**: `.env` and `env-audit.log`.
- **Telegram bridge mapping DB**: `telegram-bridge.db` (only created when the
  bridge runs).
- **Run state**: `run/` (launcher lock, generation and owned-process
  journals).

Nothing is read from the old `~/.omp-deck` or `~/.config/omp-deck` dirs; to
bring their state over, run `bun scripts/migrate-omp-deck.ts` (see
[upgrading.md](./upgrading.md#070-dev--from-omp-deck-to-npi-deck)).

Elsewhere:

- **NeoPi session/auth data**: `~/.omp/agent/` (NeoPi's `getAgentDir()`; `PI_CODING_AGENT_DIR` overrides).
- **Marketplace state**: `~/.omp/plugins/installed_plugins.json` and
  `~/.omp/plugins/marketplaces.json` (managed by the SDK).

## Development servers

`bun run dev` runs the server on :1701 with `bun --hot` and the Vite app with
hot reload on :5173 (open the latter). It is for working on the deck, not for
running it: nothing supervises that server, so Settings → Restart and the
backend picker's switch do not work, and processes it spawns are not confined
to a cgroup. It loads the same `config.yml` backend. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for running a dev deck beside your
everyday one.

## Uninstall / clean slate

To wipe deck state while preserving NeoPi's own data:

```sh
# Stop the deck first (Ctrl-C in the launcher's terminal)
rm ~/.local/bin/npi-deck                    # the launcher link
rm -rf ~/.npi-deck/                         # all deck state, including backend trees
git -C /path/to/neopi worktree prune        # forget the removed backend worktrees
```

`rm -rf ~/.omp/` additionally drops every NeoPi session and credential, for
the deck and any NeoPi CLI on the machine alike.

## Troubleshooting

**`bun install` fails on a network error.** Bun caches packages globally;
retry usually succeeds. If you're behind a corporate proxy, set
`BUN_INSTALL_CACHE_DIR` and `HTTPS_PROXY`.

**`neopi-setup` says the commit is not in the source.** Fetch the NeoPi
checkout, or point `--source` / `NPI_DECK_NEOPI_SOURCE` at one that has the
commit in `neopi.pin`.

**Port 1701 is already in use.** Pass `npi-deck --port 1702` (or any free
port).

**`no systemd user manager is reachable`.** The launcher found no systemd
user manager to run the service under. `npi-deck --no-systemd` runs the
server as a direct child instead, without cgroup containment.

**No models appear in the model picker.** Open Settings → Env and confirm
at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. is set. If you
signed in through OAuth, the provider entries surface via the SDK's auth
store rather than env vars — switching to the deck-managed env doesn't break
that.

**Marketplace is empty.** Click "Add" on the suggested
`anthropics/claude-plugins-official` card. The deck shells out to git under
the hood, so git must be installed.

**The kanban is empty and there's no welcome task.** That means `tasks` had
rows once — the welcome seed only fires against a truly empty table. Run
`/task add <title>` in chat, or click + on the Backlog column.
