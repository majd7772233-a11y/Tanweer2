-- ═══════════════════════════════════════════════════════════════════════════
-- Tanweer · 0001_initial
-- Identity core: academic years, users, devices, sessions + platform tables.
--
-- Conventions used by every migration:
--   * ids            TEXT, prefixed and non-sequential (usr_…, cnt_…)
--   * timestamps     TEXT ISO-8601 UTC ('2026-09-26T09:30:00.000Z')
--   * study dates    TEXT 'YYYY-MM-DD' in the school timezone (Asia/Aden)
--   * booleans       INTEGER 0/1
--   * deleted data   never physically removed unless the community approved it
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE academic_years (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,                         -- '2026 / 2027'
  start_date   TEXT NOT NULL,                         -- 'YYYY-MM-DD'
  end_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('UPCOMING','ACTIVE','ARCHIVED')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_academic_years_status ON academic_years (status);

-- ── users ───────────────────────────────────────────────────────────────────
-- The phone number is the primary login identifier. It is never returned to
-- other students (see docs/SECURITY.md).
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  phone             TEXT NOT NULL UNIQUE,             -- normalized +9677XXXXXXXX
  email             TEXT UNIQUE,                      -- optional secondary login id
  full_name         TEXT NOT NULL,
  grade_id          INTEGER NOT NULL,                 -- 7..12
  section_code      TEXT NOT NULL,                    -- 'A'..'D'
  class_id          TEXT NOT NULL,                    -- '11-B'
  academic_year_id  TEXT REFERENCES academic_years (id),
  password_hash     TEXT NOT NULL,                    -- HMAC(pepper, salt:authKey)
  password_kdf      TEXT NOT NULL DEFAULT 'pbkdf2-sha256$210000$32',
  recovery_hash     TEXT,                             -- HMAC of the recovery code
  role              TEXT NOT NULL DEFAULT 'MEMBER'
                    CHECK (role IN ('MEMBER','GROUP_MODERATOR','VERIFIED_TEACHER',
                                    'OFFICIAL_TEACHER','SCHOOL_ADMIN')),
  bio               TEXT,
  avatar_key        TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUSPENDED','ARCHIVED')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_seen_at      TEXT,
  revision          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_users_class      ON users (academic_year_id, class_id, status);
CREATE INDEX idx_users_grade      ON users (grade_id, section_code);
CREATE INDEX idx_users_last_seen  ON users (last_seen_at);

-- ── devices ─────────────────────────────────────────────────────────────────
-- One row per app installation, so a user can see and revoke their devices.
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id),
  device_id      TEXT NOT NULL,                       -- client generated, stable
  platform       TEXT NOT NULL DEFAULT 'ANDROID',
  model          TEXT,
  app_version    TEXT,
  os_version     TEXT,
  push_token     TEXT,
  session_status TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (session_status IN ('ACTIVE','REVOKED')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_seen_at   TEXT,
  revoked_at     TEXT,
  UNIQUE (user_id, device_id)
);

CREATE INDEX idx_devices_user ON devices (user_id, session_status);

-- ── sessions ────────────────────────────────────────────────────────────────
-- Refresh tokens are stored as HMAC hashes only. Access tokens are short lived
-- and never stored (they are self verifying).
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id),
  device_id     TEXT NOT NULL REFERENCES devices (id),
  refresh_hash  TEXT NOT NULL,                        -- HMAC(session_pepper, token)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX idx_sessions_user   ON sessions (user_id, revoked_at);
CREATE INDEX idx_sessions_device ON sessions (device_id);
CREATE UNIQUE INDEX idx_sessions_refresh ON sessions (refresh_hash);

-- ── platform tables ─────────────────────────────────────────────────────────
-- Fixed window rate limiting, kept in D1 because the free plan has no KV
-- binding in our stack (see docs/ARCHITECTURE.md).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,                      -- '<bucket>:<identity>:<window>'
  bucket       TEXT NOT NULL,
  identity     TEXT NOT NULL,
  window_start INTEGER NOT NULL,                      -- epoch ms
  count        INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_rate_limits_expiry ON rate_limits (expires_at);

-- Idempotency for "publish" taps on weak mobile networks: the same
-- client_upload_id can never create two rows.
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,                     -- '<user_id>:<endpoint>:<client key>'
  user_id       TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code   INTEGER NOT NULL DEFAULT 200,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);

-- Append-only trail of sensitive actions (login, revoke, deletes, votes…).
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  group_id    TEXT,
  meta        TEXT,                                   -- JSON
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_audit_actor  ON audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
