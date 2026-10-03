/**
 * 🧪 الاختبارات (§24, §26, §65).
 * An exam knows its subject, its date, its chapters and — through relations —
 * the lessons, homeworks, book and questions that belong to it.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { sectionCodesForGroup } from '../db/queries/groups';
import { findExamById, insertExam, listExams, updateExam , type ExamRow} from '../db/queries/exams';
import { listRelations, insertRelation, insertRevision } from '../db/queries/content';
import { listHomeworks } from '../db/queries/homework';
import { listIssues } from '../db/queries/issues';
import { listBooksForSubject } from '../db/queries/books';
import { defaultSectionScope, requireMembership } from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { daysBetween } from '../lib/date';
import { examDto } from './dto';

const createSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  title: V.string({ min: 2, max: 160 }),
  subjectId: V.optional(V.number({ min: 1, max: 999 })),
  examDate: V.isoDate(),
  startsAt: V.optional(V.unionNull(V.clockTime())),
  durationMinutes: V.optional(V.number({ min: 5, max: 480 })),
  chapters: V.withDefault(V.arrayOf(V.number({ min: 1, max: 99 }), { max: 30 }), []),
  room: V.optional(V.string({ max: 60 })),
  notes: V.optional(V.string({ max: 2000, allowEmpty: true })),
  sectionScope: V.optional(V.unionNull(V.sectionCode())),
  bookId: V.optional(V.string({ max: 80 })),
  relatedContentIds: V.withDefault(V.arrayOf(V.string({ max: 80 }), { max: 30 }), []),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function createExam(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);
  const sectionCodes = await sectionCodesForGroup(db, input.groupId);
  const sectionScope = defaultSectionScope(access, input.sectionScope ?? undefined, sectionCodes, user.sectionCode);
  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR');

  const id = newId('exam');
  await insertExam(db, {
    id,
    groupId: input.groupId,
    academicYearId: academicYear.id,
    subjectId: input.subjectId ?? null,
    sectionScope,
    studyDate: ctx.today,
    examDate: input.examDate,
    startsAt: input.startsAt ?? null,
    durationMinutes: input.durationMinutes ?? null,
    title: input.title.trim(),
    chapters: input.chapters,
    room: input.room ?? null,
    notes: input.notes?.trim() ?? null,
    bookId: input.bookId ?? null,
    createdBy: user.id,
    now: ctx.now,
  });

  for (const contentId of input.relatedContentIds) {
    await insertRelation(db, {
      id: newId('crel'),
      groupId: input.groupId,
      fromType: 'EXAM',
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
    entityType: 'EXAM',
    entityId: id,
    revision: 1,
    action: 'CREATED',
    snapshot: { title: input.title, examDate: input.examDate, chapters: input.chapters },
    changedBy: user.id,
    now: ctx.now,
  });

  audit(ctx, { action: 'exam.created', entityType: 'EXAM', entityId: id, groupId: input.groupId });
  const row = await findExamById(db, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return withCountdown(ctx, row);
}

function withCountdown(ctx: Ctx, row: ExamRow) {
  const dto = examDto(row);
  return { ...dto, daysUntil: daysBetween(ctx.today, row.exam_date) };
}

/** scope = upcoming | past | all */
export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId');
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const scope = (ctx.q('scope') ?? 'upcoming') as 'upcoming' | 'past' | 'all';
  const rows = await listExams(ctx.env.TANWEER_DB, {
    groupId,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    subjectId: ctx.qInt('subjectId') ?? null,
    scope,
    today: ctx.today,
    limit: ctx.qInt('limit') ?? 50,
  });
  return rows.map((row) => withCountdown(ctx, row));
}

export async function detail(ctx: Ctx, examId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findExamById(db, examId);
  if (!row) throw new ApiError('EXAM_NOT_FOUND');
  await requireMembership(ctx, row.group_id);

  const relations = await listRelations(db, 'EXAM', examId);
  const contentIds = relations.filter((relation) => relation.to_type === 'CONTENT').map((relation) => relation.to_id);

  const [homeworks, issues, books] = await Promise.all([
    row.subject_id
      ? listHomeworks(db, { groupId: row.group_id, userId: user.id, subjectId: row.subject_id, limit: 30 })
      : Promise.resolve([]),
    listIssues(db, { groupId: row.group_id, examId, limit: 30 }),
    row.subject_id ? listBooksForSubject(db, (row as { grade_id?: number }).grade_id ?? user.gradeId, row.subject_id) : Promise.resolve([]),
  ]);

  return {
    exam: withCountdown(ctx, row),
    relatedContentIds: contentIds,
    homeworks: homeworks.slice(0, 15).map((homework) => ({
      id: homework.id,
      title: homework.title,
      dueDate: homework.due_date,
      done: homework.done === 'DONE',
    })),
    issues: issues.map((issue) => ({ id: issue.id, title: issue.title, status: issue.status, commentCount: issue.comment_count })),
    books: books.map((book) => ({ id: book.id, title: book.title, fileId: book.file_id, sourceUrl: book.source_url, rights: book.rights })),
    /** حزمة المذاكرة (§65) */
    studyPack: {
      lessons: contentIds.length,
      homeworks: homeworks.length,
      books: books.length,
      questions: issues.length,
      chapters: row.chapters ? (JSON.parse(row.chapters) as number[]) : [],
    },
  };
}

const updateSchema = V.object({
  title: V.optional(V.string({ min: 2, max: 160 })),
  notes: V.optional(V.string({ max: 2000, allowEmpty: true })),
  examDate: V.optional(V.isoDate()),
  startsAt: V.optional(V.unionNull(V.clockTime())),
  durationMinutes: V.optional(V.unionNull(V.number({ min: 5, max: 480 }))),
  chapters: V.optional(V.arrayOf(V.number({ min: 1, max: 99 }), { max: 30 })),
  room: V.optional(V.unionNull(V.string({ max: 60 }))),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  bookId: V.optional(V.unionNull(V.string({ max: 80 }))),
  reason: V.optional(V.string({ max: 200 })),
});

export async function update(ctx: Ctx, examId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findExamById(db, examId);
  if (!row) throw new ApiError('EXAM_NOT_FOUND');
  const access = await requireMembership(ctx, row.group_id);
  if (row.created_by !== user.id && !access.isModerator) throw new ApiError('FORBIDDEN', 'أرسل اقتراح تصحيح.');

  await updateExam(
    db,
    examId,
    {
      title: input.title,
      notes: input.notes,
      exam_date: input.examDate,
      starts_at: input.startsAt === undefined ? undefined : input.startsAt,
      duration_minutes: input.durationMinutes === undefined ? undefined : input.durationMinutes,
      chapters: input.chapters ? JSON.stringify(input.chapters) : undefined,
      room: input.room === undefined ? undefined : input.room,
      subject_id: input.subjectId === undefined ? undefined : input.subjectId,
      book_id: input.bookId === undefined ? undefined : input.bookId,
    },
    ctx.now,
  );

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'EXAM',
    entityId: examId,
    revision: row.revision + 1,
    action: 'EDITED',
    snapshot: { ...input },
    reason: input.reason ?? null,
    changedBy: user.id,
    now: ctx.now,
  });

  const updated = await findExamById(db, examId);
  if (!updated) throw new ApiError('INTERNAL_ERROR');
  return withCountdown(ctx, updated);
}
