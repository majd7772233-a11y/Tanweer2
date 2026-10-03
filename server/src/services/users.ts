/**
 * Profile, devices, contributions and "ماذا فاتني؟".
 * Contact details stay private; the educational identity is what is shown (§5).
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { audit } from '../lib/audit';
import {
  contributionStats,
  findUserById,
  listDevices,
  revokeDevice,
  updateUserProfile,
  emailExists,
  findDeviceById,
} from '../db/queries/users';
import { findClassGroup, listGroupsForUser } from '../db/queries/groups';
import { getMissedSummary } from '../db/queries/calendar';
import { listUserRooms } from '../db/queries/chat';
import { countUnreadNotifications } from '../db/queries/notifications';
import { selfUser, groupDto, publicUser } from './dto';

export async function me(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const [row, unread] = await Promise.all([findUserById(db, user.id), countUnreadNotifications(db, user.id)]);
  if (!row) throw new ApiError('UNAUTHORIZED');

  const classGroup = await findClassGroup(db, row.grade_id, row.section_code, row.academic_year_id);
  return {
    user: selfUser(row),
    classId: row.class_id,
    classGroup: classGroup ? groupDto(classGroup) : null,
    unreadNotifications: unread,
    device: ctx.device ?? null,
    serverToday: ctx.today,
    serverTime: ctx.now,
  };
}

const updateProfileSchema = V.object({
  fullName: V.optional(V.string({ min: 5, max: 60 })),
  email: V.optional(V.string({ max: 254, allowEmpty: true })),
  bio: V.optional(V.string({ max: 300, allowEmpty: true })),
});

export async function updateProfile(ctx: Ctx) {
  const input = await ctx.require(updateProfileSchema);
  const current = ctx.user;
  if (!current) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  let email: string | null | undefined;
  if (input.email !== undefined) {
    if (input.email.trim().length === 0) {
      email = null;
    } else {
      const parsed = V.email().parse(input.email, 'email', {});
      if (!parsed) throw new ApiError('INVALID_EMAIL');
      const owner = await emailExists(db, parsed);
      if (owner) {
        const existing = await db.prepare('SELECT id FROM users WHERE email = ?1').bind(parsed).first<{ id: string }>();
        if (existing && existing.id !== current.id) throw new ApiError('EMAIL_ALREADY_REGISTERED');
      }
      email = parsed;
    }
  }

  await updateUserProfile(db, current.id, {
    fullName: input.fullName,
    email,
    bio: input.bio,
    now: ctx.now,
  });

  const row = await findUserById(db, current.id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  audit(ctx, { action: 'user.profile.updated', entityType: 'USER', entityId: current.id });
  return { user: selfUser(row) };
}

export async function myDevices(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const devices = await listDevices(ctx.env.TANWEER_DB, user.id);
  return devices.map((device) => ({
    id: device.id,
    deviceId: device.device_id,
    platform: device.platform,
    model: device.model,
    appVersion: device.app_version,
    osVersion: device.os_version,
    status: device.session_status,
    lastSeenAt: device.last_seen_at,
    createdAt: device.created_at,
    current: device.id === ctx.device?.id,
  }));
}

export async function revokeDeviceById(ctx: Ctx, deviceRowId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const device = await findDeviceById(ctx.env.TANWEER_DB, deviceRowId);
  if (!device) throw new ApiError('NOT_FOUND', 'الجهاز غير موجود.');
  if (device.user_id !== user.id) throw new ApiError('FORBIDDEN', 'هذا الجهاز ليس جهازك.');

  await revokeDevice(ctx.env.TANWEER_DB, user.id, deviceRowId, ctx.now);
  audit(ctx, { action: 'user.device.revoked', entityType: 'DEVICE', entityId: deviceRowId });
  return { revoked: true, wasCurrent: deviceRowId === ctx.device?.id };
}

export async function registrationsPushToken(ctx: Ctx, pushToken: string | null) {
  const device = ctx.device;
  if (!device) throw new ApiError('UNAUTHORIZED');
  await ctx.env.TANWEER_DB.prepare('UPDATE devices SET push_token = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(pushToken, ctx.now, device.id)
    .run();
  return { updated: true };
}

export async function myContributions(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const stats = await contributionStats(ctx.env.TANWEER_DB, user.id);
  return {
    lessons: stats.lessons,
    homeworks: stats.homeworks,
    photos: stats.photos,
    files: stats.files,
    issues: stats.issues,
    answers: stats.answers,
    badges: [],
  };
}

/** "ماذا فاتني؟" (§36) — computed from last_seen_at, not from a fan-out. */
export async function missedSinceLastVisit(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const since = ctx.q('since') ?? user.lastSeenAt ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const summary = await getMissedSummary(db, { userId: user.id, since, today: ctx.today });
  const [rooms, groups] = await Promise.all([listUserRooms(db, user.id), listGroupsForUser(db, user.id)]);
  const unreadMessages = rooms.reduce((total, room) => total + Number(room.unread ?? 0), 0);
  return {
    ...summary,
    unreadMessages,
    groupCount: groups.length,
    serverToday: ctx.today,
  };
}

export async function publicProfile(ctx: Ctx, userId: string) {
  const row = await findUserById(ctx.env.TANWEER_DB, userId);
  if (!row) throw new ApiError('NOT_FOUND', 'المستخدم غير موجود.');
  const groups = await listGroupsForUser(ctx.env.TANWEER_DB, userId);
  const stats = await contributionStats(ctx.env.TANWEER_DB, userId);
  return {
    user: publicUser(row),
    bio: row.bio,
    memberSince: row.created_at,
    groups: groups.map((group) => ({ id: group.id, name: group.name, kind: group.kind, emoji: group.emoji })),
    contributions: {
      lessons: stats.lessons,
      homeworks: stats.homeworks,
      photos: stats.photos,
      issues: stats.issues,
      answers: stats.answers,
    },
  };
}

/** Home widget data (§77): today's cards in one small payload. */
export async function widgetSummary(ctx: Ctx, groupId: string) {
  const { dayOverview } = await import('./calendar');
  const overview = await dayOverview(ctx, { groupId, date: ctx.today });
  return {
    date: overview.date,
    weekday: overview.weekday,
    documented: overview.documentedCount,
    total: overview.totalCount,
    subjects: overview.cards.map((card) => ({
      id: card.subject?.id ?? null,
      name: card.subject?.name ?? card.title,
      emoji: card.subject?.emoji ?? null,
      status: card.status,
    })),
    homeworks: overview.homeworks.length,
    nextExamDays: overview.nextExam?.daysUntil ?? null,
    nextExamSubject: overview.nextExam?.subject?.name ?? null,
  };
}
