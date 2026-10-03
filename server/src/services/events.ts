/**
 * 🎉 الأحداث (§25): trips, competitions, announcements, activities, holidays.
 * An event is not a lesson; it lives on its own date and stays in the archive.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import { sectionCodesForGroup } from '../db/queries/groups';
import { findEventById, insertEvent, listEvents, updateEvent } from '../db/queries/events';
import { insertRevision } from '../db/queries/content';
import { defaultSectionScope, requireMembership } from '../middleware/permissions';
import { findActiveAcademicYear } from '../db/queries/structure';
import { daysBetween } from '../lib/date';
import { eventDto } from './dto';

const createSchema = V.object({
  groupId: V.string({ min: 3, max: 80 }),
  title: V.string({ min: 2, max: 160 }),
  description: V.optional(V.string({ max: 4000, allowEmpty: true })),
  kind: V.withDefault(V.oneOf(['TRIP', 'COMPETITION', 'ANNOUNCEMENT', 'ACTIVITY', 'HOLIDAY', 'MEETING', 'OTHER'] as const), 'ANNOUNCEMENT'),
  subjectId: V.optional(V.unionNull(V.number({ min: 1, max: 999 }))),
  eventDate: V.isoDate(),
  endDate: V.optional(V.unionNull(V.isoDate())),
  startsAt: V.optional(V.unionNull(V.clockTime())),
  endsAt: V.optional(V.unionNull(V.clockTime())),
  location: V.optional(V.string({ max: 120 })),
  sectionScope: V.optional(V.unionNull(V.sectionCode())),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function createEvent(ctx: Ctx) {
  const input = await ctx.require(createSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, input.groupId);
  const sectionCodes = await sectionCodesForGroup(db, input.groupId);
  const sectionScope = defaultSectionScope(access, input.sectionScope ?? undefined, sectionCodes, user.sectionCode);
  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR');

  const id = newId('evnt');
  await insertEvent(db, {
    id,
    groupId: input.groupId,
    academicYearId: academicYear.id,
    subjectId: input.subjectId ?? null,
    sectionScope,
    title: input.title.trim(),
    description: input.description?.trim() ?? null,
    kind: input.kind,
    eventDate: input.eventDate,
    endDate: input.endDate ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    location: input.location ?? null,
    createdBy: user.id,
    now: ctx.now,
  });

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'EVENT',
    entityId: id,
    revision: 1,
    action: 'CREATED',
    snapshot: { title: input.title, kind: input.kind, eventDate: input.eventDate },
    changedBy: user.id,
    now: ctx.now,
  });

  audit(ctx, { action: 'event.created', entityType: 'EVENT', entityId: id, groupId: input.groupId });
  const row = await findEventById(db, id);
  if (!row) throw new ApiError('INTERNAL_ERROR');
  return eventDto(row);
}

export async function list(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId');
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const scope = (ctx.q('scope') ?? 'upcoming') as 'upcoming' | 'past' | 'all';
  const rows = await listEvents(ctx.env.TANWEER_DB, {
    groupId,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    subjectId: ctx.qInt('subjectId') ?? null,
    kind: (ctx.q('kind') as never) ?? null,
    scope,
    today: ctx.today,
    limit: ctx.qInt('limit') ?? 50,
  });
  return rows.map((row) => ({ ...eventDto(row), daysUntil: daysBetween(ctx.today, row.event_date) }));
}

export async function detail(ctx: Ctx, eventId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findEventById(db, eventId);
  if (!row) throw new ApiError('EVENT_NOT_FOUND');
  await requireMembership(ctx, row.group_id);
  const { listComments } = await import('../db/queries/content');
  const comments = await listComments(db, 'EVENT', eventId, 100);
  const { commentDto } = await import('./dto');
  return {
    event: { ...eventDto(row), daysUntil: daysBetween(ctx.today, row.event_date) },
    comments: comments.map(commentDto),
  };
}

const updateSchema = V.object({
  title: V.optional(V.string({ min: 2, max: 160 })),
  description: V.optional(V.string({ max: 4000, allowEmpty: true })),
  kind: V.optional(V.oneOf(['TRIP', 'COMPETITION', 'ANNOUNCEMENT', 'ACTIVITY', 'HOLIDAY', 'MEETING', 'OTHER'] as const)),
  eventDate: V.optional(V.isoDate()),
  endDate: V.optional(V.unionNull(V.isoDate())),
  startsAt: V.optional(V.unionNull(V.clockTime())),
  endsAt: V.optional(V.unionNull(V.clockTime())),
  location: V.optional(V.unionNull(V.string({ max: 120 }))),
  isPinned: V.optional(V.boolean()),
  reason: V.optional(V.string({ max: 200 })),
});

export async function update(ctx: Ctx, eventId: string) {
  const input = await ctx.require(updateSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const row = await findEventById(db, eventId);
  if (!row) throw new ApiError('EVENT_NOT_FOUND');
  const access = await requireMembership(ctx, row.group_id);
  if (row.created_by !== user.id && !access.isModerator) throw new ApiError('FORBIDDEN', 'أرسل اقتراح تصحيح.');

  await updateEvent(
    db,
    eventId,
    {
      title: input.title,
      description: input.description,
      kind: input.kind,
      event_date: input.eventDate,
      end_date: input.endDate === undefined ? undefined : input.endDate,
      starts_at: input.startsAt === undefined ? undefined : input.startsAt,
      ends_at: input.endsAt === undefined ? undefined : input.endsAt,
      location: input.location === undefined ? undefined : input.location,
      is_pinned: input.isPinned === undefined ? undefined : input.isPinned ? 1 : 0,
    },
    ctx.now,
  );

  await insertRevision(db, {
    id: newId('crev'),
    entityType: 'EVENT',
    entityId: eventId,
    revision: row.revision + 1,
    action: 'EDITED',
    snapshot: { ...input },
    reason: input.reason ?? null,
    changedBy: user.id,
    now: ctx.now,
  });

  const updated = await findEventById(db, eventId);
  if (!updated) throw new ApiError('INTERNAL_ERROR');
  return eventDto(updated);
}
