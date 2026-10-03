/**
 * 📝 الواجبات and ✅ المهام (§21, §22, §23).
 * Personal completion is private; the group only sees a total count.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { sectionCodesForGroup, listGroupsForUser } from '../db/queries/groups';
import {
  findHomeworkById,
  insertHomework,
  listHomeworks,
  setHomeworkCompletion,
  updateHomework,
  homeworkStats,
  dueSoonHomeworks,
} from '../db/queries/homework';
import { defaultSectionScope, loadGroupAccess, requireMembership } from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { listRelations, insertRelation, insertRevision } from '../db/queries/content';
import { homeworkDto } from './dto';
import { notifyUsers } from './notifications';
import { addDays } from '../lib/date';

const createSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  kind: V.withDefault(V.oneOf(['HOMEWORK', 'TASK'] as const), 'HOMEWORK'),
  title: V.string({ min: 2, max: 160 }),
  body: V.optional(V.string({ max: 4000, allowEmpty: true })),
  subjectId: V.optional(V.number({ min: 1, max: 999 })),
  studyDate: V.isoDate(),
  dueDate: V.optional(V.unionNull(V.isoDate())),
  dueTime: V.optional(V.unionNull(V.clockTime())),
  sectionScope: V.optional(V.unionNull(V.sectionCode())),
  attachmentFileId: V.optional(V.string({ max: 80 })),
  /** Optional links to the lesson it belongs to. */
  relatedContentIds: V.withDefault(V.arrayOf(V.string({ max: 80 }), { max: 10 }), []),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function createHomework(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);
  const sectionCodes = await sectionCodesForGroup(db, input.groupId);
  const sectionScope = defaultSectionScope(access, input.sectionScope ?? undefined, sectionCodes, user.sectionCode);
  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR');

  const id = newId('hw');
  await insertHomework(db, {
    id,
    groupId: input.groupId,
    academicYearId: academicYear.id,
    subjectId: input.subjectId ?? null,
    sectionScope,
    studyDate: input.studyDate,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    kind: input.kind,
    title: input.title.trim(),
    body: input.body?.trim() ?? null,
    attachmentFileId: input.attachmentFileId ?? null,
    createdBy: user.id,
    now: ctx.now,
  });

  for (const contentId of input.relatedContentIds) {
    await insertRelation(db, {
      id: newId('crel'),
      groupId: input.groupId,
      fromType: 'HOMEWORK',
      fromId: id,
      toType: 'CONTENT',
      toId: contentId,
      kind: 'RELATED',
      createdBy: user.id,
      now: ctx.now,
    });
  }

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'HOMEWORK',
    entityId: id,
    revision: 1,
    action: 'CREATED',
    snapshot: { title: input.title, dueDate: input.dueDate ?? null, kind: input.kind },
    changedBy: user.id,
    now: ctx.now,
  });

  audit(ctx, { action: 'homework.created', entityType: 'HOMEWORK', entityId: id, groupId: input.groupId });
  const row = await findHomeworkById(db, user.id, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return homeworkDto(row, { mine: true });
}

/** Scopes: today | week | upcoming | overdue | completed | all */
export async function listForScope(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId');
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const scope = (ctx.q('scope') ?? 'today') as 'today' | 'week' | 'upcoming' | 'overdue' | 'completed' | 'all';

  const filter = {
    groupId,
    userId: user.id,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    subjectId: ctx.qInt('subjectId') ?? null,
    kind: (ctx.q('kind') as 'HOMEWORK' | 'TASK' | null) ?? null,
    limit: ctx.qInt('limit') ?? 60,
  };

  const weekEnd = addDays(ctx.today, 7);
  if (scope === 'today') {
    Object.assign(filter, { dueFrom: ctx.today, dueTo: ctx.today });
  } else if (scope === 'week') {
    Object.assign(filter, { dueFrom: ctx.today, dueTo: weekEnd });
  } else if (scope === 'upcoming') {
    Object.assign(filter, { dueFrom: addDays(ctx.today, 1) });
  } else if (scope === 'overdue') {
    Object.assign(filter, { dueTo: addDays(ctx.today, -1), status: 'OPEN' as const });
  } else if (scope === 'completed') {
    Object.assign(filter, { status: 'DONE' as const });
  }

  const rows = await listHomeworks(ctx.env.TANWEER_DB, filter);
  return rows.map((row) => homeworkDto(row, { mine: row.created_by === user.id }));
}

export async function homeworkDetail(ctx: Ctx, homeworkId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findHomeworkById(db, user.id, homeworkId);
  if (!row) throw new ApiError('HOMEWORK_NOT_FOUND');
  await requireMembership(ctx, row.group_id);
  const relations = await listRelations(db, 'HOMEWORK', homeworkId);
  const { listIssues } = await import('../db/queries/issues');
  const issues = await listIssues(db, { groupId: row.group_id, homeworkId, limit: 20 });
  return {
    homework: homeworkDto(row, { mine: row.created_by === user.id }),
    relations: relations.map((relation) => ({ id: relation.id, toType: relation.to_type, toId: relation.to_id, kind: relation.kind })),
    issues: issues.map((issue) => ({ id: issue.id, title: issue.title, status: issue.status, commentCount: issue.comment_count })),
  };
}

const updateSchema = V.object({
  title: V.optional(V.string({ min: 2, max: 160 })),
  body: V.optional(V.string({ max: 4000, allowEmpty: true })),
  dueDate: V.optional(V.unionNull(V.isoDate())),
  dueTime: V.optional(V.unionNull(V.clockTime())),
  kind: V.optional(V.oneOf(['HOMEWORK', 'TASK'] as const)),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  studyDate: V.optional(V.isoDate()),
  isPinned: V.optional(V.boolean()),
  reason: V.optional(V.string({ max: 200 })),
});

export async function updateHomeworkById(ctx: Ctx, homeworkId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findHomeworkById(db, user.id, homeworkId);
  if (!row) throw new ApiError('HOMEWORK_NOT_FOUND');
  const access = await requireMembership(ctx, row.group_id);
  if (row.created_by !== user.id && !access.isModerator) throw new ApiError('FORBIDDEN', 'أرسل اقتراح تصحيح بدلًا من التعديل.');

  await updateHomework(
    db,
    homeworkId,
    {
      title: input.title,
      body: input.body,
      due_date: input.dueDate === undefined ? undefined : input.dueDate,
      due_time: input.dueTime === undefined ? undefined : input.dueTime,
      kind: input.kind,
      subject_id: input.subjectId === undefined ? undefined : input.subjectId,
      study_date: input.studyDate,
      is_pinned: input.isPinned === undefined ? undefined : input.isPinned ? 1 : 0,
    },
    ctx.now,
  );

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'HOMEWORK',
    entityId: homeworkId,
    revision: row.revision + 1,
    action: 'EDITED',
    snapshot: { ...input },
    reason: input.reason ?? null,
    changedBy: user.id,
    now: ctx.now,
  });
  const updated = await findHomeworkById(db, user.id, homeworkId);
  if (!updated) throw new ApiError('INTERNAL_ERROR');
  return homeworkDto(updated, { mine: updated.created_by === user.id });
}

export async function markCompletion(ctx: Ctx, homeworkId: string) {
  const input = await ctx.require(V.object({ done: V.boolean(), note: V.optional(V.string({ max: 300 })) }));
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findHomeworkById(db, user.id, homeworkId);
  if (!row) throw new ApiError('HOMEWORK_NOT_FOUND');
  await requireMembership(ctx, row.group_id);
  const total = await setHomeworkCompletion(db, homeworkId, user.id, input.done, ctx.now, input.note ?? null);
  return { done: input.done, completionCount: total };
}

/** Counters + today's list, in one shot, for the home screen badges (§7). */
export async function summary(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const groups = await listGroupsForUser(db, user.id);
  const [stats, dueToday] = await Promise.all([
    homeworkStats(db, user.id, groups.map((group) => group.id), ctx.today),
    dueSoonHomeworks(db, user.id, ctx.today, 20),
  ]);
  return {
    ...stats,
    today: ctx.today,
    items: dueToday.map((row) => homeworkDto(row, { mine: row.created_by === user.id })),
  };
}
