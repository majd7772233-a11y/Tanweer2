/**
 * ❓ الاستفسارات (§30, §31, §32).
 * An issue can hang off a homework, an exam or a lesson — then the student never
 * has to explain "which homework do you mean?".
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { sectionCodesForGroup } from '../db/queries/groups';
import {
  findIssueById,
  findIssueComment,
  insertIssue,
  insertIssueComment,
  listIssueComments,
  listIssues,
  setBestAnswer,
  setIssueCommentStatus,
  touchIssue,
  updateIssueStatus,
} from '../db/queries/issues';
import { resolveEntity } from './content';
import { defaultSectionScope, loadGroupAccess, requireMembership } from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { commentDto, issueDto } from './dto';
import { notifyUsers } from './notifications';

const createSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  title: V.string({ min: 3, max: 200 }),
  body: V.optional(V.string({ max: 4000, allowEmpty: true })),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  studyDate: V.optional(V.isoDate()),
  homeworkId: V.optional(V.string({ max: 80 })),
  examId: V.optional(V.string({ max: 80 })),
  contentId: V.optional(V.string({ max: 80 })),
  sectionScope: V.optional(V.unionNull(V.sectionCode())),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function create(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);
  const sectionCodes = await sectionCodesForGroup(db, input.groupId);
  const sectionScope = defaultSectionScope(access, input.sectionScope ?? undefined, sectionCodes, user.sectionCode);
  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR');

  // The automatic link a student expects when asking from a homework (§32).
  let subjectId = input.subjectId ?? null;
  if (!subjectId && input.homeworkId) {
    const row = await db.prepare('SELECT subject_id FROM homeworks WHERE id = ?1').bind(input.homeworkId).first<{ subject_id: number | null }>();
    subjectId = row?.subject_id ?? null;
  }
  if (!subjectId && input.examId) {
    const row = await db.prepare('SELECT subject_id FROM exams WHERE id = ?1').bind(input.examId).first<{ subject_id: number | null }>();
    subjectId = row?.subject_id ?? null;
  }

  const id = newId('iss');
  await insertIssue(db, {
    id,
    groupId: input.groupId,
    academicYearId: academicYear.id,
    subjectId,
    sectionScope,
    studyDate: input.studyDate ?? ctx.today,
    title: input.title.trim(),
    body: input.body?.trim() ?? null,
    contentId: input.contentId ?? null,
    homeworkId: input.homeworkId ?? null,
    examId: input.examId ?? null,
    createdBy: user.id,
    now: ctx.now,
  });

  audit(ctx, { action: 'issue.created', entityType: 'ISSUE', entityId: id, groupId: input.groupId });
  const row = await findIssueById(db, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return issueDto(row, { mine: true });
}

export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId');
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const rows = await listIssues(ctx.env.TANWEER_DB, {
    groupId,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    subjectId: ctx.qInt('subjectId') ?? null,
    status: (ctx.q('status') as never) ?? null,
    homeworkId: ctx.q('homeworkId'),
    examId: ctx.q('examId'),
    contentId: ctx.q('contentId'),
    authorId: ctx.q('authorId'),
    query: ctx.q('q'),
    limit: ctx.qInt('limit') ?? 40,
  });
  return rows.map((row) => issueDto(row, { mine: row.created_by === user.id }));
}

export async function detail(ctx: Ctx, issueId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findIssueById(db, issueId);
  if (!row) throw new ApiError('ISSUE_NOT_FOUND');
  await requireMembership(ctx, row.group_id);
  const comments = await listIssueComments(db, issueId, 200);
  return {
    issue: issueDto(row, { mine: row.created_by === user.id }),
    comments: comments.map((comment) => ({ ...commentDto(comment), isBest: comment.id === row.best_comment_id })),
  };
}

export async function comment(ctx: Ctx, issueId: string) {
  const input = await ctx.require(
    V.object({
      body: V.string({ min: 1, max: 3000 }),
      clientUploadId: V.optional(V.string({ max: 120 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const issue = await findIssueById(db, issueId);
  if (!issue) throw new ApiError('ISSUE_NOT_FOUND');
  await requireMembership(ctx, issue.group_id);
  if (issue.status === 'CLOSED') throw new ApiError('FORBIDDEN', 'الاستفسار مغلق.');

  const commentId = newId('icmt');
  await insertIssueComment(db, { id: commentId, issueId, userId: user.id, body: input.body.trim(), now: ctx.now });
  await touchIssue(db, issueId, ctx.now);

  if (issue.status === 'OPEN') await updateIssueStatus(db, issueId, 'IN_DISCUSSION', ctx.now);

  const recipients = [issue.created_by];
  const participants = await listIssueComments(db, issueId, 50);
  for (const participant of participants) recipients.push(participant.user_id);
  await notifyUsers(ctx, recipients, {
    kind: 'ISSUE',
    title: '❓ رد على استفسار',
    body: `${user.fullName}: ${input.body.trim().slice(0, 90)}`,
    groupId: issue.group_id,
    entityType: 'ISSUE',
    entityId: issueId,
    deepLink: `tanweer://issue/${issueId}`,
    batchKey: `issue:${issueId}`,
    priority: 'NORMAL',
  });

  const row = await findIssueComment(db, commentId);
  return row ? commentDto(row) : { id: commentId };
}

const statusSchema = V.object({
  status: V.oneOf(['OPEN', 'IN_DISCUSSION', 'SOLVED', 'CLOSED'] as const),
  reason: V.optional(V.string({ max: 200 })),
});

export async function setStatus(ctx: Ctx, issueId: string) {
  const input = await ctx.require(statusSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const issue = await findIssueById(db, issueId);
  if (!issue) throw new ApiError('ISSUE_NOT_FOUND');
  const access = await requireMembership(ctx, issue.group_id);
  if (issue.created_by !== user.id && !access.isModerator) throw new ApiError('FORBIDDEN');
  await updateIssueStatus(db, issueId, input.status, ctx.now);
  audit(ctx, { action: 'issue.status', entityType: 'ISSUE', entityId: issueId, groupId: issue.group_id, meta: { status: input.status } });

  if (input.status === 'SOLVED' && issue.created_by !== user.id) {
    await notifyUsers(ctx, [issue.created_by], {
      kind: 'ISSUE',
      title: '✅ تم حل استفسارك',
      body: issue.title,
      groupId: issue.group_id,
      entityType: 'ISSUE',
      entityId: issueId,
      deepLink: `tanweer://issue/${issueId}`,
      batchKey: `issue-solved:${issueId}`,
      priority: 'NORMAL',
    });
  }
  const updated = await findIssueById(db, issueId);
  return updated ? issueDto(updated) : { id: issueId };
}

/** ⭐ best answer — to shorten the search, not to run a competition (§31). */
export async function bestAnswer(ctx: Ctx, issueId: string) {
  const input = await ctx.require(V.object({ commentId: V.string({ min: 4, max: 80 }) }));
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const issue = await findIssueById(db, issueId);
  if (!issue) throw new ApiError('ISSUE_NOT_FOUND');
  await requireMembership(ctx, issue.group_id);

  const row = await findIssueComment(db, input.commentId);
  if (!row || row.issue_id !== issueId) throw new ApiError('NOT_FOUND', 'الرد غير موجود.');

  const clearing = issue.best_comment_id === input.commentId;
  await setBestAnswer(db, issueId, clearing ? null : input.commentId, ctx.now);
  if (!clearing && row.user_id !== user.id) {
    await notifyUsers(ctx, [row.user_id], {
      kind: 'ISSUE',
      title: '⭐ أفضل إجابة',
      body: `اختار ${user.fullName} ردك كأفضل إجابة`,
      groupId: issue.group_id,
      entityType: 'ISSUE',
      entityId: issueId,
      deepLink: `tanweer://issue/${issueId}`,
      batchKey: `best:${issueId}`,
      priority: 'NORMAL',
    });
  }
  const updated = await findIssueById(db, issueId);
  return updated ? issueDto(updated) : { id: issueId };
}

/** Hiding a comment is possible for the author or a moderator (audit-safe). */
export async function hideComment(ctx: Ctx, issueId: string, commentId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const issue = await findIssueById(db, issueId);
  if (!issue) throw new ApiError('ISSUE_NOT_FOUND');
  const access = await requireMembership(ctx, issue.group_id);
  const row = await findIssueComment(db, commentId);
  if (!row || row.issue_id !== issueId) throw new ApiError('NOT_FOUND');
  if (row.user_id !== user.id && !access.isModerator) throw new ApiError('FORBIDDEN');
  await setIssueCommentStatus(db, commentId, 'HIDDEN', ctx.now);
  return { hidden: true };
}

/** Quick question attached to an entity, used by the "❓ لدي سؤال" button. */
export async function quickQuestion(ctx: Ctx, entityType: string, entityId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND');
  const access = await loadGroupAccess(ctx, target.groupId);
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');

  const input = await ctx.require(V.object({ title: V.string({ min: 3, max: 200 }), body: V.optional(V.string({ max: 2000, allowEmpty: true })) }));

  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR');
  const id = newId('iss');
  await insertIssue(db, {
    id,
    groupId: target.groupId,
    academicYearId: academicYear.id,
    subjectId: null,
    sectionScope: target.sectionScope,
    studyDate: ctx.today,
    title: input.title.trim(),
    body: input.body?.trim() ?? null,
    contentId: entityType === 'CONTENT' ? entityId : null,
    homeworkId: entityType === 'HOMEWORK' ? entityId : null,
    examId: entityType === 'EXAM' ? entityId : null,
    createdBy: user.id,
    now: ctx.now,
  });
  const row = await findIssueById(db, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return issueDto(row, { mine: true });
}
