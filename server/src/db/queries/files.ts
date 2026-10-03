/**
 * File metadata only — the bytes always live in R2 (§47, §81).
 */
import { allRows, firstOrNull } from './shared';

export interface FileRow {
  id: string;
  object_key: string;
  owner_id: string | null;
  group_id: string | null;
  purpose: string;
  mime_type: string;
  kind: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  page_count: number | null;
  checksum: string | null;
  perceptual: string | null;
  status: 'PENDING' | 'READY' | 'DELETED';
  meta: string | null;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

export interface UploadIntentRow {
  id: string;
  user_id: string;
  group_id: string | null;
  object_key: string;
  purpose: string;
  mime_type: string;
  size_bytes: number;
  checksum: string | null;
  file_id: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export function findFileById(db: D1Database, id: string): Promise<FileRow | null> {
  return firstOrNull<FileRow>(db.prepare('SELECT * FROM files WHERE id = ?1').bind(id));
}

export function findFileByObjectKey(db: D1Database, objectKey: string): Promise<FileRow | null> {
  return firstOrNull<FileRow>(db.prepare('SELECT * FROM files WHERE object_key = ?1').bind(objectKey));
}

export function findFilesByChecksum(db: D1Database, checksum: string, groupId: string | null): Promise<FileRow[]> {
  const statement = groupId
    ? db
        .prepare("SELECT * FROM files WHERE checksum = ?1 AND group_id = ?2 AND status = 'READY' ORDER BY created_at ASC LIMIT 10")
        .bind(checksum, groupId)
    : db.prepare("SELECT * FROM files WHERE checksum = ?1 AND status = 'READY' ORDER BY created_at ASC LIMIT 10").bind(checksum);
  return allRows<FileRow>(statement);
}

export async function insertFile(
  db: D1Database,
  input: {
    id: string;
    objectKey: string;
    ownerId: string;
    groupId: string | null;
    purpose: string;
    mimeType: string;
    kind: string;
    sizeBytes: number;
    checksum: string | null;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO files (id, object_key, owner_id, group_id, purpose, mime_type, kind, size_bytes, checksum, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'PENDING', ?10)`,
    )
    .bind(input.id, input.objectKey, input.ownerId, input.groupId, input.purpose, input.mimeType, input.kind, input.sizeBytes, input.checksum, input.now)
    .run();
}

export async function completeFile(
  db: D1Database,
  fileId: string,
  details: { sizeBytes?: number; width?: number | null; height?: number | null; checksum?: string | null; pageCount?: number | null; meta?: string | null },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE files SET status = 'READY', completed_at = ?1,
                        size_bytes = COALESCE(?2, size_bytes),
                        width = COALESCE(?3, width),
                        height = COALESCE(?4, height),
                        checksum = COALESCE(?5, checksum),
                        page_count = COALESCE(?6, page_count),
                        meta = COALESCE(?7, meta)
        WHERE id = ?8`,
    )
    .bind(now, details.sizeBytes ?? null, details.width ?? null, details.height ?? null, details.checksum ?? null, details.pageCount ?? null, details.meta ?? null, fileId)
    .run();
}

export async function markFileDeleted(db: D1Database, fileId: string, now: string): Promise<void> {
  await db.prepare("UPDATE files SET status = 'DELETED', deleted_at = ?1 WHERE id = ?2").bind(now, fileId).run();
}

export function filesByIds(db: D1Database, ids: string[]): Promise<FileRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return allRows<FileRow>(db.prepare(`SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids));
}

// ── upload intents ───────────────────────────────────────────────────────────

export async function insertUploadIntent(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    groupId: string | null;
    objectKey: string;
    purpose: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string | null;
    fileId: string;
    expiresAt: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO upload_intents (id, user_id, group_id, object_key, purpose, mime_type, size_bytes, checksum, file_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      input.id,
      input.userId,
      input.groupId,
      input.objectKey,
      input.purpose,
      input.mimeType,
      input.sizeBytes,
      input.checksum,
      input.fileId,
      input.now,
      input.expiresAt,
    )
    .run();
}

export function findUploadIntent(db: D1Database, id: string): Promise<UploadIntentRow | null> {
  return firstOrNull<UploadIntentRow>(db.prepare('SELECT * FROM upload_intents WHERE id = ?1').bind(id));
}

export async function completeUploadIntent(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare('UPDATE upload_intents SET completed_at = ?1 WHERE id = ?2').bind(now, id).run();
}

export async function purgeExpiredUploads(db: D1Database, now: string, limit = 100): Promise<UploadIntentRow[]> {
  const rows = await allRows<UploadIntentRow>(
    db.prepare('SELECT * FROM upload_intents WHERE completed_at IS NULL AND expires_at < ?1 LIMIT ?2').bind(now, limit),
  );
  return rows;
}
