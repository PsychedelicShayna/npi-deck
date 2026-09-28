# Upgrading omp-deck

How to update your install, what changed, what might break, and how to roll back if you need to. Most upgrades are non-breaking — read this only when something behaves differently than you expected, or before jumping more than one minor version.

- [The general upgrade procedure](#the-general-upgrade-procedure)
- [Per-version notes](#per-version-notes)
  - [0.6.0 — first-run onboarding, provider clarity, reliability fixes](#060--first-run-onboarding-provider-clarity-reliability-fixes)
  - [0.5.0 — cross-platform CI, Linux container, Mac/Linux launcher](#050--cross-platform-ci-linux-container-maclinux-launcher)
- [Rolling back](#rolling-back)
- [Reporting upgrade issues](#reporting-upgrade-issues)

---

## The general upgrade procedure

omp-deck never auto-updates, never migrates your data without your explicit say-so, and never replaces user-edited files. Upgrades are an explicit `git pull` you run in your checkout, followed by a deck restart. There is no npm package or Docker image; an `npi-deck` launcher is planned.

```sh
cd /path/to/your/npi-deck/checkout
git pull
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts   # prepares the NeoPi tree if neopi.pin moved
# stop the running deck, then:
bun run dev
```

The `bun install` step is important after pulling — workspace lockfile changes won't apply without it. Re-running `scripts/neopi-setup.ts` is safe. If you're skipping a major version, also run a `bun run --filter '@omp-deck/*' typecheck` once to catch any local divergence before booting.

The deck:

- Re-uses your existing `~/.omp-deck/` data dir (deck.db, managed `.env`, uploads, onboarding flag).
- Re-uses your existing `~/.omp/agent/` (auth credentials, sessions, skills, extensions).
- Applies any new SQLite migrations on first boot — idempotent, additive only (we never drop columns).
- Picks up any new starter skills / extensions only if the user hasn't already created a file by the same name (we don't overwrite).

To check what version you have running:

```sh
git -C /path/to/your/npi-deck/checkout rev-parse --short HEAD
# or hit the local health endpoint (reports version + buildSha):
curl http://127.0.0.1:8787/api/health
```

---

## Per-version notes

### 0.6.0 — first-run onboarding, provider clarity, reliability fixes

Released 2026-05-29. See [CHANGELOG.md](../CHANGELOG.md#060--2026-05-29--first-run-onboarding--provider-clarity--reliability-fixes) for the full list.

**TL;DR:** non-breaking for everyone who already has a working install.

#### What you might notice on first boot

- **Existing users see no behavior change at startup.** The new onboarding wizard auto-detects "this is a returning user" by checking for an existing session OR a welcome task that's been moved out of backlog. If either is true, it silently writes a completion flag at `<dataDir>/onboarding.json` so the wizard never triggers. Your first boot of v0.6.0 will write this flag — that's the entire migration.
- **Model picker has a new `subscription` badge** on Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Cursor, Perplexity Pro/Max, and recognized coding-plan providers. Visual change only; no behavior change.
- **Placeholder API keys now hide their providers from the picker.** If you have an obvious placeholder in your env (e.g. `OPENAI_API_KEY=sk-your-XXXXhere` from a tutorial), models from that provider stop appearing in the default picker view (toggle "show unauth" to see them with a `no auth` badge). This is a fix for a confusing failure mode where clicking the model sent the placeholder to the provider's API and got back a 401. **Action:** if a model disappeared and you didn't expect it, your env value matches one of these placeholder patterns; replace with a real key.
- **OAuth flows now time out at 5 minutes** server-side. Previously a stuck flow (e.g. Ollama waiting on endpoint input from a closed modal) could block subsequent OAuth attempts forever with "already in progress." Now it auto-cleans.
- **`process.execPath` fallback** on child-process spawn. Only matters if you've reinstalled Bun via a different installer between deck boots — the deck now falls back to a fresh `Bun.which("bun")` lookup instead of `ENOENT`-ing.

#### What needs your attention

Nothing required. But if you want to:

- **Try the new onboarding wizard yourself** (after settling silently), navigate manually to `http://127.0.0.1:8787/onboarding`. The "Skip setup" link in the top right exits without changes.
- **Get the wizard back for a real first-run test**, delete `<dataDir>/onboarding.json` (default location: `~/.omp-deck/onboarding.json` on macOS/Linux, `%LOCALAPPDATA%\omp-deck\onboarding.json` on Windows) AND make sure your seed welcome task (T-1) is still in backlog AND you have zero persisted sessions. Then refresh.

#### What did NOT change

- Your SQLite schema, env file, auth credentials, kb root, routine config, inbox, sessions — all untouched.
- The `omp` CLI's behavior. The deck embeds the SDK in-process; the CLI is independent.
- Existing URLs, slash commands, settings keys, env vars.

---

### 0.5.0 — cross-platform CI, Linux container, Mac/Linux launcher

Released 2026-05-28. Two Linux bugs were fixed that affected anyone running on Linux (especially via Docker) prior to this release. Nothing else user-facing changed.

If you were running the deck via the pre-0.5.0 Docker image, **rebuild your image** — `oven/bun:1.3.14-alpine` was switched to `oven/bun:1.3.14` (Debian-slim, glibc) because the SDK's prebuilt `.node` binaries are glibc-linked and fail to load under musl. Your data dir is preserved; only the image needs rebuilding.

---

## Rolling back

If a new version breaks something for you, downgrade to the previous one and file an issue.

```sh
git checkout <previous-commit-or-tag>
bun install --frozen-lockfile --ignore-scripts
bun scripts/neopi-setup.ts
```

**SQLite migrations are forward-only.** Rolling back the package doesn't roll back the schema. In practice this hasn't caused user-visible problems because every migration we ship is additive (adding columns or tables, never removing or renaming), so an older deck just ignores the newer fields. If you're worried, snapshot `<dataDir>/deck.db` before upgrading.

For the onboarding flag specifically (introduced in 0.6.0): an older deck will ignore the flag file entirely. Safe to leave in place if you roll back.

---

## Reporting upgrade issues

If an upgrade broke something for you:

1. Roll back to the previous version (see above) so you're unblocked.
2. File an issue at <https://github.com/bjb2/omp-deck/issues> with:
   - the version you came from + version you went to
   - your OS + Bun version (`bun --version`)
   - the relevant log excerpt (`<dataDir>/server.log` if you have one, or the terminal where the deck is running)
   - what you expected vs what you saw

Small repro cases get fixed fastest.
