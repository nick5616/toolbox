ALTER TABLE jobs ADD COLUMN pipeline_run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN pipeline_step_id TEXT NOT NULL DEFAULT '';
CREATE INDEX jobs_pipeline_idx ON jobs(pipeline_run_id) WHERE pipeline_run_id <> '';

CREATE TABLE pipelines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  definition TEXT NOT NULL,          -- the Pipeline as JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pipeline_runs (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,         -- no FK: runs outlive their pipeline
  status      TEXT NOT NULL,
  state       TEXT NOT NULL,         -- the PipelineRun as JSON, full variable values included
  created_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pipeline_runs_created_idx ON pipeline_runs(created_at DESC);
CREATE INDEX pipeline_runs_status_idx  ON pipeline_runs(status);

CREATE TABLE pipeline_watch_seen (
  pipeline_id TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  PRIMARY KEY (pipeline_id, path)
);
