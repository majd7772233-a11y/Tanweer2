/**
 * Content: lessons, photos, files, notes, summaries and links.
 *
 * A lesson with four board photos is ONE content row with four media rows
 * (§17). When five students upload the same page, the checksum turns the extra
 * uploads into contributions of the same lesson instead of five posts (§19).
 */
import { allRows, firstOrNull, limitOrDefault, type Cursor } from './shared';

export type ContentType = 'LESSON' | 'PHOTO' | 'FILE' | 'NOTE' | 'SUMMARY' | 'LINK';
export type ContentStatus =
  | 'DRAFT' | 'PUBLISHED' | 'EDITED' | 'PENDING_CORRECTION'
  | 'PENDING_DELETION' | 'DELETED' | 'ARCHIVED';
export type EntityType = 'CONTENT' | 'HOMEWORK' | 'EXAM' | 'EVENT' | 'ISSUE' | 'BOOK' | 'COMMENT';

export interface ContentRow {
  id: string;
  group_id: string;
  academic_year_id: string;
  subject_id: number | null;
  section_scope: string | null;
  study_date: string;
  period: number | null;
  type: ContentType;
  title: string;
  body: string | null;
  source_url: string | null;
  status: ContentStatus;
  canonical_id: string | null;
  checksum: string | null;
  media_count: number;
  contribution_count: number;
  useful_count: number;
  comment_count: number;
  is_pinned: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
  purge_after: string | null;
  // joined fields (optional)
  author_name?: string;
  author_grade?: number;
  author_section?: string;
  subject_name?: string | null;
  subject_emoji?: string | null;
  subject_color?: string | null;
  group_name?: string;
}

export interface ContentMediaRow {
  id: string;
  content_id: string;
  file_id: string;
  role: 'REFERENCE' | 'EXTRA' | 'ATTACHMENT';
  page_index: number;
  caption: string | null;
  uploaded_by: string;
  created_at: string;
  deleted_at: string | null;
  // joined
  object_key?: string;
  mime_type?: string;
  size_bytes?: number;
  width?: number | null;
  height?: number | null;
  uploader_name?: string;
}

export interface ContentRevisionRow {
  id: string;
  entity_type: string;
  entity_id: string;
  revision: number;
  action: string;
  snapshot: string;
  diff: string | null;
  reason: string | null;
  request_id: string | null;
  changed_by: string;
  changed_at: string;
  changed_by_name?: string;
}

export interface CommentRow {
  id: string;
  group_id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  body: string;
  parent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
  user_name?: string;
  user_grade?: number;
  user_section?: string;
}

const CONTENT_SELECT = `SELECT c.*, u.full_name AS author_name, u.grade_id AS author_grade, u.section_code AS author_section,
                               s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color,
                               g.name AS group_name
                          FROM content c
                          JOIN users u ON u.id = c.created_by
                          JOIN groups g ON g.id = c.group_id
                          LEFT JOIN subjects s ON s.id = c.subject_id`;

export interface InsertContentInput {
  id: string;
  groupId: string;
  academicYearId: string;
  subjectId: number | null;
  sectionScope: string | null;
  studyDate: string;
  period: number | null;
  type: ContentType;
  title: string;
  body: string | null;
  sourceUrl: string | null;
  status?: ContentStatus;
  checksum: string | null;
  createdBy: string;
  now: string;
}

export async function insertContent(db: D1Database, input: InsertContentInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO content (id, group_id, academic_year_id, subject_id, section_scope, study_date, period, type, title, body,
                            source_url, status, checksum, media_count, contribution_count, created_by, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 0, ?14, ?15, ?15, 1)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.academicYearId,
      input.subjectId,
      input.sectionScope,
      input.studyDate,
      input.period,
      input.type,
      input.title,
      input.body,
      input.sourceUrl,
      input.status ?? 'PUBLISHED',
      input.checksum,
      input.createdBy,
      input.now,
    )
    .run();
}

export function findContentById(db: D1Database, id: string): Promise<ContentRow | null> {
  return firstOrNull<ContentRow>(db.prepare(`${CONTENT_SELECT} WHERE c.id = ?1`).bind(id));
}

/** Duplicate detection (§19): same group, same day, same bytes. */
export function findContentByChecksum(db: D1Database, groupId: string, checksum: string, studyDate: string): Promise<ContentRow | null> {
  return firstOrNull<ContentRow>(
    db
      .prepare(`${CONTENT_SELECT} WHERE c.group_id = ?1 AND c.checksum = ?2 AND c.study_date = ?3 AND c.status NOT IN ('DELETED','ARCHIVED') LIMIT 1`)
      .bind(groupId, checksum, studyDate),
  );
}

/** Older uploads of the same page that could be merged (§20). */
export function findSimilarContent(db: D1Database, groupId: string, title: string, studyDate: string, limit = 3): Promise<ContentRow[]> {
  return allRows<ContentRow>(
    db
      .prepare(
        `${CONTENT_SELECT}
          WHERE c.group_id = ?1 AND c.study_date = ?2 AND c.title LIKE ?3 AND c.status NOT IN ('DELETED','ARCHIVED')
          ORDER BY c.created_at DESC LIMIT ?4`,
      )
      .bind(groupId, studyDate, `%${title.trim().slice(0, 24)}%`, limit),
  );
}

export interface ContentFilter {
  groupId: string;
  section?: string | null;
  subjectId?: number | null;
  type?: ContentType | null;
  from?: string | null;
  to?: string | null;
  authorId?: string | null;
  date?: string | null;
  bookmarked?: never;
  cursor?: Cursor | null;
  limit?: number;
  includeDeleted?: boolean;
}

export async function listContent(db: D1Database, filter: ContentFilter): Promise<ContentRow[]> {
  const where: string[] = ['c.group_id = ?1'];
  const bindings: unknown[] = [filter.groupId];

  if (!filter.includeDeleted) where.push("c.status NOT IN ('DELETED','ARCHIVED')");
  if (filter.section) {
    where.push(`(c.section_scope IS NULL OR c.section_scope = ?${bindings.length + 1})`);
    bindings.push(filter.section);
  }
  if (filter.subjectId) {
    where.push(`c.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.type) {
    where.push(`c.type = ?${bindings.length + 1}`);
    bindings.push(filter.type);
  }
  if (filter.date) {
    where.push(`c.study_date = ?${bindings.length + 1}`);
    bindings.push(filter.date);
  }
  if (filter.from) {
    where.push(`c.study_date >= ?${bindings.length + 1}`);
    bindings.push(filter.from);
  }
  if (filter.to) {
    where.push(`c.study_date <= ?${bindings.length + 1}`);
    bindings.push(filter.to);
  }
  if (filter.authorId) {
    where.push(`c.created_by = ?${bindings.length + 1}`);
    bindings.push(filter.authorId);
  }
  if (filter.cursor) {
    where.push(`(c.created_at < ?${bindings.length + 1} OR (c.created_at = ?${bindings.length + 1} AND c.id < ?${bindings.length + 2}))`);
    bindings.push(filter.cursor.ts, filter.cursor.id);
  }

  const limit = limitOrDefault(filter.limit, 30, 100);
  bindings.push(limit);
  return allRows<ContentRow>(
    db.prepare(`${CONTENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.study_date DESC, c.created_at DESC LIMIT ?${bindings.length}`).bind(...bindings),
  );
}

export async function updateContentFields(
  db: D1Database,
  id: string,
  patch: Partial<Pick<ContentRow, 'title' | 'body' | 'subject_id' | 'study_date' | 'section_scope' | 'type' | 'period' | 'source_url' | 'is_pinned' | 'status'>>,
  meta: { now: string; expectedRevision?: number },
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?${values.length + 1}`);
    values.push(value);
  }
  if (sets.length === 0) return true;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(meta.now);
  sets.push('revision = revision + 1');
  const where = [`id = ?${values.length + 1}`];
  values.push(id);
  if (meta.expectedRevision !== undefined) {
    where.push(`revision = ?${values.length + 1}`);
    values.push(meta.expectedRevision);
  }
  const result = await db.prepare(`UPDATE content SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).bind(...values).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function setContentStatus(db: D1Database, id: string, status: ContentStatus, now: string, purgeAfter?: string | null): Promise<void> {
  await db
    .prepare('UPDATE content SET status = ?1, updated_at = ?2, purge_after = ?3, revision = revision + 1 WHERE id = ?4')
    .bind(status, now, purgeAfter ?? null, id)
    .run();
}

export async function setCanonical(db: D1Database, id: string, canonicalId: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE content SET canonical_id = ?1, status = 'ARCHIVED', updated_at = ?2, revision = revision + 1 WHERE id = ?3")
    .bind(canonicalId, now, id)
    .run();
}

export async function incrementContentCounters(
  db: D1Database,
  id: string,
  delta: { media?: number; contributions?: number; useful?: number; comments?: number },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (delta.media !== undefined) {
    sets.push(`media_count = MAX(0, media_count + ?${values.length + 1})`);
    values.push(delta.media);
  }
  if (delta.contributions !== undefined) {
    sets.push(`contribution_count = MAX(0, contribution_count + ?${values.length + 1})`);
    values.push(delta.contributions);
  }
  if (delta.useful !== undefined) {
    sets.push(`useful_count = MAX(0, useful_count + ?${values.length + 1})`);
    values.push(delta.useful);
  }
  if (delta.comments !== undefined) {
    sets.push(`comment_count = MAX(0, comment_count + ?${values.length + 1})`);
    values.push(delta.comments);
  }
  if (sets.length === 0) return;
  values.push(id);
  await db.prepare(`UPDATE content SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
}

// ── media ────────────────────────────────────────────────────────────────────

const MEDIA_SELECT = `SELECT m.*, f.object_key, f.mime_type, f.size_bytes, f.width, f.height, u.full_name AS uploader_name
                        FROM content_media m
                        JOIN files f ON f.id = m.file_id
                        JOIN users u ON u.id = m.uploaded_by`;

export function listMedia(db: D1Database, contentId: string): Promise<ContentMediaRow[]> {
  return allRows<ContentMediaRow>(db.prepare(`${MEDIA_SELECT} WHERE m.content_id = ?1 AND m.deleted_at IS NULL ORDER BY m.page_index ASC`).bind(contentId));
}

export async function listMediaForContents(db: D1Database, contentIds: string[]): Promise<Map<string, ContentMediaRow[]>> {
  const grouped = new Map<string, ContentMediaRow[]>();
  if (contentIds.length === 0) return grouped;
  const rows = await allRows<ContentMediaRow>(
    db.prepare(`${MEDIA_SELECT} WHERE m.content_id IN (${contentIds.map(() => '?').join(', ')}) AND m.deleted_at IS NULL ORDER BY m.page_index ASC`).bind(...contentIds),
  );
  for (const row of rows) {
    const bucket = grouped.get(row.content_id) ?? [];
    bucket.push(row);
    grouped.set(row.content_id, bucket);
  }
  return grouped;
}

export interface InsertMediaInput {
  id: string;
  contentId: string;
  fileId: string;
  role: 'REFERENCE' | 'EXTRA' | 'ATTACHMENT';
  pageIndex: number;
  caption: string | null;
  uploadedBy: string;
  now: string;
}

export async function insertMedia(db: D1Database, input: InsertMediaInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO content_media (id, content_id, file_id, role, page_index, caption, uploaded_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(input.id, input.contentId, input.fileId, input.role, input.pageIndex, input.caption, input.uploadedBy, input.now)
    .run();
}

export async function moveMediaToContent(db: D1Database, fromContentId: string, toContentId: string, now: string): Promise<void> {
  await db
    .prepare('UPDATE content_media SET content_id = ?1, created_at = ?2 WHERE content_id = ?3')
    .bind(toContentId, now, fromContentId)
    .run();
}

export async function nextPageIndex(db: D1Database, contentId: string): Promise<number> {
  const row = await firstOrNull<{ n: number | null }>(
    db.prepare('SELECT MAX(page_index) AS n FROM content_media WHERE content_id = ?1').bind(contentId),
  );
  return (row?.n ?? -1) + 1;
}

export async function insertContribution(
  db: D1Database,
  input: { id: string; contentId: string; userId: string; fileId: string | null; kind: string; note: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO content_contributions (id, content_id, user_id, file_id, kind, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(input.id, input.contentId, input.userId, input.fileId, input.kind, input.note, input.now)
    .run();
}

export function listContributions(db: D1Database, contentId: string): Promise<Array<{ id: string; user_id: string; kind: string; note: string | null; created_at: string; full_name: string; grade_id: number; section_code: string; file_id: string | null }>> {
  return allRows(
    db
      .prepare(
        `SELECT cc.*, u.full_name, u.grade_id, u.section_code
           FROM content_contributions cc JOIN users u ON u.id = cc.user_id
          WHERE cc.content_id = ?1 ORDER BY cc.created_at ASC LIMIT 200`,
      )
      .bind(contentId),
  );
}

// ── relations / revisions ────────────────────────────────────────────────────

export async function insertRelation(
  db: D1Database,
  input: { id: string; groupId: string; fromType: string; fromId: string; toType: string; toId: string; kind: string; createdBy: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO content_relations (id, group_id, from_type, from_id, to_type, to_id, kind, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(input.id, input.groupId, input.fromType, input.fromId, input.toType, input.toId, input.kind, input.createdBy, input.now)
    .run();
}

export interface RelationRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  kind: string;
  created_at: string;
}

export function listRelations(db: D1Database, entityType: string, entityId: string, kind?: string): Promise<RelationRow[]> {
  const statement = kind
    ? db.prepare('SELECT * FROM content_relations WHERE from_type = ?1 AND from_id = ?2 AND kind = ?3 ORDER BY created_at ASC LIMIT 200').bind(entityType, entityId, kind)
    : db.prepare('SELECT * FROM content_relations WHERE from_type = ?1 AND from_id = ?2 ORDER BY created_at ASC LIMIT 200').bind(entityType, entityId);
  return allRows<RelationRow>(statement);
}

export async function deleteRelation(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM content_relations WHERE id = ?1').bind(id).run();
}

export async function insertRevision(
  db: D1Database,
  input: {
    id: string;
    entityType: string;
    entityId: string;
    revision: number;
    action: string;
    snapshot: unknown;
    diff?: unknown;
    reason?: string | null;
    requestId?: string | null;
    changedBy: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, action, snapshot, diff, reason, request_id, changed_by, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      input.id,
      input.entityType,
      input.entityId,
      input.revision,
      input.action,
      JSON.stringify(input.snapshot ?? null),
      input.diff === undefined ? null : JSON.stringify(input.diff),
      input.reason ?? null,
      input.requestId ?? null,
      input.changedBy,
      input.now,
    )
    .run();
}

export function listRevisions(db: D1Database, entityType: string, entityId: string, limit = 50): Promise<ContentRevisionRow[]> {
  return allRows<ContentRevisionRow>(
    db
      .prepare(
        `SELECT r.*, u.full_name AS changed_by_name FROM content_revisions r
           JOIN users u ON u.id = r.changed_by
          WHERE r.entity_type = ?1 AND r.entity_id = ?2
          ORDER BY r.revision DESC LIMIT ?3`,
      )
      .bind(entityType, entityId, limit),
  );
}

// ── comments, reactions, bookmarks, pins ─────────────────────────────────────

export function listComments(db: D1Database, entityType: string, entityId: string, limit = 100): Promise<CommentRow[]> {
  return allRows<CommentRow>(
    db
      .prepare(
        `SELECT cm.*, u.full_name AS user_name, u.grade_id AS user_grade, u.section_code AS user_section
           FROM comments cm JOIN users u ON u.id = cm.user_id
          WHERE cm.entity_type = ?1 AND cm.entity_id = ?2 AND cm.status = 'VISIBLE'
          ORDER BY cm.created_at ASC LIMIT ?3`,
      )
      .bind(entityType, entityId, limit),
  );
}

export function findComment(db: D1Database, id: string): Promise<CommentRow | null> {
  return firstOrNull<CommentRow>(db.prepare('SELECT * FROM comments WHERE id = ?1').bind(id));
}

export async function insertComment(
  db: D1Database,
  input: { id: string; groupId: string; entityType: string; entityId: string; userId: string; body: string; parentId: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO comments (id, group_id, entity_type, entity_id, user_id, body, parent_id, status, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'VISIBLE', ?8, ?8, 1)`,
    )
    .bind(input.id, input.groupId, input.entityType, input.entityId, input.userId, input.body, input.parentId, input.now)
    .run();
}

export async function setCommentStatus(db: D1Database, id: string, status: 'VISIBLE' | 'HIDDEN' | 'DELETED', now: string): Promise<void> {
  await db.prepare('UPDATE comments SET status = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3').bind(status, now, id).run();
}

export async function setEntityCommentCount(db: D1Database, table: 'content' | 'homeworks' | 'exams' | 'events' | 'issues', id: string, delta: number): Promise<void> {
  await db.prepare(`UPDATE ${table} SET comment_count = MAX(0, comment_count + ?1) WHERE id = ?2`).bind(delta, id).run();
}

export async function toggleReaction(
  db: D1Database,
  input: { id: string; entityType: string; entityId: string; userId: string; now: string },
): Promise<{ active: boolean }> {
  const existing = await firstOrNull<{ id: string }>(
    db
      .prepare("SELECT id FROM reactions WHERE entity_type = ?1 AND entity_id = ?2 AND user_id = ?3 AND kind = 'USEFUL'")
      .bind(input.entityType, input.entityId, input.userId),
  );
  if (existing) {
    await db.prepare('DELETE FROM reactions WHERE id = ?1').bind(existing.id).run();
    return { active: false };
  }
  await db
    .prepare("INSERT INTO reactions (id, entity_type, entity_id, user_id, kind, created_at) VALUES (?1, ?2, ?3, ?4, 'USEFUL', ?5)")
    .bind(input.id, input.entityType, input.entityId, input.userId, input.now)
    .run();
  return { active: true };
}

export async function reactionState(db: D1Database, entityType: string, entityIds: string[], userId: string): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const rows = await allRows<{ entity_id: string }>(
    db
      .prepare(
        `SELECT entity_id FROM reactions WHERE entity_type = ?1 AND user_id = ?2 AND kind = 'USEFUL'
           AND entity_id IN (${entityIds.map(() => '?').join(', ')})`,
      )
      .bind(entityType, userId, ...entityIds),
  );
  return new Set(rows.map((row) => row.entity_id));
}

export async function toggleBookmark(
  db: D1Database,
  input: { id: string; userId: string; entityType: string; entityId: string; groupId: string | null; now: string },
): Promise<{ active: boolean }> {
  const existing = await firstOrNull<{ id: string }>(
    db.prepare('SELECT id FROM bookmarks WHERE user_id = ?1 AND entity_type = ?2 AND entity_id = ?3').bind(input.userId, input.entityType, input.entityId),
  );
  if (existing) {
    await db.prepare('DELETE FROM bookmarks WHERE id = ?1').bind(existing.id).run();
    return { active: false };
  }
  await db
    .prepare('INSERT INTO bookmarks (id, user_id, entity_type, entity_id, group_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(input.id, input.userId, input.entityType, input.entityId, input.groupId, input.now)
    .run();
  return { active: true };
}

export interface BookmarkRow {
  id: string;
  entity_type: string;
  entity_id: string;
  group_id: string | null;
  created_at: string;
}

export function listBookmarks(db: D1Database, userId: string, entityType?: string, limit = 50): Promise<BookmarkRow[]> {
  const statement = entityType
    ? db
        .prepare('SELECT id, entity_type, entity_id, group_id, created_at FROM bookmarks WHERE user_id = ?1 AND entity_type = ?2 ORDER BY created_at DESC LIMIT ?3')
        .bind(userId, entityType, limit)
    : db
        .prepare('SELECT id, entity_type, entity_id, group_id, created_at FROM bookmarks WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2')
        .bind(userId, limit);
  return allRows<BookmarkRow>(statement);
}

export async function bookmarkState(db: D1Database, userId: string, entityType: string, entityIds: string[]): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const rows = await allRows<{ entity_id: string }>(
    db
      .prepare(
        `SELECT entity_id FROM bookmarks WHERE user_id = ?1 AND entity_type = ?2
           AND entity_id IN (${entityIds.map(() => '?').join(', ')})`,
      )
      .bind(userId, entityType, ...entityIds),
  );
  return new Set(rows.map((row) => row.entity_id));
}

export interface PinnedRow {
  id: string;
  entity_type: string;
  entity_id: string;
  note: string | null;
  created_at: string;
}

export function listPins(db: D1Database, groupId: string, limit = 20): Promise<PinnedRow[]> {
  return allRows<PinnedRow>(
    db.prepare('SELECT id, entity_type, entity_id, note, created_at FROM pins WHERE group_id = ?1 ORDER BY created_at DESC LIMIT ?2').bind(groupId, limit),
  );
}

export async function pinEntity(
  db: D1Database,
  input: { id: string; groupId: string; entityType: string; entityId: string; pinnedBy: string; note: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pins (id, group_id, entity_type, entity_id, pinned_by, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(input.id, input.groupId, input.entityType, input.entityId, input.pinnedBy, input.note, input.now)
    .run();
}

export async function unpinEntity(db: D1Database, groupId: string, entityType: string, entityId: string): Promise<void> {
  await db.prepare('DELETE FROM pins WHERE group_id = ?1 AND entity_type = ?2 AND entity_id = ?3').bind(groupId, entityType, entityId).run();
}

/** Subject timeline (§34): everything that happened in one subject, in order. */
export async function subjectTimeline(db: D1Database, groupId: string, subjectId: number, section: string | null, limit = 100): Promise<Array<{ kind: string; id: string; date: string; title: string; status: string; created_at: string }>> {
  const clamp = section ? `AND (section_scope IS NULL OR section_scope = '${section.replace(/'/g, "''")}')` : '';
  const [content, homeworks, exams] = await db.batch<{ id: string; date: string; title: string; status: string; created_at: string }>([
    db
      .prepare(
        `SELECT id, study_date AS date, title, status, created_at, 'CONTENT' AS kind FROM content
          WHERE group_id = ?1 AND subject_id = ?2 AND status NOT IN ('DELETED','ARCHIVED') ${clamp}
          ORDER BY study_date DESC LIMIT ?3`,
      )
      .bind(groupId, subjectId, limit),
    db
      .prepare(
        `SELECT id, study_date AS date, title, status, created_at, 'HOMEWORK' AS kind FROM homeworks
          WHERE group_id = ?1 AND subject_id = ?2 AND status NOT IN ('DELETED','ARCHIVED') ${clamp}
          ORDER BY study_date DESC LIMIT ?3`,
      )
      .bind(groupId, subjectId, limit),
    db
      .prepare(
        `SELECT id, exam_date AS date, title, status, created_at, 'EXAM' AS kind FROM exams
          WHERE group_id = ?1 AND subject_id = ?2 AND status NOT IN ('DELETED','ARCHIVED') ${clamp}
          ORDER BY exam_date DESC LIMIT ?3`,
      )
      .bind(groupId, subjectId, limit),
  ]);

  const merged = [...(content?.results ?? []), ...(homeworks?.results ?? []), ...(exams?.results ?? [])] as Array<{
    kind: string;
    id: string;
    date: string;
    title: string;
    status: string;
    created_at: string;
  }>;
  merged.sort((a, b) => (a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date)));
  return merged.slice(0, limit);
}
