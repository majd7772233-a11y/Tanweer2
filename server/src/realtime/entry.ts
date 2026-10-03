/**
 * The WebSocket front door: authenticate the socket, prove the membership, then
 * hand the connection to the Durable Object that owns the room (§104).
 *
 * The Worker is the only piece that knows about access tokens; the Durable
 * Object only sees an internal, already authorised connection.
 */
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { errorResponse } from '../lib/response';
import { verifyAccessToken } from '../lib/crypto';
import { findSessionById, findUserById, touchDevice } from '../db/queries/users';
import { addRoomMember, findOrCreateDirectRoom, findRoom, findRoomForGroup, isRoomMember } from '../db/queries/chat';

export async function handleWebSocketUpgrade(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return errorResponse(new ApiError('VALIDATION_ERROR', 'هذا المسار مخصص للاتصال المباشر (WebSocket).'));
  }

  const token = extractToken(request);
  if (!token) return errorResponse(new ApiError('UNAUTHORIZED'));

  const payload = await verifyAccessToken(env.SESSION_PEPPER, token);
  if (!payload) return errorResponse(new ApiError('UNAUTHORIZED', 'انتهت الجلسة. سجّل الدخول من جديد.'));

  const db = env.TANWEER_DB;
  const session = await findSessionById(db, payload.sid);
  if (!session || session.revoked_at !== null || session.expires_at <= new Date().toISOString()) {
    return errorResponse(new ApiError('SESSION_REVOKED'));
  }

  const user = await findUserById(db, payload.sub);
  if (!user || user.status === 'SUSPENDED') return errorResponse(new ApiError('ACCOUNT_SUSPENDED'));

  const roomId = await resolveRoom(request, env, payload.sub, user.full_name);
  if (roomId instanceof Response) return roomId;

  ctx.waitUntil(
    (async () => {
      await touchDevice(db, session.device_id, new Date().toISOString());
    })().catch(() => undefined),
  );

  const upstream = new Request(request.url, request);
  upstream.headers.set('x-tanweer-user-id', payload.sub);
  upstream.headers.set('x-tanweer-room-id', roomId);
  upstream.headers.set('x-tanweer-user-name', encodeURIComponent(user.full_name));

  return env.GROUP_CHAT.get(env.GROUP_CHAT.idFromName(roomId)).fetch(upstream);
}

async function resolveRoom(request: Request, env: Env, userId: string, fullName: string): Promise<string | Response> {
  const url = new URL(request.url);
  const db = env.TANWEER_DB;
  const now = new Date().toISOString();
  let roomId = url.searchParams.get('roomId');

  const groupId = url.searchParams.get('groupId');
  if (!roomId && groupId) {
    const room = await findRoomForGroup(db, groupId);
    if (!room) return errorResponse(new ApiError('ROOM_NOT_FOUND'));
    if (!(await isRoomMember(db, room.id, userId))) await addRoomMember(db, room.id, userId, now);
    roomId = room.id;
  }

  const withUserId = url.searchParams.get('with');
  if (!roomId && withUserId) {
    const room = await findOrCreateDirectRoom(db, userId, withUserId, now);
    roomId = room.id;
  }

  if (!roomId) return errorResponse(new ApiError('VALIDATION_ERROR', 'حدّد المحادثة (roomId أو groupId أو with).'));

  const room = await findRoom(db, roomId);
  if (!room) return errorResponse(new ApiError('ROOM_NOT_FOUND'));
  if (!(await isRoomMember(db, roomId, userId))) {
    if (room.kind === 'DIRECT') return errorResponse(new ApiError('NOT_A_MEMBER', 'أنت لست عضوًا في هذه المحادثة.'));
    await addRoomMember(db, roomId, userId, now);
  }

  void fullName;
  return roomId;
}

function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();

  const query = new URL(request.url).searchParams.get('token');
  if (query) return query;

  // Browsers cannot set headers on WebSocket(); the token may travel as a
  // sub-protocol, which the platform strips back off for us.
  const protocols = request.headers.get('sec-websocket-protocol');
  if (protocols) {
    for (const part of protocols.split(',')) {
      const value = part.trim();
      if (value.startsWith('tanweer.')) return value.slice('tanweer.'.length);
    }
  }
  return null;
}
