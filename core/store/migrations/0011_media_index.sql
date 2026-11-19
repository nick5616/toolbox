-- Phase 20: Smart search (SPEC.md §2). The index of what's in library files
-- (vectors + labels) and what they say (text chunks + FTS5).

CREATE TABLE media_items (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  source       TEXT NOT NULL CHECK (source IN ('library','project')),
  source_ref   TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('image','video','audio','pdf','doc')),
  size_bytes   INTEGER NOT NULL,
  mod_ms       INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','done','failed','skipped')),
  speech_state TEXT NOT NULL DEFAULT 'none' CHECK (speech_state IN ('none','pending','done','failed','skipped','nospeech')),
  reason       TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  model        TEXT NOT NULL DEFAULT '',
  indexed_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_items_state ON media_items(state, id);
CREATE INDEX media_items_speech ON media_items(speech_state, id);

-- pos: -1 whole image, ms for video frames, page index for PDFs.
CREATE TABLE media_vectors (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  pos     INTEGER NOT NULL,
  vec     BLOB NOT NULL,
  PRIMARY KEY (item_id, pos)
);

CREATE TABLE media_labels (
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  source  TEXT NOT NULL CHECK (source IN ('auto','user','hidden')),
  score   REAL NOT NULL DEFAULT 1,
  pos     INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (item_id, label)
);
CREATE INDEX media_labels_label ON media_labels(label, source, score DESC);

CREATE TABLE media_text (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('ocr','pdf','doc','speech','subs','caption')),
  pos     INTEGER NOT NULL,
  end_pos INTEGER NOT NULL DEFAULT -1,
  text    TEXT NOT NULL
);
CREATE INDEX media_text_item ON media_text(item_id, source, pos);

CREATE VIRTUAL TABLE media_text_fts USING fts5(
  text, content='media_text', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER media_text_ai AFTER INSERT ON media_text BEGIN
  INSERT INTO media_text_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER media_text_ad AFTER DELETE ON media_text BEGIN
  INSERT INTO media_text_fts(media_text_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER media_text_au AFTER UPDATE ON media_text BEGIN
  INSERT INTO media_text_fts(media_text_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO media_text_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE media_text_vectors (
  model   TEXT NOT NULL,
  text    TEXT NOT NULL,
  vec     BLOB NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (model, text)
);
