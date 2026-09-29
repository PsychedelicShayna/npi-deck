# Marketplaces

The Marketplace nav entry lets you browse and install **plugins** — bundles
of slash commands, agents, hooks, MCP servers, and/or LSP servers that the
omp SDK can load at runtime. Catalogs are git/HTTPS-fetched and use the
[Claude Code-compatible](https://docs.anthropic.com/en/docs/claude-code/marketplace)
manifest format.

## The model

- **Marketplaces** are catalogs you've registered. Each has a name, a source
  (GitHub repo / git URL / HTTPS URL / local path), and a cached catalog
  JSON the deck refreshes on demand.
- **Plugins** are catalog entries. Each has a name, a source, and a manifest
  declaring which capabilities it provides.
- **Installed plugins** live under `~/.omp/plugins/cache/plugins/<id>/`. The
  SDK loads them at session create time.

Registry files live at:

- `~/.omp/plugins/marketplaces.json` — registered catalogs.
- `~/.omp/plugins/installed_plugins.json` — installed plugins. **Claude Code-
  compatible format** — version `2`, `plugins: Record<id, InstalledEntry[]>`.

The deck does not write these files directly. It calls into the SDK's
`MarketplaceManager`, which owns serialization.

## Empty state

A fresh deck has no marketplaces registered. The `/marketplace` view shows an
empty-state card with one suggested catalog:

> **Anthropic official** — `anthropics/claude-plugins-official`
> Anthropic's first-party catalog. Curated plugins, commands, and skills —
> the SDK's recommended starter.

Click **Add** on that card and the deck registers the catalog. Within a
second or two, the catalog populates with ~200 plugins.

## Adding your own marketplace

Click the `+` next to "Sources" in the sidebar (or trigger from the empty
state). The modal accepts four shapes:

| Source format | Example | Notes |
|---|---|---|
| GitHub `owner/repo` | `anthropics/claude-plugins-official` | The SDK resolves to `https://github.com/<owner>/<repo>.git`. |
| Full git URL | `https://github.com/foo/bar.git` | HTTPS preferred. |
| HTTPS URL to a catalog JSON | `https://example.com/catalog.json` | Direct fetch — no git clone. |
| Absolute local path | `/home/you/catalogs/private/` | For your own private catalogs. |

The catalog must contain a `marketplace.json` (per the Claude Code spec) at
the source root or at the `pluginRoot` declared in the catalog metadata.

## Installing plugins

Each catalog entry has an **Install** button. Clicking it:

1. Calls `POST /api/marketplace/install` with `{ name, marketplace, scope: "user" }`.
2. The SDK's `MarketplaceManager` clones the plugin source under
   `~/.omp/plugins/cache/plugins/<id>/`.
3. Writes an entry to `installed_plugins.json` (atomic).
4. The deck re-emits `/api/skills`, `/api/mcp`, `/api/slash-commands` so the
   in-process state reflects the new plugin without restart.

Plugins installed at `scope: "user"` are available across all workspaces.
`scope: "project"` writes to the per-workspace registry instead — the deck UI
defaults to user-scope; ask in chat or hit the API directly for
project-scoped installs.

## Uninstalling

Click the trash icon on an installed entry. The SDK removes the plugin from
the registry and clears the in-process caches. The plugin's cached source
tree is left on disk; clear `~/.omp/plugins/cache/plugins/<id>/` manually if
you want to reclaim the bytes.

## Refreshing catalogs

Sources update upstream. Click the rotate icon next to "Sources" to fetch
the latest catalog JSON for every registered marketplace.

A refresh:

- Updates `cachedAt` for each marketplace.
- Does **not** auto-upgrade installed plugins.

## Checking for and applying updates

The Skills view (`/skills`) is where installed plugins are kept current:

- On open it compares installed versions with the **cached** catalogs
  (`GET /api/marketplace/updates`, no network).
- **Check for updates** re-fetches every registered marketplace from its
  source, then compares (`POST /api/marketplace/updates/check`). A source that
  cannot be fetched is listed as such and its cached catalog is compared
  instead. Checking never upgrades anything.
- Outdated plugins are listed under **Plugin updates** with `from → to` and
  their scope; their skills carry an `update` tag, and a skill's detail pane
  shows the same upgrade. **Upgrade** re-installs that one plugin at the
  catalog's version (`POST /api/marketplace/plugins/:id/upgrade`, body
  `{ scope }`; without a scope every installed scope is upgraded).

All of this goes through NeoPi's own `MarketplaceManager`
(`updateMarketplace`, `checkForUpdates`, `upgradePlugin`,
`upgradePluginAcrossScopes`). A catalog entry without a `version` is never
reported as outdated. The deck checks user-scope installs only; it has no
project registry. There is no background check or auto-upgrade in the deck:
NeoPi's `marketplace.autoUpdate` setting is acted on only when the `npi` CLI
starts, not by deck sessions.

## Capability badges

Each plugin card shows what it provides:

- **cmds** — adds slash commands.
- **agents** — adds custom agents that the main session can launch via the
  `task` tool.
- **hooks** — lifecycle hooks (pre-prompt, post-tool, etc).
- **mcp** — runs MCP servers the agent can call.
- **lsp** — language servers the `lsp` tool can use.

A plugin can declare any combination of these in its `marketplace.json`.

## Browsing in chat

The SDK's `/marketplace` slash command is TUI-only — it opens an interactive
selector inside a terminal. Because the deck filters TUI-only commands from
the picker, you won't see `/marketplace` in the chat composer. Use the
Marketplace nav entry instead.

The `/mcp smithery-search <query>` slash command **is** text-mode and **does**
work from the chat composer — it queries the Smithery MCP registry for new
MCP servers to install.
