-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0004_content_system
-- The heart of the app:
--   GROUP → DATE → SUBJECT → CONTENT → (discussion, issues, history, votes)
--
-- Content is a first class entity, never a chat message. Files never live in
-- this database: only their metadata (the bytes are in R2).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  object_key   TEXT NOT NULL UNIQUE,                  -- R2 key
  owner_id     TEXT REFERENCES users (id),
  group_id     TEXT REFERENCES groups (id),
  purpose      TEXT NOT NULL DEFAULT 'CONTENT_MEDIA'
               CHECK (purpose IN ('CONTENT_MEDIA','AVATAR','BOOK','CHAT_ATTACHMENT','SUBMISSION')),
  mime_type    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'OTHER'
               CHECK (kind IN ('IMAGE','PDF','DOC','AUDIO','VIDEO','OTHER')),
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  width        INTEGER,
  height       INTEGER,
  page_count   INTEGER,
  checksum     TEXT,                                   -- sha-256 (hex) of the bytes
  perceptual   TEXT,                                   -- optional near-duplicate hint
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','READY','DELETED')),
  meta         TEXT,                                   -- JSON
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  deleted_at   TEXT
);

CREATE INDEX idx_files_owner     ON files (owner_id, created_at DESC);
CREATE INDEX idx_files_group     ON files (group_id, status);
CREATE INDEX idx_files_checksum  ON files (checksum);
CREATE INDEX idx_files_pending   ON files (status, created_at);

CREATE TABLE upload_intents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  group_id     TEXT REFERENCES groups (id),
  object_key   TEXT NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'CONTENT_MEDIA',
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  checksum     TEXT,
  file_id      TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_upload_intents_user ON upload_intents (user_id, completed_at);

-- ── content ─────────────────────────────────────────────────────────────────
-- type       : LESSON (درس), PHOTO (صورة درس مفردة), FILE (ملف), NOTE (ملاحظة),
--              SUMMARY (ملخص), LINK (مصدر خارجي)
-- section_scope : NULL = every section of the group, otherwise a section code.
--                 This is what keeps "كيمياء أ + ب" from mixing 11-A material
--                 into 11-B.
CREATE TABLE content (
  id                  TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES groups (id),
  academic_year_id    TEXT NOT NULL REFERENCES academic_years (id),
  subject_id          INTEGER REFERENCES subjects (id),
  section_scope       TEXT,
  study_date          TEXT NOT NULL,                  -- 'YYYY-MM-DD' of the lesson
  period              INTEGER,
  type                TEXT NOT NULL
                      CHECK (type IN ('LESSON','PHOTO','FILE','NOTE','SUMMARY','LINK')),
  title               TEXT NOT NULL,
  body                TEXT,
  source_url          TEXT,
  status              TEXT NOT NULL DEFAULT 'PUBLISHED'
                      CHECK (status IN ('DRAFT','PUBLISHED','EDITED','PENDING_CORRECTION',
                                        'PENDING_DELETION','DELETED','ARCHIVED')),
  canonical_id        TEXT REFERENCES content (id),   -- set when merged into another lesson
  checksum            TEXT,                           -- main media checksum (duplicate detection)
  media_count         INTEGER NOT NULL DEFAULT 0,
  contribution_count  INTEGER NOT NULL DEFAULT 0,
  useful_count        INTEGER NOT NULL DEFAULT 0,
  comment_count       INTEGER NOT NULL DEFAULT 0,
  is_pinned           INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL REFERENCES users (id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 1,
  purge_after         TEXT
);

CREATE INDEX idx_content_day      ON content (group_id, study_date DESC, subject_id);
CREATE INDEX idx_content_subject  ON content (group_id, subject_id, study_date DESC);
CREATE INDEX idx_content_group    ON content (group_id, created_at DESC);
CREATE INDEX idx_content_checksum ON content (group_id, checksum);
CREATE INDEX idx_content_author   ON content (created_by, created_at DESC);
CREATE INDEX idx_content_type     ON content (group_id, type, study_date DESC);

-- One piece of media inside a lesson. A lesson with 4 board photos is ONE
-- content row with 4 media rows, not four posts.
CREATE TABLE content_media (
  id          TEXT PRIMARY KEY,
  content_id  TEXT NOT NULL REFERENCES content (id),
  file_id     TEXT NOT NULL REFERENCES files (id),
  role        TEXT NOT NULL DEFAULT 'EXTRA'
              CHECK (role IN ('REFERENCE','EXTRA','ATTACHMENT')),
  page_index  INTEGER NOT NULL DEFAULT 0,
  caption     TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX idx_content_media_content ON content_media (content_id, page_index);
CREATE INDEX idx_content_media_file    ON content_media (file_id);

-- "5 مساهمات" under one lesson: who uploaded which page.
CREATE TABLE content_contributions (
  id         TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  file_id    TEXT REFERENCES files (id),
  kind       TEXT NOT NULL DEFAULT 'PHOTO' CHECK (kind IN ('PHOTO','FILE','EDIT','SUMMARY')),
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_contributions_content ON content_contributions (content_id, created_at);
CREATE INDEX idx_contributions_user    ON content_contributions (user_id, created_at DESC);

-- Relations: exam → lessons, homework → lesson, study pack → everything.
CREATE TABLE content_relations (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  from_type   TEXT NOT NULL CHECK (from_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','BOOK')),
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL CHECK (to_type   IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','BOOK')),
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'RELATED'
              CHECK (kind IN ('RELATED','STUDY_PACK','CHAPTER','COVERS','DUPLICATE')),
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id, kind)
);

CREATE INDEX idx_relations_from ON content_relations (from_type, from_id, kind);
CREATE INDEX idx_relations_to   ON content_relations (to_type, to_id, kind);

-- Full history: who created, who edited, what changed, when and why.
CREATE TABLE content_revisions (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','SCHEDULE')),
  entity_id    TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  action       TEXT NOT NULL,                          -- CREATED | EDITED | MEDIA_ADDED | …
  snapshot     TEXT NOT NULL,                          -- JSON of the row after the change
  diff         TEXT,                                   -- JSON {field: [before, after]}
  reason       TEXT,
  request_id   TEXT,                                   -- correction/deletion request that caused it
  changed_by   TEXT NOT NULL,
  changed_at   TEXT NOT NULL
);

CREATE INDEX idx_revisions_entity ON content_revisions (entity_type, entity_id, revision DESC);

-- Discussion attached to any entity (lesson, homework, exam, event, issue).
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','BOOK')),
  entity_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id),
  body        TEXT NOT NULL,
  parent_id   TEXT REFERENCES comments (id),
  status      TEXT NOT NULL DEFAULT 'VISIBLE'
              CHECK (status IN ('VISIBLE','HIDDEN','DELETED')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_comments_entity ON comments (entity_type, entity_id, created_at);
CREATE INDEX idx_comments_user   ON comments (user_id, created_at DESC);

-- "✅ مفيد" instead of a like-counter culture (§128).
CREATE TABLE reactions (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','COMMENT')),
  entity_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id),
  kind        TEXT NOT NULL DEFAULT 'USEFUL' CHECK (kind IN ('USEFUL')),
  created_at  TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, user_id, kind)
);

CREATE INDEX idx_reactions_entity ON reactions (entity_type, entity_id);

-- 📌 مكتبتي — private per user.
CREATE TABLE bookmarks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','BOOK')),
  entity_id   TEXT NOT NULL,
  group_id    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, entity_type, entity_id)
);

CREATE INDEX idx_bookmarks_user ON bookmarks (user_id, created_at DESC);

-- 🔒 private notes — never visible to anybody else.
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  group_id   TEXT,
  subject_id INTEGER,
  content_id TEXT,
  study_date TEXT,
  title      TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_notes_user ON notes (user_id, updated_at DESC);
