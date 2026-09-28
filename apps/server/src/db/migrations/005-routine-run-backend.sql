-- Record the NeoPi tree used by the first agent step of each V1 routine run.
-- Pure deck-step runs and historical runs have no backend identity.
ALTER TABLE routine_runs ADD COLUMN backend_path TEXT;
ALTER TABLE routine_runs ADD COLUMN backend_commit TEXT;
ALTER TABLE routine_runs ADD COLUMN backend_version TEXT;
