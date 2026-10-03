/**
 * Conversation (§52, §122).
 *
 * Messages: body + sender + time + reply + attachment reference — nothing more.
 * The durable archive lives here (paginated by seq), the live fan-out lives in
 * the Durable Object.
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export interface ChatRoomRow {
  id: string;
  group_id: string | null;
  kind: 'GROUP' | 'DIRECT';
  title: string | null;
  last_seq: number;
  last_message_at: string | null;
  created_at: string;
}

export interface ChatMessageRow {
  id: string;
  room_id: string;
  seq: number;
  sender_id: string;
  body: string | null;
  kind: 'TEXT' | 'ATTACHMENT' | 'SYSTEM';
  file_id: string | null;
  reply_to_id: string | null;
  client_id: string | null;
  status: string;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  sender_name?: string;
  sender_grade?: number;
  sender_section?: string;
  reply_preview?: string | null;
  reply_sender?: string | null;
}

const MESSAGE_SELECT = `SELECT m.*, u.full_name AS sender_name, u.grade_id AS sender_grade, u.section_code AS sender_section,
                               (SELECT substr(COALESCE(r.body, ''), 1, 140) FROM chat_messages r WHERE r.id = m.reply_to_id) AS reply_preview,
                               (SELECT ru.full_name FROM chat_messages r JOIN users ru ON ru.id = r.sender_id WHERE r.id = m.reply_to_id) AS reply_sender
                          FROM chat_messages m
                          JOIN users u ON u.id = m.sender_id`;

export function findRoom(db: D1Database, id: string): Promise<ChatRoomRow | null> {
  return firstOrNull<ChatRoomRow>(db.prepare('SELECT * FROM chat_rooms WHERE id = ?1').bind(id));
}

export function findRoomForGroup(db: D1Database, groupId: string): Promise<ChatRoomRow | null> {
  return firstOrNull<ChatRoomRow>(db.prepare("SELECT * FROM chat_rooms WHERE group_id = ?1 AND kind = 'GROUP' LIMIT 1").bind(groupId));
}

export async function insertRoom(db: D1Database, row: { id: string; groupId: string | null; kind: 'GROUP' | 'DIRECT'; title: string | null; now: string }): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO chat_rooms (id, group_id, kind, title, last_seq, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)")
    .bind(row.id, row.groupId, row.kind, row.title, row.now)
    .run();
}

export function isRoomMember(db: D1Database, roomId: string, userId: string): Promise<{ room_id: string } | null> {
  return firstOrNull<{ room_id: string }>(
    db.prepare("SELECT room_id FROM chat_room_members WHERE room_id = ?1 AND user_id = ?2 AND status = 'ACTIVE'").bind(roomId, userId),
  );
}

export async function addRoomMember(db: D1Database, roomId: string, userId: string, now: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO chat_room_members (room_id, user_id, joined_at, status) VALUES (?1, ?2, ?3, 'ACTIVE')")
    .bind(roomId, userId, now)
    .run();
}

export async function removeRoomMember(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db.prepare("UPDATE chat_room_members SET status = 'LEFT' WHERE room_id = ?1 AND user_id = ?2").bind(roomId, userId).run();
}

export function listRoomMembers(db: D1Database, roomId: string, limit = 200) {
  return allRows<{ user_id: string; full_name: string; grade_id: number; section_code: string; status: string }>(
    db
      .prepare(
        `SELECT m.user_id, u.full_name, u.grade_id, u.section_code, m.status
           FROM chat_room_members m JOIN users u ON u.id = m.user_id
          WHERE m.room_id = ?1 AND m.status = 'ACTIVE' ORDER BY u.full_name ASC LIMIT ?2`,
      )
      .bind(roomId, limit),
  );
}

export function listUserRooms(db: D1Database, userId: string) {
  return allRows<ChatRoomRow & { group_name: string | null; unread: number }>(
    db
      .prepare(
        `SELECT r.*, g.name AS group_name,
                MAX(0, r.last_seq - COALESCE(s.last_read_seq, 0)) AS unread
           FROM chat_room_members m
           JOIN chat_rooms r ON r.id = m.room_id
           LEFT JOIN groups g ON g.id = r.group_id
           LEFT JOIN chat_read_state s ON s.room_id = r.id AND s.user_id = m.user_id
          WHERE m.user_id = ?1 AND m.status = 'ACTIVE'
          ORDER BY COALESCE(r.last_message_at, r.created_at) DESC LIMIT 50`,
      )
      .bind(userId),
  );
}

/** The Durable Object decides the sequence number, D1 stores the durable copy. */
export async function insertMessage(
  db: D1Database,
  input: {
    id: string;
    roomId: string;
    seq: number;
    senderId: string;
    body: string | null;
    kind: 'TEXT' | 'ATTACHMENT' | 'SYSTEM';
    fileId: string | null;
    replyToId: string | null;
    clientId: string | null;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_messages (id, room_id, seq, sender_id, body, kind, file_id, reply_to_id, client_id, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'VISIBLE', ?10)`,
    )
    .bind(input.id, input.roomId, input.seq, input.senderId, input.body, input.kind, input.fileId, input.replyToId, input.clientId, input.now)
    .run();
  await db
    .prepare('UPDATE chat_rooms SET last_seq = MAX(last_seq, ?1), last_message_at = ?2 WHERE id = ?3')
    .bind(input.seq, input.now, input.roomId)
    .run();
}

export function listMessages(db: D1Database, roomId: string, options: { beforeSeq?: number | null; afterSeq?: number | null; limit?: number } = {}): Promise<ChatMessageRow[]> {
  const limit = limitOrDefault(options.limit, 40, 100);
  if (options.afterSeq !== undefined && options.afterSeq !== null) {
    return allRows<ChatMessageRow>(
      db.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ?1 AND m.seq > ?2 ORDER BY m.seq ASC LIMIT ?3`).bind(roomId, options.afterSeq, limit),
    );
  }
  if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
    return allRows<ChatMessageRow>(
      db.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ?1 AND m.seq < ?2 ORDER BY m.seq DESC LIMIT ?3`).bind(roomId, options.beforeSeq, limit),
    ).then((rows) => rows.reverse());
  }
  return allRows<ChatMessageRow>(db.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ?1 ORDER BY m.seq DESC LIMIT ?2`).bind(roomId, limit)).then((rows) =>
    rows.reverse(),
  );
}

export function findMessage(db: D1Database, id: string): Promise<ChatMessageRow | null> {
  return firstOrNull<ChatMessageRow>(db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?1`).bind(id));
}

export function findMessageByClientId(db: D1Database, roomId: string, senderId: string, clientId: string): Promise<ChatMessageRow | null> {
  return firstOrNull<ChatMessageRow>(
    db.prepare(`${MESSAGE_SELECT} WHERE m.room_id = ?1 AND m.sender_id = ?2 AND m.client_id = ?3 LIMIT 1`).bind(roomId, senderId, clientId),
  );
}

export async function softDeleteMessage(db: D1Database, id: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE chat_messages SET status = 'DELETED', body = NULL, deleted_at = ?1 WHERE id = ?2")
    .bind(now, id)
    .run();
}

export async function editMessage(db: D1Database, id: string, body: string, now: string): Promise<void> {
  await db.prepare('UPDATE chat_messages SET body = ?1, edited_at = ?2 WHERE id = ?3').bind(body, now, id).run();
}

export async function setReadState(db: D1Database, roomId: string, userId: string, seq: number, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_read_state (room_id, user_id, last_read_seq, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_seq = MAX(chat_read_state.last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`,
    )
    .bind(roomId, userId, seq, now)
    .run();
}

export function getReadState(db: D1Database, roomId: string, userId: string): Promise<{ last_read_seq: number } | null> {
  return firstOrNull<{ last_read_seq: number }>(
    db.prepare('SELECT last_read_seq FROM chat_read_state WHERE room_id = ?1 AND user_id = ?2').bind(roomId, userId),
  );
}

export async function findOrCreateDirectRoom(db: D1Database, userA: string, userB: string, now: string): Promise<ChatRoomRow> {
  const [first, second] = [userA, userB].sort() as [string, string];
  const roomId = `chat_dm_${first}_${second}`;
  const existing = await findRoom(db, roomId);
  if (existing) return existing;
  await insertRoom(db, { id: roomId, groupId: null, kind: 'DIRECT', title: null, now });
  await addRoomMember(db, roomId, first, now);
  await addRoomMember(db, roomId, second, now);
  const created = await findRoom(db, roomId);
  if (!created) throw new Error('room creation failed');
  return created;
}
