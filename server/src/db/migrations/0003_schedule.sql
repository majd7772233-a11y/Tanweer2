-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0003_schedule
-- The weekly timetable is versioned. Old days stay bound to the version that
-- was in force at their time, so editing today's timetable can never damage
-- the archive of previous weeks.
-- ═══════════════════════════════════════════════════════════════════════════

-- Holidays / non-school days / exam periods. Used by "غدًا" so the app jumps
-- to the next real school day instead of blindly adding one day.
CREATE TABLE holidays (
  id               TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_years (id),
  group_id         TEXT REFERENCES groups (id),        -- NULL = whole school
  date             TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  end_date         TEXT,                               -- inclusive, optional
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'HOLIDAY'
                   CHECK (kind IN ('HOLIDAY','EXAM_PERIOD','ACTIVITY','EMERGENCY')),
  created_by       TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_holidays_date  ON holidays (academic_year_id, date);
CREATE INDEX idx_holidays_group ON holidays (group_id, date);

CREATE TABLE schedule_versions (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  title          TEXT NOT NULL,                        -- 'الجدول الحالي'
  effective_from TEXT NOT NULL,                        -- 'YYYY-MM-DD'
  effective_to   TEXT,                                 -- NULL = open ended
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED')),
  notes          TEXT,
  created_by     TEXT REFERENCES users (id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_schedule_versions_group ON schedule_versions (group_id, effective_from DESC);

CREATE TABLE schedule_slots (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES schedule_versions (id),
  group_id   TEXT NOT NULL REFERENCES groups (id),
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = الأحد
  period     INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
  subject_id INTEGER NOT NULL REFERENCES subjects (id),
  room       TEXT,
  notes      TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (version_id, weekday, period)
);

CREATE INDEX idx_schedule_slots_group ON schedule_slots (group_id, weekday, period);

-- ── community timetable updates (§29) ───────────────────────────────────────
-- Filling an empty period is a direct edit (that is how a new timetable gets
-- built). Replacing a period that already has a subject needs a proposal that
-- the group votes on. Nothing changes just because somebody pressed "تعديل".
CREATE TABLE schedule_proposals (
  id                  TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES groups (id),
  version_id          TEXT NOT NULL REFERENCES schedule_versions (id),
  weekday             INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  period              INTEGER NOT NULL CHECK (period BETWEEN 1 AND 12),
  current_subject_id  INTEGER REFERENCES subjects (id),
  proposed_subject_id INTEGER REFERENCES subjects (id),
  kind                TEXT NOT NULL CHECK (kind IN ('FILL','CHANGE','REMOVE')),
  reason              TEXT NOT NULL,
  proposed_by         TEXT NOT NULL REFERENCES users (id),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  approve_count       INTEGER NOT NULL DEFAULT 0,
  reject_count        INTEGER NOT NULL DEFAULT 0,
  eligible_count      INTEGER NOT NULL DEFAULT 0,
  decided_at          TEXT,
  decided_by          TEXT,
  applied_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_schedule_proposals_group ON schedule_proposals (group_id, status, created_at DESC);
