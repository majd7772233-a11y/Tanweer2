/**
 * Community decisions: votes, correction requests and deletion requests.
 *
 * The rules (§61, §62 — see docs/GOVERNANCE.md):
 *   DELETION   every eligible member must approve, one refusal keeps the content
 *   CORRECTION a majority of eligible members is enough
 *   SCHEDULE   a quarter of eligible members and more approvals than refusals
 * Nothing is ever decided by a timeout.
 */
import { allRows, firstOrNull } from './shared';

export type VoteTarget = 'DELETION' | 'CORRECTION' | 'SCHEDULE_PROPOSAL' | 'TEACHER_NOMINATION';
export type VoteValue = 'APPROVE' | 'REJECT' | 'ABSTAIN';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface VoteRow {
  id: string;
  target_type: VoteTarget;
  target_id: string;
  user_id: string;
  value: VoteValue;
  comment: string | null;
  created_at: string;
  updated_at: string;
  user_name?: string;
}

export interface CorrectionRequestRow {
  id: string;
  group_id: string;
  entity_type: string;
  entity_id: string;
  field: string;
  current_value: string | null;
  proposed_value: string;
  reason: string;
  status: RequestStatus;
  approve_count: number;
  reject_count: number;
  eligible_count: number;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string;
}

export interface DeletionRequestRow {
  id: string;
  group_id: string;
  entity_type: string;
  entity_id: string;
  reason: string;
  status: RequestStatus;
  approve_count: number;
  reject_count: number;
  eligible_count: number;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string;
}

export async function upsertVote(
  db: D1Database,
  input: { id: string; targetType: VoteTarget; targetId: string; userId: string; value: VoteValue; comment: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO votes (id, target_type, target_id, user_id, value, comment, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (target_type, target_id, user_id) DO UPDATE SET value = excluded.value, comment = excluded.comment, updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.targetType, input.targetId, input.userId, input.value, input.comment, input.now)
    .run();
}

export async function voteCounts(db: D1Database, targetType: VoteTarget, targetId: string): Promise<{ approve: number; reject: number; abstain: number; total: number }> {
  const row = await firstOrNull<{ approve: number; reject: number; abstain: number; total: number }>(
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN value = 'APPROVE' THEN 1 ELSE 0 END) AS approve,
           SUM(CASE WHEN value = 'REJECT' THEN 1 ELSE 0 END) AS reject,
           SUM(CASE WHEN value = 'ABSTAIN' THEN 1 ELSE 0 END) AS abstain,
           COUNT(*) AS total
         FROM votes WHERE target_type = ?1 AND target_id = ?2`,
      )
      .bind(targetType, targetId),
  );
  return {
    approve: Number(row?.approve ?? 0),
    reject: Number(row?.reject ?? 0),
    abstain: Number(row?.abstain ?? 0),
    total: Number(row?.total ?? 0),
  };
}

export function listVotes(db: D1Database, targetType: VoteTarget, targetId: string, limit = 300): Promise<VoteRow[]> {
  return allRows<VoteRow>(
    db
      .prepare(
        `SELECT v.*, u.full_name AS user_name FROM votes v JOIN users u ON u.id = v.user_id
          WHERE v.target_type = ?1 AND v.target_id = ?2
          ORDER BY v.updated_at DESC LIMIT ?3`,
      )
      .bind(targetType, targetId, limit),
  );
}

export function findVote(db: D1Database, targetType: VoteTarget, targetId: string, userId: string): Promise<VoteRow | null> {
  return firstOrNull<VoteRow>(
    db.prepare('SELECT * FROM votes WHERE target_type = ?1 AND target_id = ?2 AND user_id = ?3').bind(targetType, targetId, userId),
  );
}

// ── correction requests ──────────────────────────────────────────────────────

const CORRECTION_SELECT = `SELECT r.*, u.full_name AS requester_name FROM correction_requests r JOIN users u ON u.id = r.requested_by`;

export async function insertCorrectionRequest(
  db: D1Database,
  input: {
    id: string;
    groupId: string;
    entityType: string;
    entityId: string;
    field: string;
    currentValue: string | null;
    proposedValue: string;
    reason: string;
    eligibleCount: number;
    requestedBy: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO correction_requests (id, group_id, entity_type, entity_id, field, current_value, proposed_value, reason,
                                        status, approve_count, reject_count, eligible_count, requested_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING', 0, 0, ?9, ?10, ?11, ?11)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.entityType,
      input.entityId,
      input.field,
      input.currentValue,
      input.proposedValue,
      input.reason,
      input.eligibleCount,
      input.requestedBy,
      input.now,
    )
    .run();
}

export function findCorrectionRequest(db: D1Database, id: string): Promise<CorrectionRequestRow | null> {
  return firstOrNull<CorrectionRequestRow>(db.prepare(`${CORRECTION_SELECT} WHERE r.id = ?1`).bind(id));
}

export function findPendingCorrection(db: D1Database, entityType: string, entityId: string, field?: string): Promise<CorrectionRequestRow | null> {
  const statement = field
    ? db
        .prepare(`${CORRECTION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 AND r.field = ?3 AND r.status = 'PENDING' LIMIT 1`)
        .bind(entityType, entityId, field)
    : db
        .prepare(`${CORRECTION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 AND r.status = 'PENDING' LIMIT 1`)
        .bind(entityType, entityId);
  return firstOrNull<CorrectionRequestRow>(statement);
}

export function listCorrectionRequests(db: D1Database, groupId: string, status = 'PENDING', limit = 50): Promise<CorrectionRequestRow[]> {
  return allRows<CorrectionRequestRow>(
    db
      .prepare(`${CORRECTION_SELECT} WHERE r.group_id = ?1 AND r.status = ?2 ORDER BY r.created_at DESC LIMIT ?3`)
      .bind(groupId, status, limit),
  );
}

export function listCorrectionsForEntity(db: D1Database, entityType: string, entityId: string): Promise<CorrectionRequestRow[]> {
  return allRows<CorrectionRequestRow>(
    db.prepare(`${CORRECTION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 ORDER BY r.created_at DESC LIMIT 20`).bind(entityType, entityId),
  );
}

export async function updateCorrectionCounts(db: D1Database, id: string, counts: { approve: number; reject: number; eligible: number }, now: string): Promise<void> {
  await db
    .prepare('UPDATE correction_requests SET approve_count = ?1, reject_count = ?2, eligible_count = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(counts.approve, counts.reject, counts.eligible, now, id)
    .run();
}

export async function decideCorrectionRequest(
  db: D1Database,
  id: string,
  status: RequestStatus,
  decidedBy: string | null,
  now: string,
  applied = false,
): Promise<void> {
  await db
    .prepare('UPDATE correction_requests SET status = ?1, decided_by = ?2, decided_at = ?3, applied_at = ?4, updated_at = ?3 WHERE id = ?5')
    .bind(status, decidedBy, now, applied ? now : null, id)
    .run();
}

// ── deletion requests ────────────────────────────────────────────────────────

const DELETION_SELECT = `SELECT r.*, u.full_name AS requester_name FROM deletion_requests r JOIN users u ON u.id = r.requested_by`;

export async function insertDeletionRequest(
  db: D1Database,
  input: { id: string; groupId: string; entityType: string; entityId: string; reason: string; eligibleCount: number; requestedBy: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deletion_requests (id, group_id, entity_type, entity_id, reason, status, approve_count, reject_count,
                                      eligible_count, requested_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', 0, 0, ?6, ?7, ?8, ?8)`,
    )
    .bind(input.id, input.groupId, input.entityType, input.entityId, input.reason, input.eligibleCount, input.requestedBy, input.now)
    .run();
}

export function findDeletionRequest(db: D1Database, id: string): Promise<DeletionRequestRow | null> {
  return firstOrNull<DeletionRequestRow>(db.prepare(`${DELETION_SELECT} WHERE r.id = ?1`).bind(id));
}

export function findPendingDeletion(db: D1Database, entityType: string, entityId: string): Promise<DeletionRequestRow | null> {
  return firstOrNull<DeletionRequestRow>(
    db.prepare(`${DELETION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 AND r.status = 'PENDING' LIMIT 1`).bind(entityType, entityId),
  );
}

export function listDeletionRequests(db: D1Database, groupId: string, status = 'PENDING', limit = 50): Promise<DeletionRequestRow[]> {
  return allRows<DeletionRequestRow>(
    db
      .prepare(`${DELETION_SELECT} WHERE r.group_id = ?1 AND r.status = ?2 ORDER BY r.created_at DESC LIMIT ?3`)
      .bind(groupId, status, limit),
  );
}

export function listDeletionsForEntity(db: D1Database, entityType: string, entityId: string): Promise<DeletionRequestRow[]> {
  return allRows<DeletionRequestRow>(
    db.prepare(`${DELETION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 ORDER BY r.created_at DESC LIMIT 20`).bind(entityType, entityId),
  );
}

export async function updateDeletionCounts(db: D1Database, id: string, counts: { approve: number; reject: number; eligible: number }, now: string): Promise<void> {
  await db
    .prepare('UPDATE deletion_requests SET approve_count = ?1, reject_count = ?2, eligible_count = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(counts.approve, counts.reject, counts.eligible, now, id)
    .run();
}

export async function decideDeletionRequest(
  db: D1Database,
  id: string,
  status: RequestStatus,
  decidedBy: string | null,
  now: string,
  applied = false,
): Promise<void> {
  await db
    .prepare('UPDATE deletion_requests SET status = ?1, decided_by = ?2, decided_at = ?3, applied_at = ?4, updated_at = ?3 WHERE id = ?5')
    .bind(status, decidedBy, now, applied ? now : null, id)
    .run();
}

/** Open community requests on one piece of content, for the detail screen. */
export async function openRequestsFor(db: D1Database, entityType: string, entityId: string) {
  const [deletions, corrections] = await db.batch([
    db.prepare(`${DELETION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 AND r.status = 'PENDING' ORDER BY r.created_at DESC LIMIT 5`).bind(entityType, entityId),
    db.prepare(`${CORRECTION_SELECT} WHERE r.entity_type = ?1 AND r.entity_id = ?2 AND r.status = 'PENDING' ORDER BY r.created_at DESC LIMIT 5`).bind(entityType, entityId),
  ]);
  return {
    deletions: (deletions?.results ?? []) as DeletionRequestRow[],
    corrections: (corrections?.results ?? []) as CorrectionRequestRow[],
  };
}

// ── teacher nominations (§59) ────────────────────────────────────────────────
export async function insertTeacherNomination(
  db: D1Database,
  input: {
    id: string;
    groupId: string;
    subjectId: number | null;
    nomineeName: string;
    nomineeUserId: string | null;
    reason: string;
    eligibleCount: number;
    votingEndsAt: string | null;
    nominatedBy: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO teacher_nominations (id, group_id, subject_id, nominee_name, nominee_user_id, reason, status,
                                        approve_count, reject_count, eligible_count, voting_ends_at, nominated_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING_NOMINEE', 0, 0, ?7, ?8, ?9, ?10, ?10)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.subjectId,
      input.nomineeName,
      input.nomineeUserId,
      input.reason,
      input.eligibleCount,
      input.votingEndsAt,
      input.nominatedBy,
      input.now,
    )
    .run();
}
