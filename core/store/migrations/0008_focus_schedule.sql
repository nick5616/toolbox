-- Phase 18: Focus Lock (profiles, sessions, block events) and the pipeline
-- schedule trigger's last fire per pipeline.
CREATE TABLE focus_profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE focus_sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL DEFAULT 0,
  json       TEXT NOT NULL
);
CREATE INDEX focus_sessions_started ON focus_sessions(started_at DESC);
CREATE TABLE focus_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  result     TEXT NOT NULL,
  error      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX focus_events_session ON focus_events(session_id, at);
CREATE INDEX focus_events_path ON focus_events(result, path);
CREATE TABLE pipeline_schedule_state (
  pipeline_id  TEXT PRIMARY KEY,
  last_fire_at INTEGER NOT NULL
);
