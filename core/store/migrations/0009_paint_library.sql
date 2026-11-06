-- Phase 19: Paint+ projects (kind 'paint') and output lineage.
-- SQLite can't change a CHECK constraint in place, so projects is rebuilt
-- with the same rows (as 0007 did).
CREATE TABLE projects_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('post','composition','video','edit','paint')),
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO projects_new (id, kind, name, data, created_at, updated_at)
  SELECT id, kind, name, data, created_at, updated_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
CREATE INDEX projects_kind_idx ON projects(kind, updated_at DESC);

-- What each output was made from (SPEC.md §3.3).
CREATE TABLE output_inputs (
  output_id  TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  input_path TEXT NOT NULL,
  PRIMARY KEY (output_id, input_path)
);
CREATE INDEX output_inputs_path ON output_inputs(input_path);
