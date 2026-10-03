/**
 * 💬 المحادثة (§52, §53, §122).
 *
 * The Durable Object owns live fan-out; this service owns the durable copy and
 * the authorisation. Messages carry a body, a time, a reply reference and — at
 * most — a reference to a file in R2. They never carry the educational record.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { internalToken } from '../lib/crypto';
import {
  addRoomMember,
  findMessageByClientId,
  findOrCreateDirectRoom,
  findRoom,
  findRoomForGroup,
  getReadState,
  insertMessage,
  isRoomMember,
  listMessages,
  listRoomMembers,
  listUserRooms,
  setReadState,
  type ChatMessageRow,
} from '../db/queries/chat';
import { findUserById } from '../db/queries/users';
import { maxUploadBytes } from '../env';

function messageDto(row: ChatMessageRow) {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: row.seq,
    body: row.body,
    kind: row.kind,
    fileId: row.file_id,
    replyToId: row.reply_to_id,
    replyPreview: row.reply_preview ?? null,
    replySender: row.reply_sender ?? null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: row.status === 'DELETED',
    sender: {
      id: row.sender_id,
      fullName: row.sender_name ?? '',
      gradeId: row.sender_grade ?? 0,
      sectionCode: row.sender_section ?? '',
      classId: row.sender_grade && row.sender_section ? `${row.sender_grade}-${row.sender_section}` : '',
    },
  };
}

export async function rooms(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const rows = await listUserRooms(ctx.env.TANWEER_DB, user.id);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title ?? row.group_name ?? 'محادثة',
    groupId: row.group_id,
    lastSeq: row.last_seq,
    unread: Number(row.unread ?? 0),
    lastMessageAt: row.last_message_at,
  }));
}

async function requireRoomMembership(ctx: Ctx, roomId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const room = await findRoom(db, roomId);
  if (!room) throw new ApiError('ROOM_NOT_FOUND');
  const member = await isRoomMember(db, roomId, user.id);
  if (!member) throw new ApiError('NOT_A_MEMBER', 'أنت لست عضوًا في هذه المحادثة.');
  return { room, userId: user.id };
}

export async function messages(ctx: Ctx, roomId: string) {
  await requireRoomMembership(ctx, roomId);
  const db = ctx.env.TANWEER_DB;
  const beforeSeq = ctx.qInt('before') ?? null;
  const afterSeq = ctx.qInt('after') ?? null;
  const limit = ctx.qInt('limit') ?? 40;
  const rows = await listMessages(db, roomId, { beforeSeq, afterSeq, limit });
  const read = await getReadState(db, roomId, ctx.user?.id ?? '');
  return {
    items: rows.map(messageDto),
    hasMore: rows.length >= limit,
    cursor: rows.length > 0 ? rows[0]?.seq ?? null : null,
    lastReadSeq: read?.last_read_seq ?? 0,
  };
}

const sendSchema = V.object({
  body: V.optional(V.string({ max: 4000, allowEmpty: true })),
  kind: V.withDefault(V.oneOf(['TEXT', 'ATTACHMENT'] as const), 'TEXT'),
  fileId: V.optional(V.string({ max: 80 })),
  replyToId: V.optional(V.string({ max: 80 })),
  clientId: V.optional(V.string({ max: 80 })),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function send(ctx: Ctx, roomId: string) {
  const input = await ctx.require(sendSchema);
  const { userId } = await requireRoomMembership(ctx, roomId);
  const db = ctx.env.TANWEER_DB;
  const user = await findUserById(db, userId);
  if (!user) throw new ApiError('UNAUTHORIZED');

  if (input.kind === 'ATTACHMENT' && !input.fileId) throw new ApiError('VALIDATION_ERROR', 'أرفق الملف أولًا.');
  if (input.kind === 'TEXT' && (!input.body || input.body.trim().length === 0)) throw new ApiError('VALIDATION_ERROR', 'الرسالة فارغة.');
  if (input.fileId) {
    const file = await db.prepare('SELECT size_bytes, owner_id FROM files WHERE id = ?1').bind(input.fileId).first<{ size_bytes: number; owner_id: string }>();
    if (!file) throw new ApiError('FILE_NOT_FOUND');
    if (file.owner_id !== userId) throw new ApiError('FORBIDDEN');
    if (file.size_bytes > maxUploadBytes(ctx.env)) throw new ApiError('PAYLOAD_TOO_LARGE');
  }

  if (input.clientId) {
    const existing = await findMessageByClientId(db, roomId, userId, input.clientId);
    if (existing) return messageDto(existing);
  }

  const messageId = newId('cmsg');
  const now = ctx.now;

  // The Durable Object owns ordering: it assigns the sequence number.
  const stub = ctx.env.GROUP_CHAT.get(ctx.env.GROUP_CHAT.idFromName(roomId));
  const token = await internalToken(ctx.env);
  const response = await stub.fetch('https://chat.internal/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tanweer-internal': token },
    body: JSON.stringify({
      roomId,
      message: {
        id: messageId,
        senderId: userId,
        senderName: user.full_name,
        body: input.body?.trim() ?? null,
        kind: input.kind,
        fileId: input.fileId ?? null,
        replyToId: input.replyToId ?? null,
        createdAt: now,
      },
    }),
  });

  if (!response.ok) throw new ApiError('INTERNAL_ERROR', 'تعذّر إرسال الرسالة.');
  const { seq } = (await response.json()) as { seq: number };

  await insertMessage(db, {
    id: messageId,
    roomId,
    seq,
    senderId: userId,
    body: input.body?.trim() ?? null,
    kind: input.kind,
    fileId: input.fileId ?? null,
    replyToId: input.replyToId ?? null,
    clientId: input.clientId ?? null,
    now,
  });
  await setReadState(db, roomId, userId, seq, now);

  const row = await db
    .prepare(
      `SELECT m.*, u.full_name AS sender_name, u.grade_id AS sender_grade, u.section_code AS sender_section
         FROM chat_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?1`,
    )
    .bind(messageId)
    .first<ChatMessageRow>();
  return row ? messageDto(row) : { id: messageId, seq };
}

export async function markRead(ctx: Ctx, roomId: string) {
  await requireRoomMembership(ctx, roomId);
  const input = await ctx.require(V.object({ lastSeq: V.number({ min: 0, max: 100_000_000 }) }));
  await setReadState(ctx.env.TANWEER_DB, roomId, ctx.user?.id ?? '', input.lastSeq, ctx.now);
  return { updated: true };
}

export async function typing(ctx: Ctx, roomId: string) {
  const { userId } = await requireRoomMembership(ctx, roomId);
  const stub = ctx.env.GROUP_CHAT.get(ctx.env.GROUP_CHAT.idFromName(roomId));
  const token = await internalToken(ctx.env);
  ctx.waitUntil(
    stub
      .fetch('https://chat.internal/typing', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tanweer-internal': token },
        body: JSON.stringify({ roomId, userId, name: ctx.user?.fullName ?? '' }),
      })
      .then(() => undefined)
      .catch(() => undefined),
  );
  return { ok: true };
}

export async function presence(ctx: Ctx, roomId: string) {
  await requireRoomMembership(ctx, roomId);
  const stub = ctx.env.GROUP_CHAT.get(ctx.env.GROUP_CHAT.idFromName(roomId));
  const token = await internalToken(ctx.env);
  const response = await stub.fetch('https://chat.internal/presence', { headers: { 'x-tanweer-internal': token } });
  if (!response.ok) return { online: 0, members: [] };
  return (await response.json()) as { online: number; members: string[] };
}

export async function members(ctx: Ctx, roomId: string) {
  await requireRoomMembership(ctx, roomId);
  const rows = await listRoomMembers(ctx.env.TANWEER_DB, roomId, 300);
  return rows.map((row) => ({
    id: row.user_id,
    fullName: row.full_name,
    gradeId: row.grade_id,
    sectionCode: row.section_code,
    classId: `${row.grade_id}-${row.section_code}`,
  }));
}

export async function openDirect(ctx: Ctx, otherUserId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  if (otherUserId === user.id) throw new ApiError('VALIDATION_ERROR', 'لا يمكن فتح محادثة مع نفسك.');
  const other = await findUserById(ctx.env.TANWEER_DB, otherUserId);
  if (!other) throw new ApiError('NOT_FOUND', 'المستخدم غير موجود.');
  if (other.status !== 'ACTIVE') throw new ApiError('FORBIDDEN');

  const room = await findOrCreateDirectRoom(ctx.env.TANWEER_DB, user.id, otherUserId, ctx.now);
  return { id: room.id, kind: room.kind, title: other.full_name, groupId: null, lastSeq: room.last_seq, unread: 0, lastMessageAt: room.last_message_at };
}

export async function roomForGroup(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const room = await findRoomForGroup(db, groupId);
  if (!room) throw new ApiError('ROOM_NOT_FOUND');
  const member = await isRoomMember(db, room.id, user.id);
  if (!member) {
    // Joining the group automatically joins its conversation.
    await addRoomMember(db, room.id, user.id, ctx.now);
  }
  return { id: room.id, kind: room.kind, title: room.title, groupId: room.group_id, lastSeq: room.last_seq, unread: 0, lastMessageAt: room.last_message_at };
}
