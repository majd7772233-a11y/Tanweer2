-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0002_school_structure
-- The school is fixed inside the system: grades → sections → class groups.
-- A student never types their grade or section manually.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE grades (
  id          INTEGER PRIMARY KEY,                    -- 7..12
  name        TEXT NOT NULL,                          -- 'ثاني ثانوي'
  stage       TEXT NOT NULL CHECK (stage IN ('PREPARATORY','SECONDARY')),
  order_index INTEGER NOT NULL
);

CREATE TABLE sections (
  id          INTEGER PRIMARY KEY,
  grade_id    INTEGER NOT NULL REFERENCES grades (id),
  code        TEXT NOT NULL,                          -- 'A'..'D'
  label       TEXT NOT NULL,                          -- 'أ'
  order_index INTEGER NOT NULL,
  UNIQUE (grade_id, code)
);

CREATE INDEX idx_sections_grade ON sections (grade_id);

CREATE TABLE subjects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,                          -- 'الرياضيات'
  short_name  TEXT,
  emoji       TEXT,
  color       TEXT,                                   -- design token, e.g. 'cyan'
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE subject_grades (
  subject_id INTEGER NOT NULL REFERENCES subjects (id),
  grade_id   INTEGER NOT NULL REFERENCES grades (id),
  PRIMARY KEY (subject_id, grade_id)
);

-- ── groups ──────────────────────────────────────────────────────────────────
-- CLASS    : ثاني ثانوي — ب            (the backbone group of a section)
-- SHARED   : كيمياء  (11-A + 11-B)     (one subject, several sections)
-- OPTIONAL : نادي البرمجة              (discoverable, join by request)
CREATE TABLE groups (
  id               TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_years (id),
  kind             TEXT NOT NULL CHECK (kind IN ('CLASS','SHARED','OPTIONAL')),
  name             TEXT NOT NULL,
  description      TEXT,
  subject_id       INTEGER REFERENCES subjects (id),
  emoji            TEXT,
  visibility       TEXT NOT NULL DEFAULT 'PRIVATE'
                   CHECK (visibility IN ('PRIVATE','DISCOVERABLE')),
  join_policy      TEXT NOT NULL DEFAULT 'REQUEST'
                   CHECK (join_policy IN ('AUTO','REQUEST','MODERATOR_ONLY')),
  member_count     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by       TEXT REFERENCES users (id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT
);

CREATE INDEX idx_groups_year_kind ON groups (academic_year_id, kind, status);
CREATE INDEX idx_groups_visibility ON groups (visibility, status);

-- Which sections a group serves (a CLASS group has exactly one).
CREATE TABLE group_sections (
  group_id   TEXT NOT NULL REFERENCES groups (id),
  grade_id   INTEGER NOT NULL REFERENCES grades (id),
  section_id INTEGER NOT NULL REFERENCES sections (id),
  PRIMARY KEY (group_id, section_id)
);

CREATE INDEX idx_group_sections_section ON group_sections (grade_id, section_id);

CREATE TABLE group_members (
  group_id       TEXT NOT NULL REFERENCES groups (id),
  user_id        TEXT NOT NULL REFERENCES users (id),
  role           TEXT NOT NULL DEFAULT 'MEMBER'
                 CHECK (role IN ('MEMBER','MODERATOR','OWNER')),
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','PENDING','LEFT','BANNED')),
  can_vote       INTEGER NOT NULL DEFAULT 1,
  joined_at      TEXT NOT NULL,
  last_read_at   TEXT,
  notifications  TEXT NOT NULL DEFAULT 'ALL'
                 CHECK (notifications IN ('ALL','IMPORTANT','MENTIONS','NONE')),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members (user_id, status);

CREATE TABLE group_join_requests (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  decided_by  TEXT REFERENCES users (id),
  decided_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_join_requests_group ON group_join_requests (group_id, status, created_at);
CREATE INDEX idx_join_requests_user  ON group_join_requests (user_id, status);
