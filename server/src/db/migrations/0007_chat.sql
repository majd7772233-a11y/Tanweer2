-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0007_chat
-- Conversation exists, but it is not where important information is stored.
-- The Durable Object owns live fan-out, presence and recent messages. This
-- database owns the durable archive (pagination, search, reconnect).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE chat_rooms (
  id              TEXT PRIMARY KEY,
  group_id        TEXT REFERENCES groups (id),
  kind            TEXT NOT NULL DEFAULT 'GROUP' CHECK (kind IN ('GROUP','DIRECT')),
  title           TEXT,
  last_seq        INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_chat_rooms_group ON chat_rooms (group_id);

CREATE TABLE chat_room_members (
  room_id     TEXT NOT NULL REFERENCES chat_rooms (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  joined_at   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LEFT','BANNED')),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX idx_chat_members_user ON chat_room_members (user_id, status);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES chat_rooms (id),
  seq         INTEGER NOT NULL,                        -- assigned by the Durable Object
  sender_id   TEXT NOT NULL REFERENCES users (id),
  body        TEXT,
  kind        TEXT NOT NULL DEFAULT 'TEXT'
              CHECK (kind IN ('TEXT','ATTACHMENT','SYSTEM')),
  file_id     TEXT REFERENCES files (id),
  reply_to_id TEXT,
  client_id   TEXT,                                    -- de-duplicates retries
  status      TEXT NOT NULL DEFAULT 'VISIBLE'
              CHECK (status IN ('VISIBLE','DELETED','HIDDEN')),
  edited_at   TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE INDEX idx_chat_messages_room ON chat_messages (room_id, seq DESC);
CREATE INDEX idx_chat_messages_client ON chat_messages (room_id, sender_id, client_id);

CREATE TABLE chat_read_state (
  room_id       TEXT NOT NULL REFERENCES chat_rooms (id),
  user_id       TEXT NOT NULL REFERENCES users (id),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
