-- Phase 9: Edit Studio projects (kind 'edit'). SQLite can't change a CHECK
-- constraint in place, so the table is rebuilt with the same rows.
CREATE TABLE projects_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('post','composition','video','edit')),
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
