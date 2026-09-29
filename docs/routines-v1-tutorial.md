# Routines V1 — Tutorial

V1 routines are multi-step pipelines: a single routine can fetch data, run
an LLM against it, write the result somewhere, and persist a snippet of
state for the next run. Each routine can have multiple triggers (cron,
webhook, manual) and a budget cap. This walk-through gets you from zero to a
working daily-briefing in a few minutes.

## Quickest path: install the daily-briefing template

The fastest way to see a V1 routine in action:

```bash
# List shipped templates
curl http://127.0.0.1:1701/api/routine-templates

# Install one
curl -X POST http://127.0.0.1:1701/api/routine-templates/daily-briefing
```

That creates a routine in **disabled** state. Open the deck at
`/routines`, click the new entry, and you'll see the **Builder** tab with all
7 steps, the **Triggers** tab with its cron + webhook, the **Settings** tab
with the budget caps, and the **Spec (YAML)** tab with the raw spec.

To run it once on demand:

```bash
curl -X POST http://127.0.0.1:1701/api/routines/<id>/run
```

Or just click **Run now** in the editor. Once it's finished, the routine creates
a new **capture item in the deck's native Inbox** (`/inbox`, kind=`capture`).

The other shipped template, `kb-orphan-census`, installs the same way. Once
enabled it runs every Monday and files one inbox item listing the KB notes that
no other note links to (honouring `.kbignore`); it never edits the KB.

## Author one yourself in the visual builder

1. Open `/routines` and click **New routine**.
2. The header shows two mode pills — **pipeline** (V1) and **single-action**
   (legacy V0). New routines default to pipeline.
3. **Settings** tab: set a name, optionally a description, concurrency,
   timezone, tags, and budget caps.
4. **Triggers** tab: add at least one trigger (cron / webhook / manual).
   Cron entries get a live "next 3 runs" preview against the IANA timezone
   you set.
5. **Steps** tab: click **+ Add step** and pick a type. Each card has the
   shared fields (`id`, `when`, `on_failure`, `retry`, `timeout_secs`) on
   top, then the type-specific fields underneath. Up/down arrows reorder.
6. Toggle **Enabled** in the footer, then **Create**.

The **Spec (YAML)** tab shows the same routine as raw YAML. Edit there and
click **Apply to form** to sync the changes back — useful for advanced
patterns the form doesn't expose (deeply nested transforms, complex
templating).

## The 9 step types

| type        | use                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- |
| `run`       | shell out to a command, capture stdout/stderr                                            |
| `agent`     | prompt the omp SDK; costs LLM tokens                                                     |
| `write`     | write a templated string to a file (overwrite or append)                                 |
| `http`      | GET / POST / PUT / PATCH / DELETE against a URL; internal calls get an HMAC bearer token |
| `deck`      | read or mutate deck-native state without hand-rolling API calls (`create_inbox_item`, `create_task`, `move_task`, `promote_inbox_item_to_task`, `list_tasks`, `list_inbox`, `get_task`, `get_inbox_item`, `kb_orphan_census`) |
| `transform` | JS expression in a quickjs sandbox; sets `steps.<id>.json`                               |
| `set_state` | UPSERT key/value pairs into the routine's persistent state                               |
| `wait`      | sleep N seconds (useful between polling steps)                                           |
| `mcp`       | call one MCP server tool directly (no model); see [The `mcp` step](#the-mcp-step)         |

Every step type has the shared fields:

- `id` — referenced by downstream steps via `steps.<id>.json`, `.stdout`, `.stderr`
- `when` — a JS expression evaluated in the sandbox; if it returns falsy, the
  step is skipped
- `on_failure` — `abort` (default), `continue`, `retry`
- `retry` — `{ times, backoff: linear | exponential, max_delay_secs?, after_retry? }`
- `timeout_secs` — per-step wall-clock cap

## Templating

The runner exposes a `{{ expr }}` template surface for string fields:

- `{{ run.id }}` — opaque run ID, prefixed `run_`
- `{{ run.date }}` — `YYYY-MM-DD` in the routine's timezone
- `{{ run.started }}` — ISO start timestamp
- `{{ trigger.kind }}` — `cron` | `manual` | `webhook` | `event`
- `{{ trigger.payload.<field> }}` — webhook body or manual params
- `{{ steps.<id>.json.<field> }}` — structured output (e.g. parsed HTTP response)
- `{{ steps.<id>.stdout }}` — captured stdout text
- `{{ state.<key> }}` — persisted state from prior runs (or `set_state` earlier this run)
- `{{ env.NAME }}` — environment variable
- `{{ secrets.NAME }}` — env var, but redacted in logs

Helpers: `{{ steps.X.json | json }}` (JSON-stringify), `{{ items | length }}`.

In a single-expression payload (e.g. an HTTP body), the value is preserved
as its native type, not coerced to a string.

## The `mcp` step

```yaml
- id: issues
  type: mcp
  server: github          # a server enabled for the routine's cwd
  tool: search_issues     # a tool that server advertises
  args:
    query: "repo:me/app is:open label:{{ trigger.label }}"
    per_page: "{{ state.page_size }}"   # a lone {{ }} keeps its type
```

- The server is found the way a chat opened in the routine's cwd (its
  `actionCwd`, else the deck's default cwd) would find it: user and project
  `mcp.json`, other tools' configs, the deny and force-enable lists,
  `mcp.enableProjectConfig` and `mcp.includeServers`. A routine does not
  borrow a live chat's MCP connection; routines run from cron and webhooks
  with no chat open. The step connects the server, makes the call and closes
  it, so every attempt (retries included) gets a fresh server process.
- `args` are templated, then validated against the tool's input schema
  before anything is sent. If the tool's schema cannot be compiled, the call
  goes out anyway and `stderr` says local validation was skipped.
- The step's timeout (`timeout_secs`, default 60) and cancelling the run both
  abort the handshake or the call and stop the server.
- `steps.<id>.stdout` holds the text content; `steps.<id>.json` holds
  `{ content, structuredContent?, isError? }`, with image and audio data
  replaced by its size. A result with `isError: true` fails the step with the
  tool's text.
- Values from the server's config that can be credentials (env and header
  values, URL parts, the value after a key-shaped flag, resolved `!command`
  and OAuth tokens) are replaced with `••••••` in everything the step records,
  even when the server echoes them back.
- **Integrations** lists every enabled server for the deck's workspace with
  its tools and input schemas, and a step snippet for each tool.

## Triggers

A routine can have multiple triggers, even of the same kind. Examples:

```yaml
trigger:
  - cron: "0 7 * * *"          # 7am daily
  - cron: "0 17 * * 1-5"       # 5pm weekdays
  - webhook:
      path: /hooks/refresh
      secret_env: REFRESH_SECRET
  - manual: {}
```

Cron expressions are 5-field standard (minute / hour / day / month / weekday).
Set `timezone:` on the spec to evaluate against an IANA zone like
`America/Chicago`.

For webhook triggers, click **Rotate secret** in the routine's Settings tab
to mint a fresh secret. The plaintext is shown **once**; the deck keeps it
in `deck.db` to verify signatures and never sends it back. Every delivery
carries two headers:

```
X-Routine-Timestamp: <unix seconds>
X-Routine-Signature: sha256=<hex>
```

where `<hex>` is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`: the
timestamp header's value, a `.`, then the exact request body bytes. The deck
recomputes the MAC over the bytes it received and compares in constant time,
so a signature does not carry over to another body. A timestamp more than
five minutes from the deck's clock is refused, which bounds how long a
captured delivery can be replayed. Refused deliveries answer `401` and are
recorded as runs aborted with `signature_invalid`.

```sh
ts=$(date +%s)
body='{"hello":"world"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$REFRESH_SECRET" -hex | sed 's/^.* //')
curl -X POST http://127.0.0.1:1701/api/hooks/refresh \
  -H 'content-type: application/json' \
  -H "X-Routine-Timestamp: $ts" \
  -H "X-Routine-Signature: sha256=$sig" \
  --data-raw "$body"
```

Webhooks registered before signed deliveries existed sent the bare secret as
`X-Routine-Signature`. Those registrations keep accepting it, and the
Settings tab shows a deprecation warning with the last such delivery. The
first bare-secret delivery also lets the deck store that secret, so the same
sender can switch to signing with the secret it already has; then click
**Stop accepting the bare secret** and confirm (or
`PATCH /api/routines/:id/webhook {"acceptBareSecret": false}`). This is
permanent: `{"acceptBareSecret": true}` answers `409` for any registration
that has stopped accepting it. Rotating the secret also ends bare-secret
deliveries for good. New registrations never accept the bare secret.

The checks run again when the body has arrived, against the registration
as it is at that moment: a delivery still uploading when the secret is
rotated or the bare secret is refused is rejected, and so is one whose
timestamp leaves the window during the upload.

Because `deck.db` holds the secrets, the deck keeps its data dir
(`~/.npi-deck`) at `0700` and `deck.db`, `deck.db-wal` and `deck.db-shm` at
`0600`, narrowing files left more open by earlier versions at startup.

## Concurrency

What happens when a trigger fires while a previous run is in flight:

- `skip` (default): drop the new fire
- `queue`: queue it; run after the current one finishes
- `cancel-previous`: abort the in-flight run, start the new one
- `parallel`: run concurrently (costs add up)

## Budget

`max_duration_secs`, `max_llm_cost_usd`, `max_llm_tokens_input`,
`max_llm_tokens_output`, `max_steps_executed`. Checked after each attempt,
including failed retries. On excess the runner stops with
`abort_reason: 'budget'` and persists the usage and partial results.

Agent-step token totals include cached and orchestration tokens when reported;
USD cost comes from NeoPi's provider-reported usage, not a static model-price
estimate. Your LLM vendor's bill remains authoritative.

The run history records the NeoPi backend tree path, commit, and version
selected by its first agent step. Later steps and retries use that same
command; deck-only and historical runs have no backend field.

Each run also records its trigger payload (`triggerPayload`, a JSON string):
the webhook body, manual params, or event payload. Steps always receive the
full, unredacted payload; only the stored copy is changed.

The stored copy is redacted by key name. At any depth, the value of a key
whose name contains `token`, `secret`, `passw`, `pwd`, `api_key` / `api-key` /
`apikey`, `auth`, `signature`, `cookie`, `credential`, `session` or `bearer`
(any case) is stored as `"[redacted]"`. Values under any other key are stored
as sent, so a credential under an innocuous key name is kept. Keys such as
`author` or `session_count` match too and are redacted.

After redaction the copy is capped at 8 KiB. A larger payload is stored as
`{ "truncated": true, "bytes": <size of the redacted JSON>, "preview": "<its head>" }`.
A webhook rejected for a bad signature records only its path and the sorted
names of the request headers, never a header value.

## Cross-run state

Persistent key-value store scoped per routine:

```yaml
state:
  declared_keys: [last_seen_id]
steps:
  - id: should_run
    type: transform
    body: |
      if (state.last_seen_id === run.id) return { ok: false };
      return { ok: true };
  - id: do_thing
    type: run
    when: steps.should_run.json.ok
    command: ./script.sh
  - id: persist
    type: set_state
    state:
      last_seen_id: "{{ run.id }}"
```

`declared_keys` is informational — the runtime can write any key via
`set_state`. State writes are atomic per step.

## Observability

- Routine detail page → **Runs** section lists recent runs.
- Click a run → `/routines/:id/runs/:runId` opens **RunDetailView** with a
  live-polling timeline. Click any step to expand stdout / stderr /
  structured JSON / error.
- `GET /api/routines/:id/metrics` returns success rate, p50/p95 duration,
  MTD cost, and a last-30 sparkline series.

## Programmatic install

If you'd rather not click through the builder:

```bash
# Author the spec as a YAML file
cat > /tmp/my-routine.yaml <<'YAML'
name: hello-world
description: minimal one-step routine
trigger:
  - manual: {}
concurrency: skip
steps:
  - id: greet
    type: run
    command: 'echo "hello from {{ run.id }}"'
YAML

curl -X POST http://127.0.0.1:1701/api/routines \
  -H "content-type: application/json" \
  -d "$(jq -Rs '{ name: "hello-world", cron: "", actionKind: "bash", actionBody: "", specYaml: . }' < /tmp/my-routine.yaml)"
```

The server validates the YAML against the JSON Schemas in
`packages/protocol/src/schemas/` and returns 400 with a list of schema
errors if anything is off.

## Limitations in V1

- For `agent` steps, omitting
  `mcp_servers_allowed` inherits the backend's configured MCP servers; `[]`
  disables them. Any explicit MCP restriction requires a probed backend with
  NeoPi's `mcp.includeServers` and `--mcp`/`--no-mcp` support (neopi#120);
  older backends reject the step before spawning. Entries must be literal
  enabled server names, not globs. Typos, disabled servers and names shadowed
  by a disabled higher-priority config fail before a session starts.
- Omitting `skills_allowed` inherits all installed skills. Literal
  `skills_allowed: [name]` restricts skills with NeoPi's `--skills` flag;
  globs are rejected before spawning, and `skills_allowed: []` disables
  skills. In the visual builder, select **Only listed** to restrict either
  surface; removing its last tag preserves the empty deny-all list. Select
  **All** explicitly to restore the unrestricted default.
- DnD step reordering lands in V1.5. Up/down arrows work today.
- No "test this step in isolation" runner yet — full re-run is the only
  way to debug. Coming in V2.
- Windows console codepage mangles em-dashes in `agent` step stdout
  (cosmetic; the briefing is fully usable).

## What's next (V1.5)

- Workspace MCP integration: Gmail / Calendar / Drive / Docs via the
  [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
  server. Inbox-triager is the V1.5 proof point.
- `server` + `tool` dropdowns in the `mcp` step form, sourced from the
  Integrations listing (today they are typed by name).
- Drag-and-drop step reordering with smart warnings when a reorder breaks
  a downstream context reference.
- Per-step "Test this step" runner against the last-run context.
