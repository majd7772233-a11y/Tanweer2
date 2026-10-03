-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0005_homework_exams_events
-- Three independent entities that all live inside the calendar.
-- An exam or an event may hang directly off a date without needing a subject.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── homeworks ───────────────────────────────────────────────────────────────
-- kind = HOMEWORK (📝 واجب) | TASK (✅ مهمة — "أحضر دفتر النشاط")
CREATE TABLE homeworks (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES groups (id),
  academic_year_id  TEXT NOT NULL REFERENCES academic_years (id),
  subject_id        INTEGER REFERENCES subjects (id),
  section_scope     TEXT,
  study_date        TEXT NOT NULL,                     -- the day it was assigned
  due_date          TEXT,
  due_time          TEXT,                              -- 'HH:MM'
  kind              TEXT NOT NULL DEFAULT 'HOMEWORK' CHECK (kind IN ('HOMEWORK','TASK')),
  title             TEXT NOT NULL,
  body              TEXT,
  attachment_file_id TEXT REFERENCES files (id),
  status            TEXT NOT NULL DEFAULT 'PUBLISHED'
                    CHECK (status IN ('DRAFT','PUBLISHED','EDITED','PENDING_CORRECTION',
                                      'PENDING_DELETION','DELETED','ARCHIVED')),
  is_pinned         INTEGER NOT NULL DEFAULT 0,
  useful_count      INTEGER NOT NULL DEFAULT 0,
  comment_count     INTEGER NOT NULL DEFAULT 0,
  completion_count  INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL REFERENCES users (id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_homeworks_due     ON homeworks (group_id, due_date, status);
CREATE INDEX idx_homeworks_day     ON homeworks (group_id, study_date, subject_id);
CREATE INDEX idx_homeworks_subject ON homeworks (group_id, subject_id, due_date DESC);

-- Personal "تم الإنجاز ✅" — private to the student.
CREATE TABLE homework_completions (
  homework_id  TEXT NOT NULL REFERENCES homeworks (id),
  user_id      TEXT NOT NULL REFERENCES users (id),
  status       TEXT NOT NULL DEFAULT 'DONE' CHECK (status IN ('DONE','NOT_DONE')),
  note         TEXT,
  completed_at TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (homework_id, user_id)
);

CREATE INDEX idx_completions_user ON homework_completions (user_id, status);

-- ── exams ───────────────────────────────────────────────────────────────────
CREATE TABLE exams (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups (id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years (id),
  subject_id       INTEGER REFERENCES subjects (id),
  section_scope    TEXT,
  study_date       TEXT NOT NULL,                      -- the day it was announced
  exam_date        TEXT NOT NULL,
  starts_at        TEXT,                               -- 'HH:MM'
  duration_minutes INTEGER,
  title            TEXT NOT NULL,
  chapters         TEXT,                               -- JSON array, e.g. [1,2,3]
  room             TEXT,
  notes            TEXT,
  book_id          TEXT,
  status           TEXT NOT NULL DEFAULT 'PUBLISHED'
                   CHECK (status IN ('DRAFT','PUBLISHED','EDITED','PENDING_CORRECTION',
                                     'PENDING_DELETION','DELETED','ARCHIVED')),
  reminder_sent_at TEXT,
  useful_count     INTEGER NOT NULL DEFAULT 0,
  comment_count    INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL REFERENCES users (id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_exams_date    ON exams (group_id, exam_date, status);
CREATE INDEX idx_exams_subject ON exams (group_id, subject_id, exam_date DESC);

-- ── events ──────────────────────────────────────────────────────────────────
CREATE TABLE events (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups (id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years (id),
  subject_id       INTEGER REFERENCES subjects (id),
  section_scope    TEXT,
  title            TEXT NOT NULL,
  description      TEXT,
  kind             TEXT NOT NULL DEFAULT 'ANNOUNCEMENT'
                   CHECK (kind IN ('TRIP','COMPETITION','ANNOUNCEMENT','ACTIVITY',
                                   'HOLIDAY','MEETING','OTHER')),
  event_date       TEXT NOT NULL,
  end_date         TEXT,
  starts_at        TEXT,
  ends_at          TEXT,
  location         TEXT,
  status           TEXT NOT NULL DEFAULT 'PUBLISHED'
                   CHECK (status IN ('DRAFT','PUBLISHED','EDITED','PENDING_CORRECTION',
                                     'PENDING_DELETION','DELETED','ARCHIVED')),
  is_pinned        INTEGER NOT NULL DEFAULT 0,
  useful_count     INTEGER NOT NULL DEFAULT 0,
  comment_count    INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL REFERENCES users (id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_events_date ON events (group_id, event_date, status);

-- ── pinned shortcuts (§124) ─────────────────────────────────────────────────
-- Pinning is only a shortcut: the content never leaves its own place.
CREATE TABLE pins (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','COMMENT')),
  entity_id   TEXT NOT NULL,
  pinned_by   TEXT NOT NULL REFERENCES users (id),
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (group_id, entity_type, entity_id)
);

CREATE INDEX idx_pins_group ON pins (group_id, created_at DESC);
