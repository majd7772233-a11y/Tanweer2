/**
 * Community decisions (§61, §62, §29, §59).
 *
 * Thresholds
 *   DELETION   unanimous   — every eligible member approves, one refusal ends it
 *   CORRECTION majority    — more than half of the eligible members
 *   SCHEDULE   quarter     — a quarter of the eligible members and more
 *                            approvals than refusals
 * There is no "auto delete because time passed".
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import {
  decideCorrectionRequest,
  decideDeletionRequest,
  findCorrectionRequest,
  findDeletionRequest,
  listCorrectionRequests,
  listDeletionRequests,
  listVotes,
  updateCorrectionCounts,
  updateDeletionCounts,
  upsertVote,
  voteCounts,
  type RequestStatus,
  type VoteTarget,
} from '../db/queries/votes';
import { eligibleVoters } from '../db/queries/groups';
import { loadGroupAccess } from '../middleware/permissions';
import { insertRevision, setContentStatus } from '../db/queries/content';
import { findProposal, markProposalApplied, markProposalDecided, updateProposalCounts } from '../db/queries/schedule';
import { notifyUsers } from './notifications';

const voteSchema = V.object({
  targetType: V.oneOf(['DELETION', 'CORRECTION', 'SCHEDULE_PROPOSAL'] as const),
  targetId: V.string({ min: 4, max: 80 }),
  value: V.oneOf(['APPROVE', 'REJECT', 'ABSTAIN'] as const),
  comment: V.optional(V.string({ max: 300 })),
});

export async function castVote(ctx: Ctx) {
  const input = await ctx.require(voteSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  const context = await resolveTargetContext(db, input.targetType, input.targetId);
  if (!context) throw new ApiError('NOT_FOUND', 'الطلب غير موجود.');
  if (context.status !== 'PENDING') throw new ApiError('PROPOSAL_ALREADY_DECIDED');

  const access = await loadGroupAccess(ctx, context.groupId);
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');
  if ((access.membership?.can_vote ?? 0) !== 1) throw new ApiError('VOTE_NOT_ALLOWED');

  await upsertVote(db, {
    id: newId('vote'),
    targetType: input.targetType,
    targetId: input.targetId,
    userId: user.id,
    value: input.value,
    comment: input.comment ?? null,
    now: ctx.now,
  });

  const counts = await voteCounts(db, input.targetType, input.targetId);
  const voters = await eligibleVoters(db, context.groupId);
  const eligible = voters.length;

  if (input.targetType === 'DELETION') {
    await updateDeletionCounts(db, input.targetId, { approve: counts.approve, reject: counts.reject, eligible }, ctx.now);
  } else if (input.targetType === 'CORRECTION') {
    await updateCorrectionCounts(db, input.targetId, { approve: counts.approve, reject: counts.reject, eligible }, ctx.now);
  } else {
    await updateProposalCounts(db, input.targetId, { approve: counts.approve, reject: counts.reject, eligible });
  }

  const decision = evaluate(input.targetType, counts, eligible);
  if (decision === 'APPROVED') {
    await applyApproved(ctx, input.targetType, input.targetId, context.groupId);
  } else if (decision === 'REJECTED') {
    await markRejected(ctx, input.targetType, input.targetId, context.groupId);
  }

  const fresh = await voteCounts(db, input.targetType, input.targetId);
  return {
    counts: { approve: fresh.approve, reject: fresh.reject, eligible, remaining: Math.max(0, eligible - fresh.total) },
    decision,
  };
}

export type Decision = 'PENDING' | 'APPROVED' | 'REJECTED';

export function evaluate(
  targetType: VoteTarget,
  counts: { approve: number; reject: number; total: number },
  eligible: number,
): Decision {
  const { approve, reject } = counts;
  if (eligible <= 0) return 'PENDING';

  if (targetType === 'DELETION') {
    // One refusal keeps the content, forever (§61).
    if (reject > 0) return 'REJECTED';
    if (approve >= eligible) return 'APPROVED';
    return 'PENDING';
  }

  if (targetType === 'CORRECTION') {
    const threshold = Math.max(1, Math.floor(eligible / 2) + (eligible > 1 ? 1 : 0));
    if (approve >= threshold) return 'APPROVED';
    if (reject >= threshold) return 'REJECTED';
    return 'PENDING';
  }

  // SCHEDULE_PROPOSAL
  const threshold = Math.max(1, Math.ceil(eligible / 4));
  if (approve >= threshold && approve > reject) return 'APPROVED';
  if (reject >= threshold && reject >= approve) return 'REJECTED';
  return 'PENDING';
}

interface TargetContext {
  groupId: string;
  status: RequestStatus | string;
  entityType?: string;
  entityId?: string;
  field?: string;
  proposedValue?: string;
}

async function resolveTargetContext(db: D1Database, targetType: VoteTarget, targetId: string): Promise<TargetContext | null> {
  if (targetType === 'DELETION') {
    const row = await findDeletionRequest(db, targetId);
    if (!row) return null;
    return { groupId: row.group_id, status: row.status, entityType: row.entity_type, entityId: row.entity_id };
  }
  if (targetType === 'CORRECTION') {
    const row = await findCorrectionRequest(db, targetId);
    if (!row) return null;
    return {
      groupId: row.group_id,
      status: row.status,
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field,
      proposedValue: row.proposed_value,
    };
  }
  const proposal = await findProposal(db, targetId);
  if (!proposal) return null;
  return { groupId: proposal.group_id, status: proposal.status };
}

async function currentFieldValue(db: D1Database, entityType: string, entityId: string, field: string): Promise<string | null> {
  const table = entityType === 'CONTENT' ? 'content' : entityType === 'HOMEWORK' ? 'homeworks' : entityType === 'EXAM' ? 'exams' : entityType === 'EVENT' ? 'events' : 'issues';
  const allowed = ['study_date', 'subject_id', 'section_scope', 'title', 'exam_date', 'due_date', 'event_date'];
  if (!allowed.includes(field)) return null;
  const row = await db.prepare(`SELECT ${field} AS value FROM ${table} WHERE id = ?1`).bind(entityId).first<{ value: string | number | null }>();
  return row?.value === null || row?.value === undefined ? null : String(row.value);
}

async function applyApproved(ctx: Ctx, targetType: VoteTarget, targetId: string, groupId: string): Promise<void> {
  const db = ctx.env.TANWEER_DB;

  if (targetType === 'DELETION') {
    const request = await findDeletionRequest(db, targetId);
    if (!request || request.status !== 'PENDING') return;
    await decideDeletionRequest(db, targetId, 'APPROVED', ctx.user?.id ?? null, ctx.now, true);
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000).toISOString();
    if (request.entity_type === 'CONTENT') {
      await setContentStatus(db, request.entity_id, 'DELETED', ctx.now, purgeAfter);
      await db.prepare("UPDATE content_media SET deleted_at = ?1 WHERE content_id = ?2").bind(ctx.now, request.entity_id).run();
    } else {
      const table = request.entity_type === 'HOMEWORK' ? 'homeworks' : request.entity_type === 'EXAM' ? 'exams' : request.entity_type === 'EVENT' ? 'events' : 'comments';
      await db.prepare(`UPDATE ${table} SET status = 'DELETED', updated_at = ?1 WHERE id = ?2`).bind(ctx.now, request.entity_id).run();
    }
    await insertRevision(db, {
      id: newId('crev'),
      entityType: request.entity_type === 'COMMENT' ? 'ISSUE' : request.entity_type,
      entityId: request.entity_id,
      revision: 9999,
      action: 'DELETED_BY_COMMUNITY',
      snapshot: { requestId: targetId },
      reason: request.reason,
      requestId: targetId,
      changedBy: ctx.user?.id ?? 'system',
      now: ctx.now,
    });
    audit(ctx, { action: 'deletion.approved', entityType: request.entity_type, entityId: request.entity_id, groupId, meta: { requestId: targetId } });
    await notifyUsers(ctx, [request.requested_by], {
      kind: 'CONTRIBUTION',
      title: '🗑 تمت الموافقة على الإزالة',
      body: 'وافق جميع الأعضاء المؤهلين على إزالة المحتوى.',
      groupId,
      entityType: request.entity_type,
      entityId: request.entity_id,
      batchKey: `deletion-decided:${request.entity_id}`,
      priority: 'NORMAL',
    });
    return;
  }

  if (targetType === 'CORRECTION') {
    const request = await findCorrectionRequest(db, targetId);
    if (!request || request.status !== 'PENDING') return;
    const previous = await currentFieldValue(db, request.entity_type, request.entity_id, request.field);
    await decideCorrectionRequest(db, targetId, 'APPROVED', ctx.user?.id ?? null, ctx.now, true);

    const table = request.entity_type === 'CONTENT' ? 'content' : request.entity_type === 'HOMEWORK' ? 'homeworks' : request.entity_type === 'EXAM' ? 'exams' : request.entity_type === 'EVENT' ? 'events' : 'issues';
    const column = request.field;
    const allowed = ['study_date', 'subject_id', 'section_scope', 'title', 'exam_date', 'due_date', 'event_date'];
    if (allowed.includes(column)) {
      const value = column === 'subject_id' ? Number.parseInt(request.proposed_value, 10) : request.proposed_value;
      await db.prepare(`UPDATE ${table} SET ${column} = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3`).bind(value, ctx.now, request.entity_id).run();
    }
    await insertRevision(db, {
      id: newId('crev'),
      entityType: request.entity_type,
      entityId: request.entity_id,
      revision: 9998,
      action: 'CORRECTED_BY_COMMUNITY',
      snapshot: { field: column, from: previous, to: request.proposed_value },
      diff: { [column]: [previous, request.proposed_value] },
      reason: request.reason,
      requestId: targetId,
      changedBy: ctx.user?.id ?? 'system',
      now: ctx.now,
    });
    audit(ctx, { action: 'correction.approved', entityType: request.entity_type, entityId: request.entity_id, groupId, meta: { field: column } });
    await notifyUsers(ctx, [request.requested_by], {
      kind: 'CONTRIBUTION',
      title: '✅ تم اعتماد تصحيحك',
      body: request.reason.slice(0, 120),
      groupId,
      entityType: request.entity_type,
      entityId: request.entity_id,
      batchKey: `correction-decided:${request.entity_id}`,
      priority: 'NORMAL',
    });
    return;
  }

  // SCHEDULE_PROPOSAL → apply the timetable change (§29)
  const proposal = await findProposal(db, targetId);
  if (!proposal || proposal.status !== 'PENDING') return;
  await markProposalDecided(db, targetId, 'APPROVED', ctx.user?.id ?? null, ctx.now);
  const { upsertSlot, deleteSlot } = await import('../db/queries/schedule');
  if (proposal.kind === 'REMOVE') {
    await deleteSlot(db, proposal.version_id, proposal.weekday, proposal.period);
  } else if (proposal.proposed_subject_id !== null) {
    await upsertSlot(db, {
      id: newId('slot'),
      versionId: proposal.version_id,
      groupId: proposal.group_id,
      weekday: proposal.weekday,
      period: proposal.period,
      subjectId: proposal.proposed_subject_id,
      room: null,
      notes: `تعديل مجتمعي: ${proposal.reason.slice(0, 80)}`,
      createdBy: proposal.proposed_by,
      now: ctx.now,
    });
  }
  await markProposalApplied(db, targetId, ctx.now);
  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'SCHEDULE',
    entityId: proposal.version_id,
    revision: proposal.period,
    action: 'SCHEDULE_CHANGED',
    snapshot: { weekday: proposal.weekday, period: proposal.period, subjectId: proposal.proposed_subject_id },
    reason: proposal.reason,
    requestId: targetId,
    changedBy: ctx.user?.id ?? 'system',
    now: ctx.now,
  });
  audit(ctx, { action: 'schedule.proposal.approved', entityType: 'SCHEDULE', entityId: proposal.version_id, groupId, meta: { proposalId: targetId } });
  await notifyUsers(ctx, [proposal.proposed_by], {
    kind: 'SCHEDULE',
    title: '📅 تم اعتماد تعديل الجدول',
    body: proposal.reason.slice(0, 120),
    groupId,
    entityType: 'SCHEDULE',
    entityId: proposal.version_id,
    batchKey: `schedule-decided:${proposal.id}`,
    priority: 'NORMAL',
  });
}

async function markRejected(ctx: Ctx, targetType: VoteTarget, targetId: string, groupId: string): Promise<void> {
  const db = ctx.env.TANWEER_DB;
  if (targetType === 'DELETION') {
    const request = await findDeletionRequest(db, targetId);
    if (!request || request.status !== 'PENDING') return;
    await decideDeletionRequest(db, targetId, 'REJECTED', ctx.user?.id ?? null, ctx.now);
    if (request.entity_type === 'CONTENT') {
      await setContentStatus(db, request.entity_id, 'PUBLISHED', ctx.now);
    } else {
      const table = request.entity_type === 'HOMEWORK' ? 'homeworks' : request.entity_type === 'EXAM' ? 'exams' : request.entity_type === 'EVENT' ? 'events' : 'comments';
      await db.prepare(`UPDATE ${table} SET status = 'PUBLISHED', updated_at = ?1 WHERE id = ?2`).bind(ctx.now, request.entity_id).run();
    }
    audit(ctx, { action: 'deletion.rejected', entityType: request.entity_type, entityId: request.entity_id, groupId, meta: { requestId: targetId } });
    await notifyUsers(ctx, [request.requested_by], {
      kind: 'CONTRIBUTION',
      title: '❌ لم تتم الموافقة على الإزالة',
      body: 'رفض أحد الأعضاء الإزالة، لذلك بقي المحتوى.',
      groupId,
      entityType: request.entity_type,
      entityId: request.entity_id,
      batchKey: `deletion-decided:${request.entity_id}`,
      priority: 'NORMAL',
    });
    return;
  }

  if (targetType === 'CORRECTION') {
    const request = await findCorrectionRequest(db, targetId);
    if (!request || request.status !== 'PENDING') return;
    await decideCorrectionRequest(db, targetId, 'REJECTED', ctx.user?.id ?? null, ctx.now);
    audit(ctx, { action: 'correction.rejected', entityType: request.entity_type, entityId: request.entity_id, groupId, meta: { requestId: targetId } });
    return;
  }

  const proposal = await findProposal(db, targetId);
  if (!proposal || proposal.status !== 'PENDING') return;
  await markProposalDecided(db, targetId, 'REJECTED', ctx.user?.id ?? null, ctx.now);
  audit(ctx, { action: 'schedule.proposal.rejected', entityType: 'SCHEDULE', entityId: proposal.version_id, groupId, meta: { proposalId: targetId } });
}

/** Open community decisions for one group (the "المجتمع يصحح نفسه" screen). */
export async function openRequests(ctx: Ctx, groupId: string) {
  const access = await loadGroupAccess(ctx, groupId);
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');
  const db = ctx.env.TANWEER_DB;
  const [deletions, corrections] = await Promise.all([listDeletionRequests(db, groupId), listCorrectionRequests(db, groupId)]);
  const mapWithVotes = async (items: Array<{ id: string; group_id: string; entity_type: string; entity_id: string; reason: string; approve_count: number; reject_count: number; eligible_count: number; requested_by: string; created_at: string; requester_name?: string }>) =>
    Promise.all(
      items.map(async (item) => {
        const [counts, votes] = await Promise.all([voteCounts(db, 'DELETION', item.id), listVotes(db, 'DELETION', item.id, 20)]);
        return {
          id: item.id,
          entityType: item.entity_type,
          entityId: item.entity_id,
          reason: item.reason,
          approveCount: counts.approve,
          rejectCount: counts.reject,
          eligibleCount: item.eligible_count,
          remaining: Math.max(0, item.eligible_count - counts.total),
          requestedBy: item.requested_by,
          requesterName: item.requester_name ?? '',
          createdAt: item.created_at,
          votes: votes.map((vote) => ({ userId: vote.user_id, userName: vote.user_name ?? '', value: vote.value, comment: vote.comment })),
        };
      }),
    );

  return {
    deletions: await mapWithVotes(deletions),
    corrections: corrections.map((item) => ({
      id: item.id,
      entityType: item.entity_type,
      entityId: item.entity_id,
      field: item.field,
      currentValue: item.current_value,
      proposedValue: item.proposed_value,
      reason: item.reason,
      approveCount: item.approve_count,
      rejectCount: item.reject_count,
      eligibleCount: item.eligible_count,
      requestedBy: item.requested_by,
      requesterName: item.requester_name ?? '',
      createdAt: item.created_at,
    })),
    myVoteRights: {
      canVote: (access.membership?.can_vote ?? 0) === 1,
      eligible: (await eligibleVoters(db, groupId)).length,
    },
  };
}

export async function withdrawRequest(ctx: Ctx, requestId: string, kind: 'DELETION' | 'CORRECTION') {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  if (kind === 'DELETION') {
    const request = await findDeletionRequest(db, requestId);
    if (!request) throw new ApiError('NOT_FOUND');
    if (request.requested_by !== user.id) throw new ApiError('FORBIDDEN');
    await decideDeletionRequest(db, requestId, 'WITHDRAWN', user.id, ctx.now);
    if (request.entity_type === 'CONTENT') await setContentStatus(db, request.entity_id, 'PUBLISHED', ctx.now);
    return { withdrawn: true };
  }
  const request = await findCorrectionRequest(db, requestId);
  if (!request) throw new ApiError('NOT_FOUND');
  if (request.requested_by !== user.id) throw new ApiError('FORBIDDEN');
  await decideCorrectionRequest(db, requestId, 'WITHDRAWN', user.id, ctx.now);
  return { withdrawn: true };
}

/** Pending requests the student themselves opened. */
export async function myOpenRequests(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const rows = await db
    .prepare(
      `SELECT 'DELETION' AS kind, id, group_id, entity_type, entity_id, status, created_at FROM deletion_requests WHERE requested_by = ?1 AND status = 'PENDING'
       UNION ALL
       SELECT 'CORRECTION' AS kind, id, group_id, entity_type, entity_id, status, created_at FROM correction_requests WHERE requested_by = ?1 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(user.id)
    .all();
  return rows.results ?? [];
}
