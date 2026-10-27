CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  module_id    TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress     REAL NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  inputs       TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '{}',
  error_code   TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  error_hint   TEXT NOT NULL DEFAULT '',
  attempt      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER NOT NULL DEFAULT 0,
  finished_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_status_idx  ON jobs(status);
CREATE INDEX jobs_created_idx ON jobs(created_at DESC, id DESC);

CREATE TABLE job_logs (
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  stream  TEXT NOT NULL CHECK (stream IN ('stdout','stderr','system')),
  line    TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE outputs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  module_id   TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('audio','video','image','document','other')),
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX outputs_created_idx ON outputs(created_at DESC, id DESC);
CREATE INDEX outputs_module_idx  ON outputs(module_id, created_at DESC);

CREATE TABLE output_tags (
  output_id TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (output_id, tag)
);
CREATE INDEX output_tags_tag_idx ON output_tags(tag);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
