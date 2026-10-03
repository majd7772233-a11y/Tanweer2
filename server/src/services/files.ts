/**
 * Files: upload intents, signed gateway URLs, metadata (§47, §48, §85, §86).
 *
 * The bytes never pass through D1 and are never stored in a table. The Worker
 * only *streams* them: `request.body` → R2 on upload, R2 → response on
 * download, so a 25 MB PDF does not sit in memory.
 *
 * Cloudflare's binding cannot presign an R2 URL, so Tanweer issues its own
 * short-lived signed URLs pointing at the gateway below. They carry an expiry
 * and an HMAC over the object key, exactly like a presigned URL does.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { signObjectKey, verifyObjectSignature } from '../lib/crypto';
import { maxUploadBytes } from '../env';
import { completeFile, findFileById, insertFile, insertUploadIntent, markFileDeleted } from '../db/queries/files';
import { requireMembership } from '../middleware/permissions';
import { mediaDto } from './dto';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
]);

function kindOf(mime: string): 'IMAGE' | 'PDF' | 'DOC' | 'AUDIO' | 'VIDEO' | 'OTHER' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.includes('word') || mime.includes('excel') || mime === 'text/plain') return 'DOC';
  return 'OTHER';
}

function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
  };
  return map[mime] ?? 'bin';
}

const intentSchema = V.object({
  groupId: V.optional(V.string({ max: 80 })),
  purpose: V.withDefault(
    V.oneOf(['CONTENT_MEDIA', 'AVATAR', 'BOOK', 'CHAT_ATTACHMENT', 'SUBMISSION'] as const),
    'CONTENT_MEDIA',
  ),
  mimeType: V.string({ min: 3, max: 120 }),
  sizeBytes: V.number({ min: 1, max: 200 * 1024 * 1024 }),
  checksum: V.optional(V.string({ min: 16, max: 128 })),
  fileName: V.optional(V.string({ max: 160 })),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function uploadIntent(ctx: Ctx) {
  const input = await ctx.require(intentSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', `نوع الملف ${input.mimeType} غير مدعوم.`);
  }
  const limit = maxUploadBytes(ctx.env);
  if (input.sizeBytes > limit) throw new ApiError('PAYLOAD_TOO_LARGE', `الحد الأقصى ${Math.floor(limit / (1024 * 1024))} ميجابايت.`);
  if (input.groupId) await requireMembership(ctx, input.groupId);

  const db = ctx.env.TANWEER_DB;
  const fileId = newId('file');
  const objectKey = `tanweer/${input.purpose.toLowerCase()}/${user.id}/${fileId}.${extensionFor(input.mimeType)}`;

  await insertFile(db, {
    id: fileId,
    objectKey,
    ownerId: user.id,
    groupId: input.groupId ?? null,
    purpose: input.purpose,
    mimeType: input.mimeType,
    kind: kindOf(input.mimeType),
    sizeBytes: input.sizeBytes,
    checksum: input.checksum ?? null,
    now: ctx.now,
  });

  const intentId = newId('uint');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await insertUploadIntent(db, {
    id: intentId,
    userId: user.id,
    groupId: input.groupId ?? null,
    objectKey,
    purpose: input.purpose,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum ?? null,
    fileId,
    expiresAt,
    now: ctx.now,
  });

  const expires = Math.floor(Date.now() / 1000) + 3600;
  const signature = await signObjectKey(ctx.env.FILE_SIGNING_SECRET, objectKey, expires);

  return {
    fileId,
    uploadIntentId: intentId,
    /** PUT the bytes here (streamed straight into R2, never buffered). */
    uploadUrl: `${ctx.url.origin}/api/v1/files/upload/${fileId}?expires=${expires}&signature=${signature}`,
    method: 'PUT',
    headers: { 'content-type': input.mimeType },
    expiresAt,
    maxBytes: limit,
  };
}

/** PUT /files/upload/:fileId — the signed gateway that writes into R2. */
export async function receiveUpload(ctx: Ctx) {
  const fileId = ctx.param('fileId');
  const db = ctx.env.TANWEER_DB;
  const file = await findFileById(db, fileId);
  if (!file) throw new ApiError('FILE_NOT_FOUND');

  const expires = Number.parseInt(ctx.q('expires') ?? '0', 10);
  const signature = ctx.q('signature') ?? '';
  const valid = await verifyObjectSignature(ctx.env.FILE_SIGNING_SECRET, file.object_key, expires, signature);
  if (!valid) throw new ApiError('FORBIDDEN', 'رابط الرفع غير صالح أو انتهى.');

  if (!ctx.req.body) throw new ApiError('VALIDATION_ERROR', 'لا توجد بيانات.');
  const contentLength = Number.parseInt(ctx.req.headers.get('content-length') ?? '0', 10);
  const limit = maxUploadBytes(ctx.env);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new ApiError('PAYLOAD_TOO_LARGE');

  const mimeType = ctx.req.headers.get('content-type') ?? file.mime_type;
  await ctx.env.TANWEER_FILES.put(file.object_key, ctx.req.body, {
    httpMetadata: { contentType: mimeType, cacheControl: 'private, max-age=31536000' },
    customMetadata: { ownerId: file.owner_id ?? '', purpose: file.purpose },
  });

  const head = await ctx.env.TANWEER_FILES.head(file.object_key);
  const uploadedSize = head?.size ?? (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined);
  // keep the client's own sha256 (declared in the upload intent) — the R2 md5 is not a fingerprint
  await completeFile(db, fileId, { sizeBytes: uploadedSize, checksum: file.checksum ?? undefined }, ctx.now);

  return { uploaded: true, fileId, sizeBytes: head?.size ?? contentLength, objectKey: file.object_key };
}

/** POST /files/complete — the client tells us the upload really finished. */
export async function completeUpload(ctx: Ctx) {
  const input = await ctx.require(
    V.object({
      fileId: V.string({ min: 4, max: 80 }),
      width: V.optional(V.number({ min: 1, max: 20000 })),
      height: V.optional(V.number({ min: 1, max: 20000 })),
      pageCount: V.optional(V.number({ min: 1, max: 5000 })),
      checksum: V.optional(V.string({ min: 16, max: 128 })),
      sizeBytes: V.optional(V.number({ min: 1, max: 200 * 1024 * 1024 })),
    }),
  );
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const file = await findFileById(db, input.fileId);
  if (!file) throw new ApiError('FILE_NOT_FOUND');
  if (file.owner_id !== user.id) throw new ApiError('FORBIDDEN');

  await completeFile(
    db,
    file.id,
    { width: input.width ?? null, height: input.height ?? null, pageCount: input.pageCount ?? null, checksum: input.checksum ?? null, sizeBytes: input.sizeBytes },
    ctx.now,
  );
  const { completeUploadIntent } = await import('../db/queries/files');
  await db.prepare('UPDATE upload_intents SET completed_at = ?1 WHERE file_id = ?2').bind(ctx.now, file.id).run();
  void completeUploadIntent;

  const updated = await findFileById(db, file.id);
  return {
    file: updated
      ? {
          id: updated.id,
          mimeType: updated.mime_type,
          kind: updated.kind,
          sizeBytes: updated.size_bytes,
          width: updated.width,
          height: updated.height,
          checksum: updated.checksum,
          status: updated.status,
        }
      : null,
  };
}

/** GET /files/:id/content — signed download (works for images and PDFs). */
export async function serveFile(ctx: Ctx) {
  const fileId = ctx.param('fileId');
  const db = ctx.env.TANWEER_DB;
  const file = await findFileById(db, fileId);
  if (!file || file.status === 'DELETED') throw new ApiError('FILE_NOT_FOUND');

  // Authorisation: either a valid signature, or an authenticated member of the group.
  const expires = Number.parseInt(ctx.q('expires') ?? '0', 10);
  const signature = ctx.q('signature') ?? '';
  let authorised = signature.length > 0 && (await verifyObjectSignature(ctx.env.FILE_SIGNING_SECRET, file.object_key, expires, signature));
  if (!authorised) {
    if (!ctx.user) throw new ApiError('UNAUTHORIZED');
    if (file.group_id) {
      const access = await requireMembership(ctx, file.group_id);
      authorised = access.isMember;
    } else {
      authorised = file.owner_id === ctx.user.id;
    }
  }
  if (!authorised) throw new ApiError('FORBIDDEN');

  const range = ctx.req.headers.get('range');
  const object = range
    ? await ctx.env.TANWEER_FILES.get(file.object_key, { range: parseRange(range) ?? undefined, onlyIf: ctx.req.headers })
    : await ctx.env.TANWEER_FILES.get(file.object_key, { onlyIf: ctx.req.headers });
  if (!object) throw new ApiError('FILE_NOT_FOUND');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=86400');
  headers.set('accept-ranges', 'bytes');
  headers.set('content-disposition', 'inline');
  headers.set('x-tanweer-file-id', file.id);

  if ('body' in object === false) {
    return new Response(null, { status: 304, headers });
  }
  return new Response((object as R2ObjectBody).body, { headers, status: range ? 206 : 200 });
}

function parseRange(header: string): R2Range | null {
  const match = /bytes=(\d*)-(\d*)/.exec(header);
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw && endRaw) return { offset: Number.parseInt(startRaw, 10), length: Number.parseInt(endRaw, 10) - Number.parseInt(startRaw, 10) + 1 };
  if (startRaw) return { offset: Number.parseInt(startRaw, 10) };
  if (endRaw) return { suffix: Number.parseInt(endRaw, 10) };
  return null;
}

/** Signed URL helper used when handing a file to another part of the API. */
export async function signedFileUrl(ctx: Ctx, fileId: string, ttlSeconds = 3600): Promise<string> {
  const file = await findFileById(ctx.env.TANWEER_DB, fileId);
  if (!file) throw new ApiError('FILE_NOT_FOUND');
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await signObjectKey(ctx.env.FILE_SIGNING_SECRET, file.object_key, expires);
  return `${ctx.url.origin}/api/v1/files/${file.id}/content?expires=${expires}&signature=${signature}`;
}

export async function fileMeta(ctx: Ctx, fileId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const file = await findFileById(ctx.env.TANWEER_DB, fileId);
  if (!file) throw new ApiError('FILE_NOT_FOUND');
  if (file.group_id) await requireMembership(ctx, file.group_id);
  return {
    id: file.id,
    mimeType: file.mime_type,
    kind: file.kind,
    sizeBytes: file.size_bytes,
    width: file.width,
    height: file.height,
    checksum: file.checksum,
    status: file.status,
    url: `/api/v1/files/${file.id}/content`,
    signedUrl: await signedFileUrl(ctx, file.id, 900),
  };
}

export async function deleteFile(ctx: Ctx, fileId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const file = await findFileById(db, fileId);
  if (!file) throw new ApiError('FILE_NOT_FOUND');
  if (file.owner_id !== user.id) throw new ApiError('FORBIDDEN');
  await markFileDeleted(db, file.id, ctx.now);
  ctx.waitUntil(ctx.env.TANWEER_FILES.delete(file.object_key).then(() => undefined));
  return { deleted: true };
}

/** Housekeeping used by the scheduled handler (cron). */
export async function purgeExpiredObjects(ctx: Ctx): Promise<number> {
  const db = ctx.env.TANWEER_DB;
  const rows = await db
    .prepare("SELECT object_key FROM files WHERE status = 'PENDING' AND created_at < ?1 LIMIT 50")
    .bind(new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .all<{ object_key: string }>();
  const keys = (rows.results ?? []).map((row) => row.object_key);
  if (keys.length > 0) await ctx.env.TANWEER_FILES.delete(keys);
  await db.prepare("UPDATE files SET status = 'DELETED', deleted_at = ?1 WHERE status = 'PENDING' AND created_at < ?2")
    .bind(ctx.now, new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .run();
  return keys.length;
}

export { mediaDto };
