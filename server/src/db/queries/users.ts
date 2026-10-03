/**
 * Users, devices and sessions.
 * NOTE: phone numbers and emails never leave this layer towards other students
 * — the public profile mapper is `toPublicUser`.
 */
import type { AuthUser, Role } from '../../lib/context';
import { allRows, firstOrNull } from './shared';

export interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  full_name: string;
  grade_id: number;
  section_code: string;
  class_id: string;
  academic_year_id: string | null;
  password_hash: string;
  password_kdf: string;
  recovery_hash: string | null;
  role: Role;
  bio: string | null;
  avatar_key: string | null;
  status: string;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revision: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  platform: string;
  model: string | null;
  app_version: string | null;
  os_version: string | null;
  push_token: string | null;
  session_status: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  refresh_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    fullName: row.full_name,
    gradeId: row.grade_id,
    sectionCode: row.section_code,
    classId: row.class_id,
    role: row.role,
    status: row.status,
    academicYearId: row.academic_year_id,
    lastSeenAt: row.last_seen_at,
    avatarKey: row.avatar_key,
  };
}

/**
 * The profile other students see: educational identity only, never contact
 * details (§5).
 */
export function toPublicUser(row: Pick<UserRow, 'id' | 'full_name' | 'grade_id' | 'section_code' | 'class_id' | 'avatar_key' | 'role'>) {
  return {
    id: row.id,
    fullName: row.full_name,
    gradeId: row.grade_id,
    sectionCode: row.section_code,
    classId: row.class_id,
    avatarKey: row.avatar_key,
    role: row.role,
  };
}

export function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return firstOrNull<UserRow>(db.prepare('SELECT * FROM users WHERE id = ?1').bind(id));
}

export function findUserByPhone(db: D1Database, phone: string): Promise<UserRow | null> {
  return firstOrNull<UserRow>(db.prepare('SELECT * FROM users WHERE phone = ?1').bind(phone));
}

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return firstOrNull<UserRow>(db.prepare('SELECT * FROM users WHERE email = ?1').bind(email));
}

export async function phoneExists(db: D1Database, phone: string): Promise<boolean> {
  const row = await firstOrNull<{ one: number }>(db.prepare('SELECT 1 AS one FROM users WHERE phone = ?1 LIMIT 1').bind(phone));
  return row !== null;
}

export async function emailExists(db: D1Database, email: string): Promise<boolean> {
  const row = await firstOrNull<{ one: number }>(db.prepare('SELECT 1 AS one FROM users WHERE email = ?1 LIMIT 1').bind(email));
  return row !== null;
}

export interface InsertUserInput {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  gradeId: number;
  sectionCode: string;
  classId: string;
  academicYearId: string | null;
  passwordHash: string;
  passwordKdf: string;
  recoveryHash: string | null;
  now: string;
}

export async function insertUser(db: D1Database, input: InsertUserInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, phone, email, full_name, grade_id, section_code, class_id, academic_year_id,
                          password_hash, password_kdf, recovery_hash, role, status,
                          failed_logins, created_at, updated_at, last_seen_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'MEMBER', 'ACTIVE', 0, ?12, ?12, ?12, 1)`,
    )
    .bind(
      input.id,
      input.phone,
      input.email,
      input.fullName,
      input.gradeId,
      input.sectionCode,
      input.classId,
      input.academicYearId,
      input.passwordHash,
      input.passwordKdf,
      input.recoveryHash,
      input.now,
    )
    .run();
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  patch: { fullName?: string; email?: string | null; bio?: string | null; avatarKey?: string | null; now: string },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.fullName !== undefined) {
    sets.push(`full_name = ?${values.length + 1}`);
    values.push(patch.fullName);
  }
  if (patch.email !== undefined) {
    sets.push(`email = ?${values.length + 1}`);
    values.push(patch.email);
  }
  if (patch.bio !== undefined) {
    sets.push(`bio = ?${values.length + 1}`);
    values.push(patch.bio);
  }
  if (patch.avatarKey !== undefined) {
    sets.push(`avatar_key = ?${values.length + 1}`);
    values.push(patch.avatarKey);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(patch.now);
  sets.push('revision = revision + 1');
  values.push(userId);
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
}

export async function updateUserPassword(
  db: D1Database,
  userId: string,
  passwordHash: string,
  passwordKdf: string,
  recoveryHash: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET password_hash = ?1, password_kdf = ?2, recovery_hash = COALESCE(?3, recovery_hash),
                        failed_logins = 0, locked_until = NULL, updated_at = ?4, revision = revision + 1
       WHERE id = ?5`,
    )
    .bind(passwordHash, passwordKdf, recoveryHash, now, userId)
    .run();
}

export async function registerFailedLogin(db: D1Database, userId: string, lockedUntil: string | null, now: string): Promise<void> {
  await db
    .prepare('UPDATE users SET failed_logins = failed_logins + 1, locked_until = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(lockedUntil, now, userId)
    .run();
}

export async function clearFailedLogins(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?1').bind(userId).run();
}

export async function touchUserSeen(db: D1Database, userId: string, now: string): Promise<void> {
  await db.prepare('UPDATE users SET last_seen_at = ?1 WHERE id = ?2').bind(now, userId).run();
}

// ── devices ──────────────────────────────────────────────────────────────────

export function findDevice(db: D1Database, userId: string, deviceId: string): Promise<DeviceRow | null> {
  return firstOrNull<DeviceRow>(db.prepare('SELECT * FROM devices WHERE user_id = ?1 AND device_id = ?2').bind(userId, deviceId));
}

export function findDeviceById(db: D1Database, id: string): Promise<DeviceRow | null> {
  return firstOrNull<DeviceRow>(db.prepare('SELECT * FROM devices WHERE id = ?1').bind(id));
}

export function listDevices(db: D1Database, userId: string): Promise<DeviceRow[]> {
  return allRows<DeviceRow>(db.prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY last_seen_at DESC').bind(userId));
}

export interface UpsertDeviceInput {
  id: string;
  userId: string;
  deviceId: string;
  platform: string;
  model: string | null;
  appVersion: string | null;
  osVersion: string | null;
  pushToken: string | null;
  now: string;
}

/** Registers a new installation or refreshes an existing one. */
export async function upsertDevice(db: D1Database, input: UpsertDeviceInput): Promise<DeviceRow> {
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, device_id, platform, model, app_version, os_version, push_token,
                            session_status, created_at, updated_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ACTIVE', ?9, ?9, ?9)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         platform = excluded.platform,
         model = COALESCE(excluded.model, devices.model),
         app_version = COALESCE(excluded.app_version, devices.app_version),
         os_version = COALESCE(excluded.os_version, devices.os_version),
         push_token = COALESCE(excluded.push_token, devices.push_token),
         session_status = 'ACTIVE',
         revoked_at = NULL,
         updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(
      input.id,
      input.userId,
      input.deviceId,
      input.platform,
      input.model,
      input.appVersion,
      input.osVersion,
      input.pushToken,
      input.now,
    )
    .run();

  const row = await findDevice(db, input.userId, input.deviceId);
  if (!row) throw new Error('device upsert failed');
  return row;
}

export async function touchDevice(db: D1Database, deviceRowId: string, now: string): Promise<void> {
  await db.prepare('UPDATE devices SET last_seen_at = ?1 WHERE id = ?2').bind(now, deviceRowId).run();
}

export async function updateDevicePushToken(db: D1Database, deviceRowId: string, pushToken: string | null, now: string): Promise<void> {
  await db.prepare('UPDATE devices SET push_token = ?1, updated_at = ?2 WHERE id = ?3').bind(pushToken, now, deviceRowId).run();
}

/** Revoking a device also kills every session that lives on it. */
export async function revokeDevice(db: D1Database, userId: string, deviceRowId: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE devices SET session_status = 'REVOKED', revoked_at = ?1, push_token = NULL, updated_at = ?1 WHERE id = ?2 AND user_id = ?3")
    .bind(now, deviceRowId, userId)
    .run();
  await db
    .prepare('UPDATE sessions SET revoked_at = ?1, updated_at = ?1 WHERE device_id = ?2 AND user_id = ?3 AND revoked_at IS NULL')
    .bind(now, deviceRowId, userId)
    .run();
}

// ── sessions ─────────────────────────────────────────────────────────────────

export interface InsertSessionInput {
  id: string;
  userId: string;
  deviceRowId: string;
  refreshHash: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  now: string;
}

export async function insertSession(db: D1Database, input: InsertSessionInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, refresh_hash, created_at, updated_at, expires_at, last_used_at, ip, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?5, ?7, ?8)`,
    )
    .bind(input.id, input.userId, input.deviceRowId, input.refreshHash, input.now, input.expiresAt, input.ip, input.userAgent)
    .run();
}

export function findSessionById(db: D1Database, id: string): Promise<SessionRow | null> {
  return firstOrNull<SessionRow>(db.prepare('SELECT * FROM sessions WHERE id = ?1').bind(id));
}

export function findSessionByRefreshHash(db: D1Database, refreshHash: string): Promise<SessionRow | null> {
  return firstOrNull<SessionRow>(db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?1').bind(refreshHash));
}

export async function rotateSession(
  db: D1Database,
  sessionId: string,
  refreshHash: string,
  expiresAt: string,
  now: string,
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET refresh_hash = ?1, expires_at = ?2, updated_at = ?3, last_used_at = ?3 WHERE id = ?4')
    .bind(refreshHash, expiresAt, now, sessionId)
    .run();
}

export async function revokeSession(db: D1Database, sessionId: string, now: string): Promise<void> {
  await db.prepare('UPDATE sessions SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, sessionId).run();
}

export async function revokeAllSessionsForUser(db: D1Database, userId: string, now: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) {
    await db
      .prepare('UPDATE sessions SET revoked_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND id <> ?3')
      .bind(now, userId, exceptSessionId)
      .run();
    return;
  }
  await db.prepare('UPDATE sessions SET revoked_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL').bind(now, userId).run();
}

// ── contributions (§37) ──────────────────────────────────────────────────────

export interface ContributionStats {
  lessons: number;
  homeworks: number;
  photos: number;
  files: number;
  issues: number;
  answers: number;
}

export async function contributionStats(db: D1Database, userId: string): Promise<ContributionStats> {
  const [content, media, homeworks, issues, answers] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM content WHERE created_by = ?1 AND status <> 'DELETED'").bind(userId),
    db.prepare('SELECT COUNT(*) AS n FROM content_media WHERE uploaded_by = ?1 AND deleted_at IS NULL').bind(userId),
    db.prepare("SELECT COUNT(*) AS n FROM homeworks WHERE created_by = ?1 AND status <> 'DELETED'").bind(userId),
    db.prepare("SELECT COUNT(*) AS n FROM issues WHERE created_by = ?1 AND status <> 'CLOSED'").bind(userId),
    db.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ?1 AND status = 'VISIBLE'").bind(userId),
  ]);
  const value = (result: D1Result<unknown>): number => Number((result.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return {
    lessons: value(content as D1Result<unknown>),
    photos: value(media as D1Result<unknown>),
    homeworks: value(homeworks as D1Result<unknown>),
    issues: value(issues as D1Result<unknown>),
    answers: value(answers as D1Result<unknown>),
    files: 0,
  };
}
