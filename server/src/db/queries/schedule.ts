/**
 * Timetable versions, slots and community change proposals (§27 → §29).
 *
 * A day always resolves through the version that was in force on that day, so
 * a new timetable never rewrites the archive of old days.
 */
import { allRows, firstOrNull } from './shared';

export interface ScheduleVersionRow {
  id: string;
  group_id: string;
  title: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleSlotRow {
  id: string;
  version_id: string;
  group_id: string;
  weekday: number;
  period: number;
  subject_id: number;
  room: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleProposalRow {
  id: string;
  group_id: string;
  version_id: string;
  weekday: number;
  period: number;
  current_subject_id: number | null;
  proposed_subject_id: number | null;
  kind: 'FILL' | 'CHANGE' | 'REMOVE';
  reason: string;
  proposed_by: string;
  status: string;
  approve_count: number;
  reject_count: number;
  eligible_count: number;
  decided_at: string | null;
  decided_by: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The version that was in force on a given school day. */
export function findVersionForDate(db: D1Database, groupId: string, date: string): Promise<ScheduleVersionRow | null> {
  return firstOrNull<ScheduleVersionRow>(
    db
      .prepare(
        `SELECT * FROM schedule_versions
          WHERE group_id = ?1 AND effective_from <= ?2 AND (effective_to IS NULL OR effective_to >= ?2)
          ORDER BY effective_from DESC LIMIT 1`,
      )
      .bind(groupId, date),
  );
}

export function findActiveVersion(db: D1Database, groupId: string): Promise<ScheduleVersionRow | null> {
  return firstOrNull<ScheduleVersionRow>(
    db
      .prepare("SELECT * FROM schedule_versions WHERE group_id = ?1 AND status = 'ACTIVE' ORDER BY effective_from DESC LIMIT 1")
      .bind(groupId),
  );
}

export function findVersionById(db: D1Database, id: string): Promise<ScheduleVersionRow | null> {
  return firstOrNull<ScheduleVersionRow>(db.prepare('SELECT * FROM schedule_versions WHERE id = ?1').bind(id));
}

export function listVersions(db: D1Database, groupId: string): Promise<ScheduleVersionRow[]> {
  return allRows<ScheduleVersionRow>(
    db.prepare('SELECT * FROM schedule_versions WHERE group_id = ?1 ORDER BY effective_from DESC LIMIT 20').bind(groupId),
  );
}

export interface SlotWithSubject extends ScheduleSlotRow {
  subject_name: string;
  subject_short: string | null;
  subject_emoji: string | null;
  subject_color: string | null;
}

export function listSlots(db: D1Database, versionId: string, weekday?: number): Promise<SlotWithSubject[]> {
  const statement = weekday === undefined
    ? db
        .prepare(
          `SELECT sl.*, s.name AS subject_name, s.short_name AS subject_short, s.emoji AS subject_emoji, s.color AS subject_color
             FROM schedule_slots sl JOIN subjects s ON s.id = sl.subject_id
            WHERE sl.version_id = ?1 ORDER BY sl.weekday ASC, sl.period ASC`,
        )
        .bind(versionId)
    : db
        .prepare(
          `SELECT sl.*, s.name AS subject_name, s.short_name AS subject_short, s.emoji AS subject_emoji, s.color AS subject_color
             FROM schedule_slots sl JOIN subjects s ON s.id = sl.subject_id
            WHERE sl.version_id = ?1 AND sl.weekday = ?2 ORDER BY sl.period ASC`,
        )
        .bind(versionId, weekday);
  return allRows<SlotWithSubject>(statement);
}

export function findSlot(db: D1Database, versionId: string, weekday: number, period: number): Promise<ScheduleSlotRow | null> {
  return firstOrNull<ScheduleSlotRow>(
    db.prepare('SELECT * FROM schedule_slots WHERE version_id = ?1 AND weekday = ?2 AND period = ?3').bind(versionId, weekday, period),
  );
}

export function findSlotById(db: D1Database, id: string): Promise<ScheduleSlotRow | null> {
  return firstOrNull<ScheduleSlotRow>(db.prepare('SELECT * FROM schedule_slots WHERE id = ?1').bind(id));
}

export interface UpsertSlotInput {
  id: string;
  versionId: string;
  groupId: string;
  weekday: number;
  period: number;
  subjectId: number;
  room: string | null;
  notes: string | null;
  createdBy: string;
  now: string;
}

export async function upsertSlot(db: D1Database, input: UpsertSlotInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO schedule_slots (id, version_id, group_id, weekday, period, subject_id, room, notes, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT (version_id, weekday, period) DO UPDATE SET
         subject_id = excluded.subject_id,
         room = excluded.room,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.versionId,
      input.groupId,
      input.weekday,
      input.period,
      input.subjectId,
      input.room,
      input.notes,
      input.createdBy,
      input.now,
    )
    .run();
}

export async function deleteSlot(db: D1Database, versionId: string, weekday: number, period: number): Promise<void> {
  await db.prepare('DELETE FROM schedule_slots WHERE version_id = ?1 AND weekday = ?2 AND period = ?3').bind(versionId, weekday, period).run();
}

export async function insertVersion(db: D1Database, row: ScheduleVersionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO schedule_versions (id, group_id, title, effective_from, effective_to, status, notes, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(row.id, row.group_id, row.title, row.effective_from, row.effective_to, row.status, row.notes, row.created_by, row.created_at, row.updated_at)
    .run();
}

export async function supersedeOldVersions(db: D1Database, groupId: string, keepVersionId: string, fromDate: string): Promise<void> {
  await db
    .prepare(
      `UPDATE schedule_versions SET status = 'SUPERSEDED', effective_to = COALESCE(effective_to, ?1), updated_at = ?2
        WHERE group_id = ?3 AND id <> ?4 AND status = 'ACTIVE'`,
    )
    .bind(fromDate, new Date().toISOString(), groupId, keepVersionId)
    .run();
}

// ── proposals ────────────────────────────────────────────────────────────────

export function insertProposal(db: D1Database, row: ScheduleProposalRow): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO schedule_proposals (id, group_id, version_id, weekday, period, current_subject_id, proposed_subject_id,
                                       kind, reason, proposed_by, status, approve_count, reject_count, eligible_count,
                                       created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'PENDING', 0, 0, ?11, ?12, ?12)`,
    )
    .bind(
      row.id,
      row.group_id,
      row.version_id,
      row.weekday,
      row.period,
      row.current_subject_id,
      row.proposed_subject_id,
      row.kind,
      row.reason,
      row.proposed_by,
      row.eligible_count,
      row.created_at,
    )
    .run();
}

export function findProposal(db: D1Database, id: string): Promise<ScheduleProposalRow | null> {
  return firstOrNull<ScheduleProposalRow>(db.prepare('SELECT * FROM schedule_proposals WHERE id = ?1').bind(id));
}

export function findPendingProposal(db: D1Database, versionId: string, weekday: number, period: number): Promise<ScheduleProposalRow | null> {
  return firstOrNull<ScheduleProposalRow>(
    db
      .prepare("SELECT * FROM schedule_proposals WHERE version_id = ?1 AND weekday = ?2 AND period = ?3 AND status = 'PENDING' LIMIT 1")
      .bind(versionId, weekday, period),
  );
}

export function listProposals(db: D1Database, groupId: string, status?: string): Promise<ScheduleProposalRow[]> {
  return allRows<ScheduleProposalRow>(
    status
      ? db
          .prepare('SELECT * FROM schedule_proposals WHERE group_id = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT 50')
          .bind(groupId, status)
      : db.prepare('SELECT * FROM schedule_proposals WHERE group_id = ?1 ORDER BY created_at DESC LIMIT 50').bind(groupId),
  );
}

export async function updateProposalCounts(
  db: D1Database,
  id: string,
  counts: { approve: number; reject: number; eligible: number },
): Promise<void> {
  await db
    .prepare('UPDATE schedule_proposals SET approve_count = ?1, reject_count = ?2, eligible_count = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(counts.approve, counts.reject, counts.eligible, new Date().toISOString(), id)
    .run();
}

export async function markProposalDecided(db: D1Database, id: string, status: 'APPROVED' | 'REJECTED' | 'WITHDRAWN', decidedBy: string | null, now: string): Promise<void> {
  await db
    .prepare('UPDATE schedule_proposals SET status = ?1, decided_by = ?2, decided_at = ?3, updated_at = ?3 WHERE id = ?4')
    .bind(status, decidedBy, now, id)
    .run();
}

export async function markProposalApplied(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare('UPDATE schedule_proposals SET applied_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, id).run();
}
