/**
 * Targeted notifications (§41) and preferences (§50).
 *
 * Only things addressed to one person live here. Group activity is served by
 * "ماذا فاتني؟" which is derived from last_seen_at — this keeps the free plan
 * alive even with a school of a few hundred students.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import {
  countUnreadNotifications,
  defaultPreferences,
  getPreferences,
  listNotifications,
  markNotificationsRead,
  toPreferencesDto,
  upsertBatchedNotification,
  upsertPreferences,
  type NotificationKind,
} from '../db/queries/notifications';
import { notificationDto } from './dto';

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  groupId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  deepLink?: string | null;
  batchKey?: string | null;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
}

/**
 * Writes one notification per recipient. Recipients are always a small, known
 * set (people who asked the question, people whose content was voted on…),
 * never "everybody in the group".
 */
export async function notifyUsers(ctx: Ctx, userIds: string[], input: NotifyInput): Promise<void> {
  const targets = [...new Set(userIds)].filter((id) => id !== ctx.user?.id && id.length > 0);
  if (targets.length === 0) return;

  ctx.waitUntil(
    (async () => {
      const db = ctx.env.TANWEER_DB;
      const preferencesCache = new Map<string, Awaited<ReturnType<typeof getPreferences>>>();
      for (const userId of targets.slice(0, 200)) {
        const prefs = preferencesCache.get(userId) ?? (await getPreferences(db, userId));
        preferencesCache.set(userId, prefs);
        if (prefs) {
          const key: keyof typeof PREFERENCE_FIELD = input.kind === 'LESSON' ? 'lessons'
            : input.kind === 'HOMEWORK' ? 'homeworks'
            : input.kind === 'EXAM' ? 'exams'
            : input.kind === 'EVENT' ? 'events'
            : input.kind === 'ISSUE' ? 'issues'
            : input.kind === 'MESSAGE' ? 'messages'
            : input.kind === 'CONTRIBUTION' ? 'contributions'
            : input.kind === 'SCHEDULE' ? 'schedule'
            : 'lessons';
          const field = PREFERENCE_FIELD[key];
          if ((prefs as unknown as Record<string, number>)[field] === 0) continue;
        }
        await upsertBatchedNotification(db, {
          id: newId('ntf'),
          user_id: userId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? null,
          group_id: input.groupId ?? null,
          entity_type: input.entityType ?? null,
          entity_id: input.entityId ?? null,
          deep_link: input.deepLink ?? null,
          actor_id: ctx.user?.id ?? null,
          batch_key: input.batchKey ?? null,
          priority: input.priority ?? 'NORMAL',
          read_at: null,
          created_at: ctx.now,
        });
      }
    })(),
  );
}

const PREFERENCE_FIELD = {
  lessons: 'lessons',
  homeworks: 'homeworks',
  exams: 'exams',
  events: 'events',
  issues: 'issues',
  messages: 'messages',
  contributions: 'contributions',
  schedule: 'schedule',
} as const;

export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const rows = await listNotifications(ctx.env.TANWEER_DB, user.id, {
    unreadOnly: ctx.qBool('unread'),
    limit: ctx.qInt('limit') ?? 50,
  });
  const unread = await countUnreadNotifications(ctx.env.TANWEER_DB, user.id);
  return { items: rows.map(notificationDto), unread };
}

const readSchema = V.object({
  ids: V.optional(V.arrayOf(V.string({ max: 60 }), { max: 200 })),
});

export async function markRead(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const input = await ctx.require(readSchema);
  const changed = await markNotificationsRead(ctx.env.TANWEER_DB, user.id, input.ids ?? null, ctx.now);
  return { updated: changed };
}

export async function preferences(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const row = await getPreferences(ctx.env.TANWEER_DB, user.id);
  if (row) return toPreferencesDto(row);
  await upsertPreferences(ctx.env.TANWEER_DB, user.id, {}, ctx.now);
  return defaultPreferences(user.id, ctx.now);
}

const preferencesSchema = V.object({
  lessons: V.optional(V.boolean()),
  homeworks: V.optional(V.boolean()),
  exams: V.optional(V.boolean()),
  events: V.optional(V.boolean()),
  issues: V.optional(V.boolean()),
  messages: V.optional(V.boolean()),
  contributions: V.optional(V.boolean()),
  schedule: V.optional(V.boolean()),
  quietFrom: V.optional(V.string({ max: 5, allowEmpty: true })),
  quietTo: V.optional(V.string({ max: 5, allowEmpty: true })),
  dataSaver: V.optional(V.boolean()),
  imageQuality: V.optional(V.oneOf(['LOW', 'MEDIUM', 'HIGH'] as const)),
  wifiOnlySync: V.optional(V.boolean()),
  wifiOnlyBooks: V.optional(V.boolean()),
  autoplayVideo: V.optional(V.boolean()),
  autoCompress: V.optional(V.boolean()),
});

export async function updatePreferences(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const input = await ctx.require(preferencesSchema);
  const patch: Record<string, unknown> = {};
  const booleanKeys = ['lessons', 'homeworks', 'exams', 'events', 'issues', 'messages', 'contributions', 'schedule', 'dataSaver', 'wifiOnlySync', 'wifiOnlyBooks', 'autoplayVideo', 'autoCompress'] as const;
  const columnFor: Record<string, string> = { dataSaver: 'data_saver', wifiOnlySync: 'wifi_only_sync', wifiOnlyBooks: 'wifi_only_books', autoplayVideo: 'autoplay_video', autoCompress: 'auto_compress' };
  for (const key of booleanKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    patch[columnFor[key] ?? key] = value ? 1 : 0;
  }
  if (input.quietFrom !== undefined) patch.quiet_from = input.quietFrom === '' ? null : input.quietFrom;
  if (input.quietTo !== undefined) patch.quiet_to = input.quietTo === '' ? null : input.quietTo;
  if (input.imageQuality) patch.image_quality = input.imageQuality;

  await upsertPreferences(ctx.env.TANWEER_DB, user.id, patch as never, ctx.now);
  const row = await getPreferences(ctx.env.TANWEER_DB, user.id);
  return row ? toPreferencesDto(row) : defaultPreferences(user.id, ctx.now);
}
