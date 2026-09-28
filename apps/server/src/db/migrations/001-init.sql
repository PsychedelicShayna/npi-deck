-- 001-init.sql
-- Initial schema for npi-deck's local data: tasks, configurable task states,
-- inbox items, cron routines, and routine run history.
--
-- Conventions
--   - ids are short ulid-ish strings generated app-side
--   - timestamps stored as ISO-8601 UTC strings (TEXT) for human-readability
--     and to round-trip cleanly with the REST surface
--   - "order_in_state" is an integer used for stable kanban ordering inside
--     a column; we leave gaps (1000, 2000, …) so a reorder is a single UPDATE

CREATE TABLE IF NOT EXISTS task_states (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT '#6e6a62',
    position    INTEGER NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    state_id        TEXT NOT NULL REFERENCES task_states(id) ON DELETE RESTRICT,
    order_in_state  INTEGER NOT NULL,
    cwd             TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_state_order ON tasks(state_id, order_in_state);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);

CREATE TABLE IF NOT EXISTS inbox_items (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('email','ticket','idea','decision','investigation','capture')),
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    source          TEXT,
    created_at      TEXT NOT NULL,
    processed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_kind_created ON inbox_items(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed ON inbox_items(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS routines (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    cron            TEXT NOT NULL,
    action_kind     TEXT NOT NULL CHECK (action_kind IN ('bash','prompt','script')),
    action_body     TEXT NOT NULL,
    action_cwd      TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_run_at     TEXT,
    next_run_at     TEXT
);

CREATE TABLE IF NOT EXISTS routine_runs (
    id              TEXT PRIMARY KEY,
    routine_id      TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    exit_code       INTEGER,
    stdout_excerpt  TEXT NOT NULL DEFAULT '',
    stderr_excerpt  TEXT NOT NULL DEFAULT '',
    error           TEXT,
    trigger         TEXT NOT NULL CHECK (trigger IN ('cron','manual'))
);

CREATE INDEX IF NOT EXISTS idx_runs_routine_started ON routine_runs(routine_id, started_at DESC);

-- Seed the default kanban columns. is_default = 1 means "may not be deleted
-- via UI when it's the only column the system can fall back to" (UI enforces).
INSERT OR IGNORE INTO task_states (id, name, color, position, is_default) VALUES
    ('s_backlog',  'backlog',  '#6e6a62', 100, 1),
    ('s_active',   'active',   '#9a3412', 200, 0),
    ('s_blocked',  'blocked',  '#b45309', 300, 0),
    ('s_done',     'done',     '#15803d', 400, 0);
