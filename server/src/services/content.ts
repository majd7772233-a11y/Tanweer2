/**
 * Content: lessons, photos, files, notes, summaries and links (§14 → §20).
 *
 * Rules that matter:
 *  • one lesson may carry many pages (media rows), never many posts;
 *  • identical bytes on the same day/subject become a contribution, not a post;
 *  • nothing is deleted by one person: a deletion request is opened instead;
 *  • every change writes a revision (who / what / when / why).
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import {
  findGroupById,
  sectionCodesForGroup,
} from '../db/queries/groups';
import {
  insertComment,
  insertContribution,
  insertMedia,
  insertRelation,
  insertRevision,
  listComments,
  listContributions,
  listMedia,
  listMediaForContents,
  listPins,
  listRevisions,
  listRelations,
  nextPageIndex,
  toggleBookmark,
  toggleReaction,
  updateContentFields,
  findComment,
  findContentById,
  findContentByChecksum,
  findSimilarContent,
  listContent,
  moveMediaToContent,
  setCanonical,
  setContentStatus,
  setEntityCommentCount,
  type ContentRow,
  type ContentType,
} from '../db/queries/content';
import { findFileById } from '../db/queries/files';
import {
  assertSectionVisible,
  defaultSectionScope,
  loadGroupAccess,
  requireMembership,
} from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { commentDto, contentDto } from './dto';
import { notifyUsers } from './notifications';

const contentTypes = ['LESSON', 'PHOTO', 'FILE', 'NOTE', 'SUMMARY', 'LINK'] as const;

const mediaInputSchema = V.object({
  fileId: V.string({ min: 4, max: 80 }),
  caption: V.optional(V.string({ max: 200 })),
  role: V.withDefault(V.oneOf(['REFERENCE', 'EXTRA', 'ATTACHMENT'] as const), 'EXTRA'),
});

const createSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  type: V.oneOf(contentTypes),
  title: V.string({ min: 2, max: 140 }),
  body: V.optional(V.string({ max: 8000, allowEmpty: true })),
  subjectId: V.optional(V.number({ min: 1, max: 999 })),
  studyDate: V.isoDate(),
  period: V.optional(V.number({ min: 1, max: 12 })),
  sectionScope: V.optional(V.unionNull(V.sectionCode())),
  sourceUrl: V.optional(V.httpUrl()),
  files: V.withDefault(V.arrayOf(mediaInputSchema, { max: 20 }), []),
  /** Accepted merge target when the students confirm a duplicate suggestion. */
  mergeIntoId: V.optional(V.string({ min: 4, max: 80 })),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

async function ensureFiles(ctx: Ctx, fileIds: string[]): Promise<Map<string, Awaited<ReturnType<typeof findFileById>>>> {
  const map = new Map<string, Awaited<ReturnType<typeof findFileById>>>();
  for (const fileId of fileIds) {
    const file = await findFileById(ctx.env.TANWEER_DB, fileId);
    if (!file) throw new ApiError('FILE_NOT_FOUND', `الملف ${fileId} غير موجود.`);
    if (file.owner_id !== ctx.user?.id) throw new ApiError('FORBIDDEN', 'لا تملك هذا الملف.');
    map.set(fileId, file);
  }
  return map;
}

export async function createContent(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  const access = await requireMembership(ctx, input.groupId);
  const sectionCodes = await sectionCodesForGroup(db, input.groupId);
  const sectionScope = defaultSectionScope(access, input.sectionScope ?? undefined, sectionCodes, user.sectionCode);

  if (input.studyDate > ctx.today) {
    throw new ApiError('VALIDATION_ERROR', 'لا يمكن توثيق درس في تاريخ لم يأتِ بعد.');
  }
  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR', 'لا توجد سنة دراسية نشطة.');

  const files = await ensureFiles(
    ctx,
    input.files.map((file) => file.fileId),
  );

  // ── duplicate detection (§19) ──────────────────────────────────────────────
  const primaryChecksum = files.values().next().value?.checksum ?? null;
  let target: ContentRow | null = null;
  if (input.mergeIntoId) {
    const mergeTarget = await findContentById(db, input.mergeIntoId);
    if (!mergeTarget || mergeTarget.group_id !== input.groupId) throw new ApiError('CONTENT_NOT_FOUND');
    assertSectionVisible(access, mergeTarget.section_scope);
    target = mergeTarget;
  } else if (primaryChecksum) {
    target = await findContentByChecksum(db, input.groupId, primaryChecksum, input.studyDate);
    if (target) assertSectionVisible(access, target.section_scope);
  }

  if (target) {
    // Same page, same day: become a contribution instead of a new card.
    let pageIndex = await nextPageIndex(db, target.id);
    for (const file of files.values()) {
      if (!file) continue;
      await insertMedia(db, {
        id: newId('cmed'),
        contentId: target.id,
        fileId: file.id,
        role: 'EXTRA',
        pageIndex,
        caption: null,
        uploadedBy: user.id,
        now: ctx.now,
      });
      pageIndex += 1;
      await insertContribution(db, {
        id: newId('ccon'),
        contentId: target.id,
        userId: user.id,
        fileId: file.id,
        kind: 'PHOTO',
        note: null,
        now: ctx.now,
      });
      await db.prepare('UPDATE content SET media_count = media_count + 1, contribution_count = contribution_count + 1 WHERE id = ?1').bind(target.id).run();
    }
    audit(ctx, { action: 'content.contribution', entityType: 'CONTENT', entityId: target.id, groupId: input.groupId });
    const refreshed = await findContentById(db, target.id);
    return { merged: true, content: contentDto(refreshed ?? target) };
  }

  const contentId = newId('cnt');
  await db
    .prepare(
      `INSERT INTO content (id, group_id, academic_year_id, subject_id, section_scope, study_date, period, type, title, body,
                            source_url, status, checksum, media_count, contribution_count, created_by, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'PUBLISHED', ?12, 0, 0, ?13, ?14, ?14, 1)`,
    )
    .bind(
      contentId,
      input.groupId,
      academicYear.id,
      input.subjectId ?? null,
      sectionScope,
      input.studyDate,
      input.period ?? null,
      input.type,
      input.title.trim(),
      input.body?.trim() ?? null,
      input.sourceUrl ?? null,
      primaryChecksum,
      user.id,
      ctx.now,
    )
    .run();

  let pageIndex = 0;
  for (const file of files.values()) {
    if (!file) continue;
    await insertMedia(db, {
      id: newId('cmed'),
      contentId,
      fileId: file.id,
      role: pageIndex === 0 ? 'REFERENCE' : 'EXTRA',
      pageIndex,
      caption: null,
      uploadedBy: user.id,
      now: ctx.now,
    });
    await insertContribution(db, {
      id: newId('ccon'),
      contentId,
      userId: user.id,
      fileId: file.id,
      kind: input.type === 'FILE' ? 'FILE' : 'PHOTO',
      note: null,
      now: ctx.now,
    });
    pageIndex += 1;
  }
  if (pageIndex > 0) {
    await db.prepare('UPDATE content SET media_count = ?1, contribution_count = ?1 WHERE id = ?2').bind(pageIndex, contentId).run();
  }

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'CONTENT',
    entityId: contentId,
    revision: 1,
    action: 'CREATED',
    snapshot: { title: input.title, type: input.type, studyDate: input.studyDate, mediaFiles: [...files.keys()] },
    changedBy: user.id,
    now: ctx.now,
  });

  const created = await findContentById(db, contentId);
  if (!created) throw new ApiError('INTERNAL_ERROR');

  // Suggest merging with something that looks like the same thing (§20) —
  // never automatic.
  const similar = await findSimilarContent(db, input.groupId, input.title, input.studyDate, 3);
  const suggestions = similar.filter((row) => row.id !== contentId).map((row) => contentDto(row));

  audit(ctx, { action: 'content.created', entityType: 'CONTENT', entityId: contentId, groupId: input.groupId, meta: { type: input.type } });
  return {
    merged: false,
    content: contentDto(created, { media: await listMedia(db, contentId) }),
    similar: suggestions,
  };
}

export async function contentDetail(ctx: Ctx, contentId: string) {
  const db = ctx.env.TANWEER_DB;
  const row = await findContentById(db, contentId);
  if (!row) throw new ApiError('CONTENT_NOT_FOUND');
  const access = await loadGroupAccess(ctx, row.group_id);
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');
  assertSectionVisible(access, row.section_scope);

  const [media, comments, contributions, relations, revisions, pins] = await Promise.all([
    listMedia(db, contentId),
    listComments(db, 'CONTENT', contentId, 100),
    listContributions(db, contentId),
    listRelations(db, 'CONTENT', contentId),
    listRevisions(db, 'CONTENT', contentId, 20),
    listPins(db, row.group_id, 5),
  ]);

  return {
    content: contentDto(row, { media, mine: row.created_by === ctx.user?.id }),
    comments: comments.map(commentDto),
    contributions: contributions.map((contribution) => ({
      id: contribution.id,
      kind: contribution.kind,
      note: contribution.note,
      fileId: contribution.file_id,
      createdAt: contribution.created_at,
      user: {
        id: contribution.user_id,
        fullName: contribution.full_name,
        gradeId: contribution.grade_id,
        sectionCode: contribution.section_code,
        classId: `${contribution.grade_id}-${contribution.section_code}`,
      },
    })),
    relations: relations.map((relation) => ({ id: relation.id, toType: relation.to_type, toId: relation.to_id, kind: relation.kind })),
    history: revisions.map((revision) => ({
      id: revision.id,
      revision: revision.revision,
      action: revision.action,
      reason: revision.reason,
      changedBy: revision.changed_by,
      changedByName: revision.changed_by_name ?? '',
      changedAt: revision.changed_at,
    })),
    pinned: pins.length > 0,
  };
}

export async function listContentForGroup(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId');
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const rows = await listContent(ctx.env.TANWEER_DB, {
    groupId,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    subjectId: ctx.qInt('subjectId') ?? null,
    type: (ctx.q('type') as ContentType | null) ?? null,
    date: ctx.q('date'),
    from: ctx.q('from'),
    to: ctx.q('to'),
    authorId: ctx.q('authorId'),
    limit: ctx.qInt('limit') ?? 30,
  });
  const media = await listMediaForContents(ctx.env.TANWEER_DB, rows.map((row) => row.id));
  return rows.map((row) => contentDto(row, { media: media.get(row.id) ?? [], mine: row.created_by === user.id }));
}

const updateSchema = V.object({
  title: V.optional(V.string({ min: 2, max: 140 })),
  body: V.optional(V.string({ max: 8000, allowEmpty: true })),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  studyDate: V.optional(V.isoDate()),
  period: V.optional(V.unionNull(V.number({ min: 1, max: 12 }))),
  sourceUrl: V.optional(V.unionNull(V.httpUrl())),
  reason: V.optional(V.string({ max: 200 })),
  expectedRevision: V.optional(V.number({ min: 1 })),
});

/** The author (or a moderator) may fix their own content directly. */
export async function updateContent(ctx: Ctx, contentId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findContentById(db, contentId);
  if (!row) throw new ApiError('CONTENT_NOT_FOUND');
  const access = await requireMembership(ctx, row.group_id);
  if (row.created_by !== user.id && !access.isModerator) {
    throw new ApiError('FORBIDDEN', 'لتغيير محتوى غيرك أرسل اقتراح تصحيح.');
  }
  if (row.created_by === user.id && !access.isModerator && input.studyDate && row.study_date !== input.studyDate) {
    // The author may still fix the date: it is their own documentation.
  }

  const before: Record<string, unknown> = {
    title: row.title,
    body: row.body,
    subject_id: row.subject_id,
    study_date: row.study_date,
    period: row.period,
    source_url: row.source_url,
  };
  const ok = await updateContentFields(
    db,
    contentId,
    {
      title: input.title,
      body: input.body,
      subject_id: input.subjectId === undefined ? undefined : input.subjectId,
      study_date: input.studyDate,
      period: input.period === undefined ? undefined : input.period,
      source_url: input.sourceUrl === undefined ? undefined : input.sourceUrl,
    },
    { now: ctx.now, expectedRevision: input.expectedRevision },
  );
  if (!ok) throw new ApiError('REVISION_MISMATCH');

  const after = await findContentById(db, contentId);
  const diff: Record<string, [unknown, unknown]> = {};
  for (const [key, value] of Object.entries({
    title: after?.title,
    body: after?.body,
    subject_id: after?.subject_id,
    study_date: after?.study_date,
    period: after?.period,
    source_url: after?.source_url,
  })) {
    if (before[key] !== value) diff[key] = [before[key], value];
  }

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'CONTENT',
    entityId: contentId,
    revision: after?.revision ?? row.revision + 1,
    action: 'EDITED',
    snapshot: after ?? row,
    diff,
    reason: input.reason ?? null,
    changedBy: user.id,
    now: ctx.now,
  });
  if (Object.keys(diff).length > 0 && (after?.status ?? row.status) === 'PUBLISHED') {
    await setContentStatus(db, contentId, 'EDITED', ctx.now);
  }

  audit(ctx, { action: 'content.edited', entityType: 'CONTENT', entityId: contentId, groupId: row.group_id, meta: { diff } });
  return contentDetail(ctx, contentId);
}

export async function addMediaToContent(ctx: Ctx, contentId: string) {
  const input = await ctx.require(
    V.object({
      files: V.arrayOf(mediaInputSchema, { min: 1, max: 20 }),
      caption: V.optional(V.string({ max: 200 })),
      clientUploadId: V.optional(V.string({ max: 120 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findContentById(db, contentId);
  if (!row) throw new ApiError('CONTENT_NOT_FOUND');
  const access = await requireMembership(ctx, row.group_id);
  assertSectionVisible(access, row.section_scope);

  const files = await ensureFiles(ctx, input.files.map((file) => file.fileId));
  let pageIndex = await nextPageIndex(db, contentId);
  const addedIds: string[] = [];
  for (const file of files.values()) {
    if (!file) continue;
    const mediaId = newId('cmed');
    await insertMedia(db, {
      id: mediaId,
      contentId,
      fileId: file.id,
      role: 'EXTRA',
      pageIndex,
      caption: input.caption ?? null,
      uploadedBy: user.id,
      now: ctx.now,
    });
    await insertContribution(db, {
      id: newId('ccon'),
      contentId,
      userId: user.id,
      fileId: file.id,
      kind: 'PHOTO',
      note: input.caption ?? null,
      now: ctx.now,
    });
    addedIds.push(mediaId);
    pageIndex += 1;
  }
  await db.prepare('UPDATE content SET media_count = media_count + ?1, contribution_count = contribution_count + ?1, updated_at = ?2 WHERE id = ?3')
    .bind(addedIds.length, ctx.now, contentId).run();

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'CONTENT',
    entityId: contentId,
    revision: row.revision + 1,
    action: 'MEDIA_ADDED',
    snapshot: { added: addedIds.length },
    changedBy: user.id,
    now: ctx.now,
  });

  const refreshed = await findContentById(db, contentId);
  return { content: contentDto(refreshed ?? row, { media: await listMedia(db, contentId) }), added: addedIds.length };
}

/** Explicit merge of two contents that describe the same thing (§20). */
export async function mergeContents(ctx: Ctx, contentId: string) {
  const input = await ctx.require(V.object({ intoId: V.string({ min: 4, max: 80 }) }));
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const source = await findContentById(db, contentId);
  const target = await findContentById(db, input.intoId);
  if (!source || !target) throw new ApiError('CONTENT_NOT_FOUND');
  if (source.group_id !== target.group_id) throw new ApiError('FORBIDDEN', 'المحتوى في مجموعتين مختلفتين.');

  const access = await requireMembership(ctx, source.group_id);
  if (source.created_by !== user.id && target.created_by !== user.id && !access.isModerator) {
    throw new ApiError('FORBIDDEN');
  }

  await moveMediaToContent(db, source.id, target.id, ctx.now);
  await setCanonical(db, source.id, target.id, ctx.now);
  await insertContribution(db, {
    id: newId('ccon'),
    contentId: target.id,
    userId: source.created_by,
    fileId: null,
    kind: 'EDIT',
    note: `دُمج مع: ${source.title}`,
    now: ctx.now,
  });
  await db.prepare('UPDATE content SET media_count = media_count + ?1, contribution_count = contribution_count + 1, updated_at = ?2 WHERE id = ?3')
    .bind(Math.max(1, source.media_count), ctx.now, target.id).run();
  await insertRelation(db, {
    id: newId('crel'),
    groupId: source.group_id,
    fromType: 'CONTENT',
    fromId: source.id,
    toType: 'CONTENT',
    toId: target.id,
    kind: 'DUPLICATE',
    createdBy: user.id,
    now: ctx.now,
  });
  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'CONTENT',
    entityId: source.id,
    revision: source.revision + 1,
    action: 'MERGED',
    snapshot: { intoId: target.id },
    changedBy: user.id,
    now: ctx.now,
  });

  audit(ctx, { action: 'content.merged', entityType: 'CONTENT', entityId: source.id, groupId: source.group_id, meta: { into: target.id } });
  return contentDetail(ctx, target.id);
}

export async function addComment(ctx: Ctx, entityType: string, entityId: string) {
  const input = await ctx.require(
    V.object({
      body: V.string({ min: 1, max: 2000 }),
      parentId: V.optional(V.string({ max: 80 })),
      clientUploadId: V.optional(V.string({ max: 120 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND', 'العنصر غير موجود.');
  await requireMembership(ctx, target.groupId);
  assertSectionVisible(await loadGroupAccess(ctx, target.groupId), target.sectionScope);

  const commentId = newId('cmnt');
  await insertComment(db, {
    id: commentId,
    groupId: target.groupId,
    entityType,
    entityId,
    userId: user.id,
    body: input.body.trim(),
    parentId: input.parentId ?? null,
    now: ctx.now,
  });
  await setEntityCommentCount(db, target.table, entityId, 1);

  if (target.ownerId && target.ownerId !== user.id) {
    await notifyUsers(ctx, [target.ownerId], {
      kind: 'ISSUE',
      title: '💬 رد جديد',
      body: `${user.fullName}: ${input.body.trim().slice(0, 80)}`,
      groupId: target.groupId,
      entityType,
      entityId,
      deepLink: deepLinkFor(entityType, entityId),
      batchKey: `comment:${entityType}:${entityId}`,
      priority: 'NORMAL',
    });
  }

  const row = await findComment(db, commentId);
  return row ? commentDto(row) : { id: commentId };
}

function deepLinkFor(entityType: string, entityId: string): string {
  switch (entityType) {
    case 'CONTENT':
      return `tanweer://lesson/${entityId}`;
    case 'HOMEWORK':
      return `tanweer://homework/${entityId}`;
    case 'EXAM':
      return `tanweer://exam/${entityId}`;
    case 'EVENT':
      return `tanweer://event/${entityId}`;
    case 'ISSUE':
      return `tanweer://issue/${entityId}`;
    case 'BOOK':
      return `tanweer://book/${entityId}`;
    default:
      return `tanweer://home`;
  }
}

interface EntityRef {
  groupId: string;
  ownerId: string | null;
  sectionScope: string | null;
  table: 'content' | 'homeworks' | 'exams' | 'events' | 'issues';
}

export async function resolveEntity(db: D1Database, entityType: string, entityId: string): Promise<EntityRef | null> {
  switch (entityType) {
    case 'CONTENT': {
      const row = await db
        .prepare('SELECT group_id, created_by, section_scope FROM content WHERE id = ?1')
        .bind(entityId)
        .first<{ group_id: string; created_by: string; section_scope: string | null }>();
      return row ? { groupId: row.group_id, ownerId: row.created_by, sectionScope: row.section_scope, table: 'content' } : null;
    }
    case 'HOMEWORK': {
      const row = await db
        .prepare('SELECT group_id, created_by, section_scope FROM homeworks WHERE id = ?1')
        .bind(entityId)
        .first<{ group_id: string; created_by: string; section_scope: string | null }>();
      return row ? { groupId: row.group_id, ownerId: row.created_by, sectionScope: row.section_scope, table: 'homeworks' } : null;
    }
    case 'EXAM': {
      const row = await db
        .prepare('SELECT group_id, created_by, section_scope FROM exams WHERE id = ?1')
        .bind(entityId)
        .first<{ group_id: string; created_by: string; section_scope: string | null }>();
      return row ? { groupId: row.group_id, ownerId: row.created_by, sectionScope: row.section_scope, table: 'exams' } : null;
    }
    case 'EVENT': {
      const row = await db
        .prepare('SELECT group_id, created_by, section_scope FROM events WHERE id = ?1')
        .bind(entityId)
        .first<{ group_id: string; created_by: string; section_scope: string | null }>();
      return row ? { groupId: row.group_id, ownerId: row.created_by, sectionScope: row.section_scope, table: 'events' } : null;
    }
    case 'ISSUE': {
      const row = await db
        .prepare('SELECT group_id, created_by, section_scope FROM issues WHERE id = ?1')
        .bind(entityId)
        .first<{ group_id: string; created_by: string; section_scope: string | null }>();
      return row ? { groupId: row.group_id, ownerId: row.created_by, sectionScope: row.section_scope, table: 'issues' } : null;
    }
    default:
      return null;
  }
}

export async function toggleUseful(ctx: Ctx, entityType: string, entityId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND');
  await requireMembership(ctx, target.groupId);

  const result = await toggleReaction(db, { id: newId('rctn'), entityType, entityId, userId: user.id, now: ctx.now });
  if (target.table === 'content') {
    await db.prepare('UPDATE content SET useful_count = MAX(0, useful_count + ?1) WHERE id = ?2').bind(result.active ? 1 : -1, entityId).run();
  } else {
    await db.prepare(`UPDATE ${target.table} SET useful_count = MAX(0, useful_count + ?1) WHERE id = ?2`).bind(result.active ? 1 : -1, entityId).run();
  }
  return result;
}

export async function toggleSaved(ctx: Ctx, entityType: string, entityId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND');
  await requireMembership(ctx, target.groupId);
  return toggleBookmark(db, { id: newId('bkmk'), userId: user.id, entityType, entityId, groupId: target.groupId, now: ctx.now });
}

/** ⚠️ خطأ في المحتوى → correction request, never an instant edit (§62, §126). */
export async function requestCorrection(ctx: Ctx, entityType: string, entityId: string) {
  const input = await ctx.require(
    V.object({
      field: V.oneOf(['study_date', 'subject_id', 'section_scope', 'title', 'exam_date', 'due_date', 'event_date', 'content'] as const),
      proposedValue: V.string({ min: 1, max: 400 }),
      reason: V.string({ min: 3, max: 400 }),
      clientUploadId: V.optional(V.string({ max: 120 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND');

  const { insertCorrectionRequest, findPendingCorrection } = await import('../db/queries/votes');
  const existing = await findPendingCorrection(db, entityType, entityId, input.field);
  if (existing) throw new ApiError('DUPLICATE_REQUEST');

  const { eligibleVoters } = await import('../db/queries/groups');
  const voters = await eligibleVoters(db, target.groupId);
  const requestId = newId('crq');
  const current = await currentFieldValue(db, entityType, entityId, input.field);
  await insertCorrectionRequest(db, {
    id: requestId,
    groupId: target.groupId,
    entityType,
    entityId,
    field: input.field,
    currentValue: current,
    proposedValue: input.proposedValue,
    reason: input.reason,
    eligibleCount: voters.length,
    requestedBy: user.id,
    now: ctx.now,
  });

  if (target.ownerId) {
    await notifyUsers(ctx, [target.ownerId], {
      kind: 'CONTRIBUTION',
      title: '⚠️ اقتراح تصحيح',
      body: input.reason.slice(0, 120),
      groupId: target.groupId,
      entityType,
      entityId,
      deepLink: `tanweer://correction/${requestId}`,
      batchKey: `correction:${entityId}`,
      priority: 'NORMAL',
    });
  }
  audit(ctx, { action: 'correction.requested', entityType, entityId, groupId: target.groupId, meta: { field: input.field } });
  return { requestId, status: 'PENDING', eligible: voters.length };
}

async function currentFieldValue(db: D1Database, entityType: string, entityId: string, field: string): Promise<string | null> {
  const table = entityType === 'CONTENT' ? 'content' : entityType === 'HOMEWORK' ? 'homeworks' : entityType === 'EXAM' ? 'exams' : entityType === 'EVENT' ? 'events' : 'issues';
  const allowed = ['study_date', 'subject_id', 'section_scope', 'title', 'exam_date', 'due_date', 'event_date'];
  if (!allowed.includes(field)) return null;
  const row = await db.prepare(`SELECT ${field} AS value FROM ${table} WHERE id = ?1`).bind(entityId).first<{ value: string | number | null }>();
  return row?.value === null || row?.value === undefined ? null : String(row.value);
}

/** 🗑 removal request (§60): open to everyone, decided by everyone. */
export async function requestDeletion(ctx: Ctx, entityType: string, entityId: string) {
  const input = await ctx.require(
    V.object({
      reason: V.string({ min: 3, max: 400 }),
      clientUploadId: V.optional(V.string({ max: 120 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const target = await resolveEntity(db, entityType, entityId);
  if (!target) throw new ApiError('NOT_FOUND');
  await requireMembership(ctx, target.groupId);

  const { insertDeletionRequest, findPendingDeletion } = await import('../db/queries/votes');
  const existing = await findPendingDeletion(db, entityType, entityId);
  if (existing) throw new ApiError('DUPLICATE_REQUEST');

  const { eligibleVoters } = await import('../db/queries/groups');
  const voters = await eligibleVoters(db, target.groupId);
  const requestId = newId('drq');
  await insertDeletionRequest(db, {
    id: requestId,
    groupId: target.groupId,
    entityType,
    entityId,
    reason: input.reason,
    eligibleCount: voters.length,
    requestedBy: user.id,
    now: ctx.now,
  });

  if (target.table === 'content') {
    await setContentStatus(db, entityId, 'PENDING_DELETION', ctx.now);
  } else {
    await db.prepare(`UPDATE ${target.table} SET status = 'PENDING_DELETION', updated_at = ?1 WHERE id = ?2`).bind(ctx.now, entityId).run();
  }

  await notifyUsers(ctx, voters.filter((id) => id !== user.id), {
    kind: 'CONTRIBUTION',
    title: '🗑 طلب إزالة',
    body: input.reason.slice(0, 120),
    groupId: target.groupId,
    entityType,
    entityId,
    deepLink: `tanweer://deletion/${requestId}`,
    batchKey: `deletion:${entityId}`,
    priority: 'HIGH',
  });
  audit(ctx, { action: 'deletion.requested', entityType, entityId, groupId: target.groupId });
  return { requestId, status: 'PENDING', eligible: voters.length };
}

export async function contextForContent(ctx: Ctx, contentId: string) {
  const db = ctx.env.TANWEER_DB;
  const row = await findContentById(db, contentId);
  if (!row) throw new ApiError('CONTENT_NOT_FOUND');
  const group = await findGroupById(db, row.group_id);
  return { content: row, group };
}
