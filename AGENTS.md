# NPI deck

Web cockpit and agent fleet console for NeoPi (`npi`). Fork of `bjb2/omp-deck`.

## Agent skills

### Issue tracker

GitHub Issues on `PsychedelicShayna/npi-deck`; always target it explicitly, `gh` otherwise resolves to `bjb2/omp-deck`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default Matt Pocock triage labels, layered with type, priority, difficulty-bucket, and frame labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Sizing work

Whenever you assess the difficulty, effort, or duration of a task, estimate for an AI agent doing it, not a human. Agents are far faster than the human estimates in training data suggest. Issues and PRs carry a difficulty float title prefix (`0.35 - …`) and a `frame:` label; the full rule is in `docs/agents/issue-tracker.md#sizing`.
