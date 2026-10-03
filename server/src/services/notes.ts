/**
 * 🔒 ملاحظات شخصية (§45) — private, never part of group content.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { deleteNote, findNote, insertNote, listNotes, updateNote } from '../db/queries/notes';

function noteDto(row: {
  id: string;
  group_id: string | null;
  subject_id: number | null;
  content_id: string | null;
  study_date: string | null;
  title: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  revision: number;
  subject_name?: string | null;
}) {
  return {
    id: row.id,
    groupId: row.group_id,
    subjectId: row.subject_id,
    subjectName: row.subject_name ?? null,
    contentId: row.content_id,
    studyDate: row.study_date,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const rows = await listNotes(ctx.env.TANWEER_DB, user.id, {
    groupId: ctx.q('groupId'),
    subjectId: ctx.qInt('subjectId') ?? null,
    date: ctx.q('date'),
    limit: ctx.qInt('limit') ?? 100,
  });
  return rows.map(noteDto);
}

const createSchema = V.object({
  title: V.optional(V.string({ max: 160 })),
  body: V.string({ min: 1, max: 8000 }),
  groupId: V.optional(V.string({ max: 80 })),
  subjectId: V.optional(V.number({ min: 1, max: 999 })),
  contentId: V.optional(V.string({ max: 80 })),
  studyDate: V.optional(V.isoDate()),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function create(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const id = newId('note');
  await insertNote(ctx.env.TANWEER_DB, {
    id,
    userId: user.id,
    groupId: input.groupId ?? null,
    subjectId: input.subjectId ?? null,
    contentId: input.contentId ?? null,
    studyDate: input.studyDate ?? null,
    title: input.title ?? null,
    body: input.body,
    now: ctx.now,
  });
  const row = await findNote(ctx.env.TANWEER_DB, id, user.id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return noteDto(row);
}

const updateSchema = V.object({
  title: V.optional(V.unionNull(V.string({ max: 160 }))),
  body: V.optional(V.string({ min: 1, max: 8000 })),
});

export async function update(ctx: Ctx, noteId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const ok = await updateNote(ctx.env.TANWEER_DB, noteId, user.id, { title: input.title === undefined ? undefined : input.title, body: input.body }, ctx.now);
  if (!ok) throw new ApiError('NOT_FOUND', 'الملاحظة غير موجودة.');
  const row = await findNote(ctx.env.TANWEER_DB, noteId, user.id);
  if (!row) throw new ApiError('NOT_FOUND');
  return noteDto(row);
}

export async function remove(ctx: Ctx, noteId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const ok = await deleteNote(ctx.env.TANWEER_DB, noteId, user.id);
  if (!ok) throw new ApiError('NOT_FOUND');
  return { deleted: true };
}
