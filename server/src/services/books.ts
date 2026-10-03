/**
 * 📚 مكتبة الكتب (§46, §47).
 * A book is either hosted (we must hold the right to redistribute it) or a link
 * to the official source. Tanweer never republishes a book it has no right to.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { findBookById, insertBook, insertBookSource, listBookSources, listBooks, updateBook } from '../db/queries/books';
import { findSection, findActiveAcademicYear } from '../db/queries/structure';
import { findMembership } from '../db/queries/groups';
import { bookDto } from './dto';
import { signedFileUrl } from './files';

export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const rows = await listBooks(ctx.env.TANWEER_DB, {
    gradeId: ctx.qInt('gradeId') ?? user.gradeId,
    subjectId: ctx.qInt('subjectId') ?? null,
    query: ctx.q('q'),
    limit: ctx.qInt('limit') ?? 100,
  });
  return rows.map((row) => bookDto(row));
}

export async function detail(ctx: Ctx, bookId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findBookById(db, bookId);
  if (!row) throw new ApiError('BOOK_NOT_FOUND');
  const sources = await listBookSources(db, bookId);
  const downloadUrl = row.file_id ? await signedFileUrl(ctx, row.file_id, 3600) : null;
  return {
    ...bookDto(row, { sources: sources.map((source) => ({ id: source.id, label: source.label, url: source.url, kind: source.kind })) }),
    downloadUrl,
  };
}

const createSchema = V.object({
  gradeId: V.number({ min: 7, max: 12 }),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  title: V.string({ min: 2, max: 160 }),
  edition: V.optional(V.string({ max: 60 })),
  publisher: V.optional(V.string({ max: 120 })),
  rights: V.oneOf(['OWNED', 'OFFICIAL_LINK'] as const),
  fileId: V.optional(V.unionNull(V.string({ max: 80 }))),
  sourceUrl: V.optional(V.unionNull(V.httpUrl())),
  pages: V.optional(V.number({ min: 1, max: 5000 })),
  sizeBytes: V.optional(V.number({ min: 1, max: 500 * 1024 * 1024 })),
  sources: V.withDefault(V.arrayOf(V.object({ label: V.string({ min: 2, max: 80 }), url: V.httpUrl() }), { max: 10 }), []),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

/**
 * Any verified member may add a book, but hosting a PDF requires the OWNED
 * rights flag: the school decides who is allowed to do that (§47).
 */
export async function create(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  if (input.rights === 'OWNED') {
    const allowed = user.role === 'SCHOOL_ADMIN' || user.role === 'OFFICIAL_TEACHER' || user.role === 'VERIFIED_TEACHER';
    if (!allowed) {
      throw new ApiError('FORBIDDEN', 'رفع نسخة من الكتاب يحتاج صلاحية. استخدم رابط المصدر الرسمي.');
    }
    if (!input.fileId) throw new ApiError('VALIDATION_ERROR', 'أرفق ملف الكتاب أولًا.');
  }
  if (input.rights === 'OFFICIAL_LINK' && !input.sourceUrl && input.sources.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'أضف رابط المصدر الرسمي.');
  }

  const academicYear = await findActiveAcademicYear(db);
  const id = newId('book');
  await insertBook(db, {
    id,
    academicYearId: academicYear?.id ?? null,
    gradeId: input.gradeId,
    subjectId: input.subjectId ?? null,
    title: input.title.trim(),
    edition: input.edition ?? null,
    publisher: input.publisher ?? null,
    fileId: input.rights === 'OWNED' ? (input.fileId ?? null) : null,
    coverKey: null,
    sourceUrl: input.sourceUrl ?? null,
    rights: input.rights,
    pages: input.pages ?? null,
    sizeBytes: input.sizeBytes ?? null,
    uploadedBy: user.id,
    now: ctx.now,
  });

  for (const source of input.sources) {
    await insertBookSource(db, { id: newId('bsrc'), bookId: id, label: source.label, url: source.url, kind: 'OFFICIAL', now: ctx.now });
  }

  audit(ctx, { action: 'book.created', entityType: 'BOOK', entityId: id, meta: { rights: input.rights } });
  const row = await findBookById(db, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return bookDto(row);
}

const updateSchema = V.object({
  title: V.optional(V.string({ min: 2, max: 160 })),
  edition: V.optional(V.unionNull(V.string({ max: 60 }))),
  publisher: V.optional(V.unionNull(V.string({ max: 120 }))),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  status: V.optional(V.oneOf(['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const)),
});

export async function update(ctx: Ctx, bookId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findBookById(db, bookId);
  if (!row) throw new ApiError('BOOK_NOT_FOUND');
  if (row.uploaded_by !== user.id && user.role === 'MEMBER') throw new ApiError('FORBIDDEN');

  await updateBook(
    db,
    bookId,
    {
      title: input.title,
      edition: input.edition === undefined ? undefined : input.edition,
      publisher: input.publisher === undefined ? undefined : input.publisher,
      subject_id: input.subjectId === undefined ? undefined : input.subjectId,
      status: input.status,
    },
    ctx.now,
  );
  const updated = await findBookById(db, bookId);
  if (!updated) throw new ApiError('INTERNAL_ERROR');
  return bookDto(updated);
}

/** Books for the subject screen and for an exam study pack. */
export async function booksFor(ctx: Ctx, gradeId: number, subjectId: number | null) {
  const rows = await listBooks(ctx.env.TANWEER_DB, { gradeId, subjectId: subjectId ?? undefined, limit: 50 });
  return rows.map((row) => bookDto(row));
}

export async function validateGradeSection(ctx: Ctx, gradeId: number, sectionCode: string) {
  const section = await findSection(ctx.env.TANWEER_DB, gradeId, sectionCode);
  if (!section) throw new ApiError('VALIDATION_ERROR', 'الشعبة غير صحيحة.');
  return section;
}

export async function membershipFor(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  return findMembership(ctx.env.TANWEER_DB, groupId, user.id);
}
