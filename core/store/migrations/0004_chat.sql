CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,               -- ULID
  title TEXT NOT NULL,               -- first user message, trimmed to 80 chars; renameable
  model TEXT NOT NULL,               -- catalog id or "ollama:<name>"
  system_prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','stopped','error')),
  error TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  tokens_per_sec REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_conv_idx ON chat_messages(conversation_id, created_at);
CREATE INDEX chat_conversations_updated_idx ON chat_conversations(updated_at DESC);
