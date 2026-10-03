-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0008_notifications_and_library
-- ═══════════════════════════════════════════════════════════════════════════

-- Notifications are grouped: "📚 5 تحديثات جديدة" instead of five pings.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('LESSON','HOMEWORK','EXAM','EVENT','ISSUE','MESSAGE',
                               'CONTRIBUTION','SCHEDULE','GROUP','SYSTEM')),
  title        TEXT NOT NULL,
  body         TEXT,
  group_id     TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  deep_link    TEXT,                                  -- e.g. 'tanweer://lesson/456'
  actor_id     TEXT,
  batch_key    TEXT,                                  -- same key replaces instead of stacking
  priority     TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH')),
  read_at      TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id, read_at, created_at DESC);
CREATE INDEX idx_notifications_batch ON notifications (user_id, batch_key, read_at);

CREATE TABLE notification_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users (id),
  lessons            INTEGER NOT NULL DEFAULT 1,
  homeworks          INTEGER NOT NULL DEFAULT 1,
  exams              INTEGER NOT NULL DEFAULT 1,
  events             INTEGER NOT NULL DEFAULT 1,
  issues             INTEGER NOT NULL DEFAULT 1,
  messages           INTEGER NOT NULL DEFAULT 1,
  contributions      INTEGER NOT NULL DEFAULT 1,
  schedule           INTEGER NOT NULL DEFAULT 1,
  quiet_from         TEXT,                             -- 'HH:MM'
  quiet_to           TEXT,
  data_saver         INTEGER NOT NULL DEFAULT 0,
  image_quality      TEXT NOT NULL DEFAULT 'MEDIUM'
                     CHECK (image_quality IN ('LOW','MEDIUM','HIGH')),
  wifi_only_sync     INTEGER NOT NULL DEFAULT 0,
  wifi_only_books    INTEGER NOT NULL DEFAULT 1,
  autoplay_video     INTEGER NOT NULL DEFAULT 0,
  auto_compress      INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

-- ── books (§46) ─────────────────────────────────────────────────────────────
-- rights = OWNED        : we host the file in R2 (we must be allowed to redistribute it)
-- rights = OFFICIAL_LINK: we only link to the official source
CREATE TABLE books (
  id               TEXT PRIMARY KEY,
  academic_year_id TEXT REFERENCES academic_years (id),
  grade_id         INTEGER NOT NULL REFERENCES grades (id),
  subject_id       INTEGER REFERENCES subjects (id),
  title            TEXT NOT NULL,
  edition          TEXT,
  publisher        TEXT,
  cover_key        TEXT,
  file_id          TEXT REFERENCES files (id),
  source_url       TEXT,
  rights           TEXT NOT NULL DEFAULT 'OFFICIAL_LINK'
                   CHECK (rights IN ('OWNED','OFFICIAL_LINK')),
  pages            INTEGER,
  size_bytes       INTEGER,
  status           TEXT NOT NULL DEFAULT 'PUBLISHED'
                   CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  uploaded_by      TEXT REFERENCES users (id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_books_grade   ON books (grade_id, subject_id, status);
CREATE INDEX idx_books_subject ON books (subject_id, status);

CREATE TABLE book_sources (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books (id),
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'OFFICIAL'
             CHECK (kind IN ('OFFICIAL','MIRROR','ARCHIVE','OTHER')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_book_sources_book ON book_sources (book_id);

-- ── synchronisation (§84) ───────────────────────────────────────────────────
-- Every entity carries updated_at + revision. The client asks for
-- "everything that changed since <cursor>" instead of re-downloading the day.
CREATE TABLE sync_cursors (
  user_id    TEXT NOT NULL REFERENCES users (id),
  group_id   TEXT NOT NULL,
  cursor     TEXT NOT NULL,                            -- ISO timestamp of last sync
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
