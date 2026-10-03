/**
 * Targeted notifications + per user preferences.
 *
 * Deliberate design decision: the server does NOT fan out one row per lesson
 * per student (150 students × every lesson would burn the daily write budget on
 * its own). Group activity reaches the student through "ماذا فاتني؟" which is
 * computed from `last_seen_at` (§42). This table therefore only carries things
 * that are addressed to one specific person: a reply to your question, a
 * decision about your content, a join request answer…
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export type NotificationKind = 'LESSON' | 'HOMEWORK' | 'EXAM' | 'EVENT' | 'ISSUE' | 'MESSAGE' | 'CONTRIBUTION' | 'SCHEDULE' | 'GROUP' | 'SYSTEM';

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  group_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  deep_link: string | null;
  actor_id: string | null;
  batch_key: string | null;
  priority: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPreferencesRow {
  user_id: string;
  lessons: number;
  homeworks: number;
  exams: number;
  events: number;
  issues: number;
  messages: number;
  contributions: number;
  schedule: number;
  quiet_from: string | null;
  quiet_to: string | null;
  data_saver: number;
  image_quality: string;
  wifi_only_sync: number;
  wifi_only_books: number;
  autoplay_video: number;
  auto_compress: number;
  updated_at: string;
}

export async function listNotifications(db: D1Database, userId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
  const limit = limitOrDefault(options.limit, 50, 100);
  const statement = options.unreadOnly
    ? db
        .prepare('SELECT * FROM notifications WHERE user_id = ?1 AND read_at IS NULL ORDER BY created_at DESC LIMIT ?2')
        .bind(userId, limit)
    : db
        .prepare('SELECT * FROM notifications WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2')
        .bind(userId, limit);
  return allRows<NotificationRow>(statement);
}

export async function insertNotification(db: D1Database, row: NotificationRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, title, body, group_id, entity_type, entity_id, deep_link, actor_id,
                                  batch_key, priority, read_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.kind,
      row.title,
      row.body,
      row.group_id,
      row.entity_type,
      row.entity_id,
      row.deep_link,
      row.actor_id,
      row.batch_key,
      row.priority,
      row.created_at,
    )
    .run();
}

/** Merge instead of stack: the same batch key updates the unread row (§41). */
export async function upsertBatchedNotification(db: D1Database, row: NotificationRow): Promise<void> {
  if (!row.batch_key) {
    await insertNotification(db, row);
    return;
  }
  const existing = await firstOrNull<{ id: string }>(
    db
      .prepare('SELECT id FROM notifications WHERE user_id = ?1 AND batch_key = ?2 AND read_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .bind(row.user_id, row.batch_key),
  );
  if (existing) {
    await db
      .prepare('UPDATE notifications SET title = ?1, body = ?2, entity_id = ?3, deep_link = ?4, actor_id = ?5, created_at = ?6 WHERE id = ?7')
      .bind(row.title, row.body, row.entity_id, row.deep_link, row.actor_id, row.created_at, existing.id)
      .run();
    return;
  }
  await insertNotification(db, row);
}

export async function markNotificationsRead(db: D1Database, userId: string, ids: string[] | null, now: string): Promise<number> {
  if (ids && ids.length > 0) {
    const result = await db
      .prepare(`UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`)
      .bind(now, userId, ...ids)
      .run();
    return result.meta?.changes ?? 0;
  }
  const result = await db.prepare('UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL').bind(now, userId).run();
  return result.meta?.changes ?? 0;
}

export async function countUnreadNotifications(db: D1Database, userId: string): Promise<number> {
  const row = await firstOrNull<{ n: number }>(
    db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL').bind(userId),
  );
  return row?.n ?? 0;
}

export function getPreferences(db: D1Database, userId: string): Promise<NotificationPreferencesRow | null> {
  return firstOrNull<NotificationPreferencesRow>(db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?1').bind(userId));
}

export async function upsertPreferences(
  db: D1Database,
  userId: string,
  patch: Partial<Omit<NotificationPreferencesRow, 'user_id' | 'updated_at'>>,
  now: string,
): Promise<void> {
  const columns = Object.keys(patch);
  if (columns.length === 0) {
    await db
      .prepare('INSERT INTO notification_preferences (user_id, updated_at) VALUES (?1, ?2) ON CONFLICT (user_id) DO NOTHING')
      .bind(userId, now)
      .run();
    return;
  }
  const insertColumns = ['user_id', ...columns, 'updated_at'].join(', ');
  const insertValues = ['?1', ...columns.map((_, index) => `?${index + 2}`), `?${columns.length + 2}`].join(', ');
  const updateColumns = columns.map((column) => `${column} = excluded.${column}`).join(', ');
  const values = columns.map((column) => (patch as Record<string, unknown>)[column]);
  await db
    .prepare(
      `INSERT INTO notification_preferences (${insertColumns}) VALUES (${insertValues})
       ON CONFLICT (user_id) DO UPDATE SET ${updateColumns}, updated_at = excluded.updated_at`,
    )
    .bind(userId, ...values, now)
    .run();
}

export function toPreferencesDto(row: NotificationPreferencesRow) {
  return {
    lessons: row.lessons === 1,
    homeworks: row.homeworks === 1,
    exams: row.exams === 1,
    events: row.events === 1,
    issues: row.issues === 1,
    messages: row.messages === 1,
    contributions: row.contributions === 1,
    schedule: row.schedule === 1,
    quietFrom: row.quiet_from,
    quietTo: row.quiet_to,
    dataSaver: row.data_saver === 1,
    imageQuality: row.image_quality as 'LOW' | 'MEDIUM' | 'HIGH',
    wifiOnlySync: row.wifi_only_sync === 1,
    wifiOnlyBooks: row.wifi_only_books === 1,
    autoplayVideo: row.autoplay_video === 1,
    autoCompress: row.auto_compress === 1,
    updatedAt: row.updated_at,
  };
}

export function defaultPreferences(userId: string, now: string) {
  return {
    lessons: true,
    homeworks: true,
    exams: true,
    events: true,
    issues: true,
    messages: true,
    contributions: true,
    schedule: true,
    quietFrom: null,
    quietTo: null,
    dataSaver: false,
    imageQuality: 'MEDIUM' as const,
    wifiOnlySync: false,
    wifiOnlyBooks: true,
    autoplayVideo: false,
    autoCompress: true,
    updatedAt: now,
  };
}
