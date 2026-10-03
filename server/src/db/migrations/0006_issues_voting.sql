-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0006_issues_voting
-- Questions (GitHub-issues style), community corrections and community
-- deletions. Nothing is deleted by a single person, and nothing is deleted
-- because "time ran out".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE issues (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups (id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years (id),
  subject_id      INTEGER REFERENCES subjects (id),
  section_scope   TEXT,
  study_date      TEXT,
  title           TEXT NOT NULL,
  body            TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','IN_DISCUSSION','SOLVED','CLOSED')),
  content_id      TEXT,
  homework_id     TEXT,
  exam_id         TEXT,
  best_comment_id TEXT,
  comment_count   INTEGER NOT NULL DEFAULT 0,
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL REFERENCES users (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_issues_group   ON issues (group_id, status, last_activity_at DESC);
CREATE INDEX idx_issues_subject ON issues (group_id, subject_id, created_at DESC);
CREATE INDEX idx_issues_homework ON issues (homework_id);
CREATE INDEX idx_issues_exam    ON issues (exam_id);
CREATE INDEX idx_issues_content ON issues (content_id);

CREATE TABLE issue_comments (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'VISIBLE'
             CHECK (status IN ('VISIBLE','HIDDEN','DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_issue_comments ON issue_comments (issue_id, created_at);

-- ── corrections (§62) ───────────────────────────────────────────────────────
-- Fixing a wrong date is better than deleting: the content stays, the history
-- records both the wrong and the corrected value.
CREATE TABLE correction_requests (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE')),
  entity_id      TEXT NOT NULL,
  field          TEXT NOT NULL,                        -- study_date | subject_id | title …
  current_value  TEXT,
  proposed_value TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  approve_count  INTEGER NOT NULL DEFAULT 0,
  reject_count   INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  requested_by   TEXT NOT NULL REFERENCES users (id),
  decided_by     TEXT,
  decided_at     TEXT,
  applied_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_corrections_entity ON correction_requests (entity_type, entity_id, status);
CREATE INDEX idx_corrections_status ON correction_requests (group_id, status, created_at DESC);

-- ── deletions (§60 / §61) ───────────────────────────────────────────────────
-- A deletion is a request, visible to everybody, and it only happens when all
-- eligible members agree. One rejection keeps the content forever.
CREATE TABLE deletion_requests (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('CONTENT','HOMEWORK','EXAM','EVENT','ISSUE','COMMENT')),
  entity_id      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  approve_count  INTEGER NOT NULL DEFAULT 0,
  reject_count   INTEGER NOT NULL DEFAULT 0,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  requested_by   TEXT NOT NULL REFERENCES users (id),
  decided_by     TEXT,
  decided_at     TEXT,
  applied_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_deletions_entity ON deletion_requests (entity_type, entity_id, status);
CREATE INDEX idx_deletions_status ON deletion_requests (group_id, status, created_at DESC);

-- ── votes ───────────────────────────────────────────────────────────────────
CREATE TABLE votes (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL
              CHECK (target_type IN ('DELETION','CORRECTION','SCHEDULE_PROPOSAL','TEACHER_NOMINATION')),
  target_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users (id),
  value       TEXT NOT NULL CHECK (value IN ('APPROVE','REJECT','ABSTAIN')),
  comment     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (target_type, target_id, user_id)
);

CREATE INDEX idx_votes_target ON votes (target_type, target_id, value);
CREATE INDEX idx_votes_user   ON votes (user_id, created_at DESC);

-- ── teacher nomination (§59) — schema is ready, UI comes later ──────────────
CREATE TABLE teacher_nominations (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL REFERENCES groups (id),
  subject_id       INTEGER REFERENCES subjects (id),
  nominee_name     TEXT NOT NULL,
  nominee_user_id  TEXT REFERENCES users (id),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING_NOMINEE'
                   CHECK (status IN ('PENDING_NOMINEE','VOTING','APPROVED','REJECTED','WITHDRAWN')),
  approve_count    INTEGER NOT NULL DEFAULT 0,
  reject_count     INTEGER NOT NULL DEFAULT 0,
  eligible_count   INTEGER NOT NULL DEFAULT 0,
  voting_ends_at   TEXT,
  nominated_by     TEXT NOT NULL REFERENCES users (id),
  decided_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_nominations_group ON teacher_nominations (group_id, status);
