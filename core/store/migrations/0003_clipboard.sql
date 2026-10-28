CREATE TABLE clip_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('text','image')),
  text         TEXT NOT NULL DEFAULT '',
  preview      TEXT NOT NULL DEFAULT '',
  image_path   TEXT NOT NULL DEFAULT '',
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  hash         TEXT NOT NULL UNIQUE,
  byte_size    INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX clip_items_recent_idx ON clip_items(pinned DESC, last_used_at DESC);
