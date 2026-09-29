# Skills

The `/skills` view is the cockpit's inventory of every skill `omp`
discovers — across its native location, the marketplace plugins it has
installed, and every sibling agent-tool config dir it shares with Claude Code,
Codex, OpenCode, and so on — and the place to author your own OMP user
skills. It complements `/marketplace`, which answers "what can I install?"

## How omp loads skills

`omp` is intentionally polyglot. The SDK's capability system enumerates skills
from multiple providers, each scanning its own conventional location:

| Provider          | User location                                     | Project location                              |
|-------------------|---------------------------------------------------|-----------------------------------------------|
| **`native` (OMP)** | `~/.omp/agent/skills/`                            | `<cwd>/.omp/skills/` (walks up to repo root)  |
| `claude-plugins`  | `~/.omp/plugins/cache/plugins/<plugin>/skills/`   | same                                          |
| `claude`          | `~/.claude/skills/`                               | `<cwd>/.claude/skills/`                       |
| `codex`           | `~/.codex/skills/`                                | `<cwd>/.codex/skills/`                        |
| `opencode`        | `~/.config/opencode/skills/`                      | `<cwd>/.opencode/skills/`                     |
| `cursor`, `windsurf`, `cline`, `gemini`, `agents` | each agent tool's conventional dir         | same                                          |

The deck calls `loadCapability(skillCapability.id, { cwd })` once per request;
that returns the union across every provider, each entry tagged with
`_source: { provider, providerName }` plus `level: "user" | "project"`.

**`native` is omp's own.** If you want to author a skill that's "yours" rather
than borrowed from another agent tool, use **New skill** in the Skills view,
or drop a `SKILL.md` under `~/.omp/agent/skills/<name>/` (user) or
`<project>/.omp/skills/<name>/` (project). The cockpit shows it immediately.

## What you see

### Left sidebar

- **Source** — filter by provider. `OMP` (native) is highlighted because
  it's the one you author into. Other providers (Claude Plugins, Claude Code,
  Codex, …) are read-only mirrors of those tools' configs.
- **Level** — `user` vs `project`. Project skills are resolved against the
  active session's `cwd`; user skills come from `~/.<provider>/...`.

### Skill list (middle pane)

One row per skill. Rows are sorted **native first**, then by provider
priority, then by name. Each row shows:

- the skill name (frontmatter `name`, falls back to dir name),
- a provider badge (rust accent for `native`, muted for everything else),
- the level (USER / PROJECT),
- the owning plugin name when this skill came from a marketplace install,
- the description (clamped to two lines).

Use the search box at the top of the main pane to filter by name, description,
triggers, or tags.

### Detail pane

- Header: skill name, provider badge, level. **Edit** and **Delete** appear
  on OMP user skills; every other skill shows `read-only`.
- Sub-line: source — owning plugin id if `claude-plugins`, otherwise
  provider + dir name.
- Description, triggers, tags.
- Rendered `SKILL.md` body (frontmatter stripped), using the chat's Markdown +
  `highlight.js` pipeline.

### Right inspector

Frontmatter as a definition list (name, dir, provider, level, plugin if
present, enabled, model when set, absolute SKILL.md path) followed by the
list of co-located files with sizes. The "Bundled files" header makes the
limit explicit: **co-located files are reachable on demand, not
auto-injected into the agent's context.** SKILL.md's instructions tell the
agent how to reach them with its normal `read` / `bash` tools.

## What actually hits the agent

Out of everything on disk, only two things ever land in the agent's prompt:

1. **At session start**: the skill's `name` + `description` (frontmatter)
   enter the system prompt's `<skills>` listing. That's the agent's
   triggering signal — "this skill exists, and here's roughly what it does."
2. **On invoke** (`/skill:<name>`): omp reads SKILL.md, strips the
   frontmatter, and injects the body as a user message. That's the working
   instructions.

Everything else under the skill directory — `scripts/`, `references/`,
`agents/`, `eval-viewer/`, `assets/`, `LICENSE.txt` — is on-demand. The
agent has to `read` or `bash` it to use it. This is the **progressive
disclosure** model the SKILL.md format is designed around.

## Marketplace skill portability

Skills authored against Claude Code can encode environmental assumptions omp
doesn't satisfy:

- Subprocess calls to `claude -p` (the Claude Code CLI).
- File layout assumptions like `.claude/commands/`.
- `Task(subagent_type="…")`-style named subagent invocation, which expects
  Claude Code's Task tool and a registered subagent of that name.
- Hooks API specifics that differ from omp's hook surface.

omp's marketplace can install Claude-plugin-format skills mechanically, and
their SKILL.md bodies inject into the prompt fine. But anything inside that
SKILL.md telling the agent to invoke a Claude-Code-specific dependency will
fail at runtime if you don't also have Claude Code installed and
authenticated.

The general rule: **marketplace skills are not guaranteed to work in omp.**
If you want a skill that's portable to omp, author against the `native`
location (`~/.omp/agent/skills/`) or fork an upstream one into native first.
Phase 2 of the Skills Cockpit will add a portability probe + row badge that
flags risky installs at a glance.

## Lifecycle

- **Install / uninstall** for marketplace plugins lives on the
  [Marketplace](./marketplaces.md) view. The Skills view creates, edits and
  deletes OMP user skills only (see [Authoring](#authoring-an-omp-user-skill)).
- **Updates**: the Skills view's **Check for updates** fetches every
  marketplace from its source and lists outdated plugins under **Plugin
  updates**, each with its own **Upgrade** button; skills of an outdated
  plugin carry an `update` tag. Nothing upgrades without that click. See
  [Checking for and applying updates](./marketplaces.md#checking-for-and-applying-updates).
- **Enable / disable** is **plugin-level** (or `frontmatter.hide: true` for
  individual skills under any provider). The Skills view shows the
  inherited state and the hidden flag, but doesn't expose a finer toggle —
  the SDK doesn't have one.
- **Live updates**: the deck broadcasts a `skills_changed` WebSocket frame
  whenever any watched root mutates. Watched roots:
  `~/.omp/agent/skills/`, `<defaultCwd>/.omp/skills/`,
  `~/.omp/plugins/cache/plugins/`. A root that doesn't exist yet is watched
  through its nearest existing parent and armed when it appears, so the
  first skill in a fresh agent dir shows up too. Other roots
  (`~/.claude/skills/`, etc.) get refreshed manually on next refetch.
- Before each broadcast the deck drops NeoPi's capability read cache, which
  would otherwise keep listing a SKILL.md's old description after an edit.

## Environment

- `NPI_DECK_WATCH_SKILLS=0` disables the disk watcher (useful on filesystems
  that misbehave under recursive `fs.watch` — some VPNs, network drives,
  OneDrive shadowing). The view still works; it just won't auto-refresh
  when changes happen outside the deck's own REST endpoints.

## REST surface

- `GET /api/skills?cwd=<abs>` → `{ skills: SkillSummary[] }`. `cwd`
  defaults to the deck's `defaultCwd`; pass an active session's cwd to
  resolve project-scoped providers correctly.
- `GET /api/skills/:id?cwd=<abs>` → `SkillSummary` + `body` (SKILL.md,
  frontmatter stripped) + `files` (recursive walk, capped at 500 entries
  and depth 6) + `revision` (hash of the SKILL.md bytes).
- `POST /api/skills` `{ name, description, body }` → `201 SkillSummary`.
  Creates `~/.omp/agent/skills/<name>/SKILL.md`.
- `PUT /api/skills/:id` `{ description, body, revision }` → `SkillSummary`.
  `409` when SKILL.md changed since `revision`.
- `DELETE /api/skills/:id` → `{ ok: true }`. Removes the skill's directory.

`id` is server-issued and opaque to clients (base64url of the absolute
SKILL.md path). Always pass back the value returned in the list. Every
`SkillSummary` carries `editable`; `PUT` and `DELETE` answer `403` for any
skill that isn't an OMP user skill.

## Authoring an OMP user skill

**New skill** in the Skills header opens a form with a name, a description
and the SKILL.md body. The deck writes:

```yaml
---
name: my-skill
description: One line, used both for /skill:my-skill matching and for the
  <skills> listing the agent sees at session start.
---
```

followed by the body, to `~/.omp/agent/skills/<name>/SKILL.md` (the agent dir
NeoPi resolves). **Edit** replaces the description and body of an existing
OMP user skill and keeps every other frontmatter key and its comments. The
name is fixed once the skill exists. **Delete** removes the skill's
directory.

Rules the deck enforces:

- The name must pass NeoPi's Agent Skills validator: lowercase letters,
  digits and single hyphens, at most 64 characters. That rules out `/`,
  `..` and dot names, so a name can't leave the skills root.
- The description is required and at most 1024 characters (same validator).
- A name is refused when anything already occupies its directory (including
  a dangling symlink) or another OMP skill, user or project, already uses it.
- `~/.omp/agent/skills/` must resolve inside the agent dir, and each skill
  directory must resolve to a direct child of it. A skill symlinked in from
  elsewhere, or whose SKILL.md is a symlink, is listed `read-only`.
- Every write is read back through NeoPi's frontmatter parser before it
  counts; an edit is refused when SKILL.md changed since the editor loaded it.
- Project skills (`<project>/.omp/skills/`), marketplace plugins and other
  providers' skills stay read-only.

The deck lists the new skill at once. A deck-native eval loop targeting
native-provider skills is still Phase 3 of the
[Skills Cockpit proposal](./proposals/skills-cockpit.md).
