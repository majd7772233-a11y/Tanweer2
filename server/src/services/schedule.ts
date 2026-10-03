/**
 * جدول الحصص (§27 → §29).
 *
 * Filling an empty period is a direct edit: that is how a brand-new timetable
 * gets built by the community. Replacing a period that already has a subject
 * needs a proposal that the group votes on, and the old days keep pointing at
 * the version that was in force back then.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import {
  findActiveVersion,
  findPendingProposal,
  findProposal,
  findSlot,
  findVersionById,
  findVersionForDate,
  insertProposal,
  listProposals,
  listSlots,
  markProposalDecided,
  upsertSlot,
} from '../db/queries/schedule';
import { eligibleVoters } from '../db/queries/groups';
import { requireMembership } from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { loadGroupAccess } from '../middleware/permissions';
import { slotDto, weekSchedule, scheduleVersionsFor } from './calendar';
import { defaultGroupIdFor } from './groups';
import { notifyUsers } from './notifications';
import { localMinutes, WEEKDAYS } from '../lib/date';

export { weekSchedule, scheduleVersionsFor };

/** GET /schedule?groupId&date= — either a single day or a whole week. */
export async function getSchedule(ctx: Ctx) {
  const groupId = ctx.q('groupId') ?? (await defaultGroupIdFor(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const date = ctx.q('date') ?? ctx.today;
  const access = await requireMembership(ctx, groupId);
  const version = await findVersionForDate(ctx.env.TANWEER_DB, groupId, date);

  if (!version) {
    return {
      date,
      version: null,
      day: { weekday: null, slots: [] },
      week: { days: [] },
      canEdit: access.isMember,
      mySection: access.group.kind === 'SHARED' ? user.sectionCode : null,
    };
  }

  const week = await weekSchedule(ctx, groupId, date);
  const weekday = (await import('../lib/date')).weekdayOf(date);
  return {
    date,
    weekday,
    version: week.version,
    day: { weekday, slots: week.days.find((day) => day.weekday === weekday)?.slots ?? [] },
    week,
    canEdit: access.isMember,
    mySection: access.group.kind === 'SHARED' ? user.sectionCode : null,
  };
}

const fillSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  weekday: V.number({ min: 0, max: 6 }),
  period: V.number({ min: 1, max: 12 }),
  subjectId: V.number({ min: 1, max: 999 }),
  room: V.optional(V.string({ max: 40 })),
  date: V.optional(V.isoDate()),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

/** Filling an empty period — allowed for any member, no vote needed. */
export async function fillPeriod(ctx: Ctx) {
  const input = await ctx.require(fillSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);

  const date = input.date ?? ctx.today;
  const version = (await findVersionForDate(db, input.groupId, date)) ?? (await findActiveVersion(db, input.groupId));
  if (!version) throw new ApiError('SCHEDULE_NOT_FOUND', 'لا يوجد جدول لهذه المجموعة.');

  const existing = await findSlot(db, version.id, input.weekday, input.period);
  if (existing) {
    throw new ApiError('SLOT_ALREADY_FILLED', `${WEEKDAYS[input.weekday]} — الحصة ${input.period} فيها مادة بالفعل. أرسل اقتراح تعديل.`);
  }

  const academicYear = await findActiveAcademicYear(db);
  void academicYear;

  await upsertSlot(db, {
    id: newId('slot'),
    versionId: version.id,
    groupId: input.groupId,
    weekday: input.weekday,
    period: input.period,
    subjectId: input.subjectId,
    room: input.room ?? null,
    notes: null,
    createdBy: user.id,
    now: ctx.now,
  });

  audit(ctx, {
    action: 'schedule.filled',
    entityType: 'SCHEDULE',
    entityId: version.id,
    groupId: input.groupId,
    meta: { weekday: input.weekday, period: input.period, subjectId: input.subjectId },
  });

  return getSchedule(ctx);
}

const proposalSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  weekday: V.number({ min: 0, max: 6 }),
  period: V.number({ min: 1, max: 12 }),
  proposedSubjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  kind: V.withDefault(V.oneOf(['CHANGE', 'REMOVE'] as const), 'CHANGE'),
  reason: V.string({ min: 5, max: 400 }),
  date: V.optional(V.isoDate()),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

/** Changing an existing period — needs the community (§29). */
export async function proposeChange(ctx: Ctx) {
  const input = await ctx.require(proposalSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  await requireMembership(ctx, input.groupId);

  const date = input.date ?? ctx.today;
  const version = (await findVersionForDate(db, input.groupId, date)) ?? (await findActiveVersion(db, input.groupId));
  if (!version) throw new ApiError('SCHEDULE_NOT_FOUND');

  const current = await findSlot(db, version.id, input.weekday, input.period);
  if (!current) {
    throw new ApiError('SLOT_NOT_FOUND', 'الحصة فارغة — يمكنك تعبئتها مباشرة.');
  }
  const pending = await findPendingProposal(db, version.id, input.weekday, input.period);
  if (pending) throw new ApiError('DUPLICATE_REQUEST', 'يوجد اقتراح قيد التصويت على هذه الحصة.');

  if (input.kind === 'CHANGE' && !input.proposedSubjectId) {
    throw new ApiError('VALIDATION_ERROR', 'حدد المادة المقترحة.');
  }
  if (input.proposedSubjectId === current.subject_id) {
    throw new ApiError('VALIDATION_ERROR', 'المادة المقترحة هي نفسها الحالية.');
  }

  const voters = await eligibleVoters(db, input.groupId);
  const id = newId('sprp');
  await insertProposal(db, {
    id,
    group_id: input.groupId,
    version_id: version.id,
    weekday: input.weekday,
    period: input.period,
    current_subject_id: current.subject_id,
    proposed_subject_id: input.proposedSubjectId ?? null,
    kind: input.kind,
    reason: input.reason,
    proposed_by: user.id,
    status: 'PENDING',
    approve_count: 0,
    reject_count: 0,
    eligible_count: voters.length,
    decided_at: null,
    decided_by: null,
    applied_at: null,
    created_at: ctx.now,
    updated_at: ctx.now,
  });

  await notifyUsers(ctx, voters.filter((voter) => voter !== user.id), {
    kind: 'SCHEDULE',
    title: '🔄 اقتراح تعديل الجدول',
    body: `${WEEKDAYS[input.weekday]} — الحصة ${input.period}: ${input.reason.slice(0, 100)}`,
    groupId: input.groupId,
    entityType: 'SCHEDULE',
    entityId: version.id,
    deepLink: `tanweer://schedule/proposal/${id}`,
    batchKey: `schedule:${version.id}:${input.weekday}:${input.period}`,
    priority: 'NORMAL',
  });

  audit(ctx, { action: 'schedule.proposed', entityType: 'SCHEDULE', entityId: version.id, groupId: input.groupId, meta: { proposalId: id } });
  const proposal = await findProposal(db, id);
  return proposalDto(proposal, current);
}

function proposalDto(
  proposal: Awaited<ReturnType<typeof findProposal>>,
  current?: { subject_id: number; room: string | null } | null,
) {
  if (!proposal) throw new ApiError('PROPOSAL_NOT_FOUND');
  return {
    id: proposal.id,
    groupId: proposal.group_id,
    versionId: proposal.version_id,
    weekday: proposal.weekday,
    weekdayName: WEEKDAYS[proposal.weekday] ?? '',
    period: proposal.period,
    kind: proposal.kind,
    currentSubjectId: proposal.current_subject_id ?? current?.subject_id ?? null,
    proposedSubjectId: proposal.proposed_subject_id,
    reason: proposal.reason,
    status: proposal.status,
    approveCount: proposal.approve_count,
    rejectCount: proposal.reject_count,
    eligibleCount: proposal.eligible_count,
    remaining: Math.max(0, proposal.eligible_count - proposal.approve_count - proposal.reject_count),
    proposedBy: proposal.proposed_by,
    createdAt: proposal.created_at,
    decidedAt: proposal.decided_at,
  };
}

export async function listProposalsForGroup(ctx: Ctx, groupId: string) {
  const status = ctx.q('status') ?? 'PENDING';
  const rows = await listProposals(ctx.env.TANWEER_DB, groupId, status === 'all' ? undefined : status);
  return rows.map((row) => proposalDto(row));
}

export async function proposalDetail(ctx: Ctx, proposalId: string) {
  const row = await findProposal(ctx.env.TANWEER_DB, proposalId);
  if (!row) throw new ApiError('PROPOSAL_NOT_FOUND');
  await requireMembership(ctx, row.group_id);
  const version = await findVersionById(ctx.env.TANWEER_DB, row.version_id);
  const slots = version ? await listSlots(ctx.env.TANWEER_DB, version.id, row.weekday) : [];
  return {
    proposal: proposalDto(row),
    currentSlot: slots.find((slot) => slot.period === row.period) ? slotDto(slots.find((slot) => slot.period === row.period)!) : null,
  };
}

export async function withdrawProposal(ctx: Ctx, proposalId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const row = await findProposal(ctx.env.TANWEER_DB, proposalId);
  if (!row) throw new ApiError('PROPOSAL_NOT_FOUND');
  if (row.proposed_by !== user.id) throw new ApiError('FORBIDDEN');
  if (row.status !== 'PENDING') throw new ApiError('PROPOSAL_ALREADY_DECIDED');
  await markProposalDecided(ctx.env.TANWEER_DB, proposalId, 'WITHDRAWN', user.id, ctx.now);
  return { withdrawn: true };
}

/** New timetable version — the old one is closed, never rewritten (§28). */
const newVersionSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  title: V.string({ min: 2, max: 60 }),
  effectiveFrom: V.isoDate(),
  copyFromVersionId: V.optional(V.string({ max: 80 })),
});

export async function createVersion(ctx: Ctx) {
  const input = await ctx.require(newVersionSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);
  if (!access.isModerator) throw new ApiError('NOT_A_MODERATOR');

  const { insertVersion, supersedeOldVersions } = await import('../db/queries/schedule');
  const id = newId('schv');
  await insertVersion(db, {
    id,
    group_id: input.groupId,
    title: input.title,
    effective_from: input.effectiveFrom,
    effective_to: null,
    status: 'ACTIVE',
    notes: null,
    created_by: user.id,
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  await supersedeOldVersions(db, input.groupId, id, input.effectiveFrom);

  if (input.copyFromVersionId) {
    const source = await findVersionById(db, input.copyFromVersionId);
    if (source) {
      const slots = await listSlots(db, source.id);
      for (const slot of slots) {
        await upsertSlot(db, {
          id: newId('slot'),
          versionId: id,
          groupId: input.groupId,
          weekday: slot.weekday,
          period: slot.period,
          subjectId: slot.subject_id,
          room: slot.room,
          notes: slot.notes,
          createdBy: user.id,
          now: ctx.now,
        });
      }
    }
  }

  audit(ctx, { action: 'schedule.version.created', entityType: 'SCHEDULE', entityId: id, groupId: input.groupId });
  return scheduleVersionsFor(ctx, input.groupId);
}

/** "الحصة القادمة" hint used by the اليوم header. */
export function currentPeriodHint(nowMinutes: number): { period: number | null; endsInMinutes: number | null } {
  const start = 7 * 60 + 30;
  if (nowMinutes < start) return { period: null, endsInMinutes: null };
  const period = Math.floor((nowMinutes - start) / 60) + 1;
  if (period > 8) return { period: null, endsInMinutes: null };
  const end = start + (period - 1) * 60 + 45;
  return { period, endsInMinutes: end - nowMinutes };
}

export function nowHint(ctx: Ctx) {
  return currentPeriodHint(localMinutes(ctx.timeZone));
}
