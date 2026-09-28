# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `PsychedelicShayna/npi-deck`. Use the `gh` CLI for all operations.

## Repository targeting

This clone has two remotes: `origin` (`PsychedelicShayna/npi-deck`) and `upstream` (`bjb2/omp-deck`). Without a pinned default, `gh` resolves to the **upstream** fork parent. Pass `-R PsychedelicShayna/npi-deck` on every `gh issue`/`gh pr`/`gh label` call, or confirm `gh repo set-default --view` prints `PsychedelicShayna/npi-deck` in the clone you are using. Never file, comment on, or label anything on `bjb2/omp-deck`.

## Conventions

- **Create an issue**: `gh issue create -R PsychedelicShayna/npi-deck --title "..." --body "..."`. Use a heredoc for multi-line bodies. The title format is set by [Sizing](#sizing).
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Labels

Four orthogonal layers. An issue carries labels from every layer that applies; no layer replaces another.

| Layer | Labels | Rule |
| --- | --- | --- |
| Type | `bug`, `enhancement`, `documentation`, `question` | At least one. |
| Triage | see `docs/agents/triage-labels.md` | Exactly one state. |
| Priority | `priority: p0` … `priority: p3` | Exactly one once triaged. |
| Sizing | one `difficulty: …` bucket and one `frame: …` | Exactly one of each once triaged. See [Sizing](#sizing). |

Other labels:

- `neopi-upstream`: the issue cannot be finished without a change in `PsychedelicShayna/neopi`. Link the NeoPi issue in the body. See [Upstream requests](#upstream-requests-neopi).
- `entangled`: alternative implementations of one idea; shipping any one supersedes the siblings. Only for true alternative clusters.
- `wayfinder:*`: used only by `/wayfinder`.

### Priority

| Label | Meaning |
| --- | --- |
| `priority: p0` | Blocks current work or handles an active incident |
| `priority: p1` | High value, or a prerequisite for several issues |
| `priority: p2` | Useful planned work |
| `priority: p3` | Backlog or opportunistic work |

## Sizing

Sizing has two independent measurements: **difficulty** (how hard) and **frame** (how long). Both measure an AI agent doing the work, never a human.

### Estimate in agent time

Assume an AI agent implements the issue, and that it works far faster than a human would. Do not estimate in human hours, sprints, or developer-days. Estimates in training data (issue trackers, Stack Overflow, team chats) were written by and for humans before capable coding agents existed; that reference point is wrong here. Estimate what a competent agent with a plan, tools, and subagents needs.

### Difficulty

Difficulty is a float in `[0, 1]`: `0` is a mechanical one-line change; `1` is the hardest work the project will attempt (novel architecture, deep cross-cutting change, high regression risk, heavy unknowns). Weigh complexity, uncertainty, blast radius, and coordination with other repos. It does not measure time.

The float goes at the start of the issue and PR title, followed by ` - `:

```
0.35 - Route plan-mode approvals through setPlanProposalHandler
```

Use two decimal places by default. Use up to four when two cannot place an issue relative to its neighbours (`0.3725`). Keep the title float current when re-sizing.

The float also maps to exactly one bucket label. Buckets are half-open `[low, high)`, except the last, which includes `1`:

| Label | Range |
| --- | --- |
| `difficulty: 0.000-0.125` | `0.000 ≤ d < 0.125` |
| `difficulty: 0.125-0.250` | `0.125 ≤ d < 0.250` |
| `difficulty: 0.250-0.375` | `0.250 ≤ d < 0.375` |
| `difficulty: 0.375-0.500` | `0.375 ≤ d < 0.500` |
| `difficulty: 0.500-0.625` | `0.500 ≤ d < 0.625` |
| `difficulty: 0.625-0.750` | `0.625 ≤ d < 0.750` |
| `difficulty: 0.750-0.875` | `0.750 ≤ d < 0.875` |
| `difficulty: 0.875-1.000` | `0.875 ≤ d ≤ 1.000` |

A two-decimal title float that sits on a boundary in the table (`0.12` vs `0.125`) takes the bucket its exact value falls in: `0.12` is in the first bucket, `0.13` in the second.

### Frame

Frame is the agent-time unit the work lands in. Pick the unit first, before any number: would an agent finish this in hours, days, weeks, months, or years?

| Label | Meaning |
| --- | --- |
| `frame: hours` | Done within hours of agent work |
| `frame: days` | Needs days |
| `frame: weeks` | Needs weeks |
| `frame: months` | Needs months |
| `frame: years` | Needs years |

A `frame: weeks` or larger issue is usually a map or epic; consider splitting it with `/to-tickets` or `/wayfinder`.

## Upstream requests (NeoPi)

NPI deck consumes NeoPi (`PsychedelicShayna/neopi`) in-process. When NPI deck needs a NeoPi change (a new SDK export, RPC field, memory API, event shape, anything), the NPI deck lead files an issue on `PsychedelicShayna/neopi` and the NeoPi-side agent implements it there.

- The NeoPi issue text is the contract: exact field names, capability strings, types, and event shapes.
- Either side amends the contract by commenting on the NeoPi issue before merging a change to it.
- The consuming NPI deck issue carries `neopi-upstream` and links the NeoPi issue.
- Disagreements that the two agents cannot resolve go to the operator.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `PsychedelicShayna/npi-deck` with the sizing title prefix and the labels above.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
