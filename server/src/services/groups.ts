/**
 * Groups: my groups, shared subject groups, optional clubs, join requests and
 * membership decisions (§3, §119, §120, §121).
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import * as V from '../lib/validation';
import { newId } from '../lib/ids';
import { audit } from '../lib/audit';
import {
  addMember,
  countMembers,
  decideJoinRequest,
  eligibleVoters,
  findClassGroup,
  findGroupById,
  findJoinRequest,
  findMembership,
  findOpenJoinRequest,
  insertGroup,
  insertGroupSections,
  insertJoinRequest,
  listDiscoverableGroups,
  listGroupSections,
  listGroupsForUser,
  listJoinRequests,
  listMembers,
  moderatorIds,
  sectionCodesForGroup,
  setMemberNotifications,
  setMemberRole,
  setMemberStatus,
} from '../db/queries/groups';
import { addRoomMember, findRoomForGroup, insertRoom } from '../db/queries/chat';
import { chatRoomIdForGroup } from '../lib/ids';
import { groupDto } from './dto';
import { notifyUsers } from './notifications';
import { findActiveAcademicYear, findSection, listSubjects } from '../db/queries/structure';

async function sectionsOf(ctx: Ctx, groupId: string) {
  const rows = await listGroupSections(ctx.env.TANWEER_DB, groupId);
  return rows.map((row) => ({ gradeId: row.grade_id, gradeName: row.grade_name, code: row.code, label: row.label }));
}

/**
 * The group a screen should open by default: the student's own class group,
 * then any other group they belong to. Clients never have to guess.
 */
export async function defaultGroupIdFor(ctx: Ctx): Promise<string | null> {
  const user = ctx.user;
  if (!user) return null;
  const db = ctx.env.TANWEER_DB;
  const classGroup = await findClassGroup(db, user.gradeId, user.sectionCode, user.academicYearId);
  if (classGroup) return classGroup.id;
  const groups = await listGroupsForUser(db, user.id);
  return groups[0]?.id ?? null;
}

export async function myGroups(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const groups = await listGroupsForUser(db, user.id);
  const withSections = await Promise.all(
    groups.map(async (group) => {
      const [sections, membership] = await Promise.all([sectionsOf(ctx, group.id), findMembership(db, group.id, user.id)]);
      return groupDto(group, {
        sections,
        membership: membership
          ? { role: membership.role, status: membership.status, notifications: membership.notifications }
          : null,
      });
    }),
  );
  return withSections;
}

export async function groupDetails(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const group = await findGroupById(db, groupId);
  if (!group) throw new ApiError('GROUP_NOT_FOUND');
  const [sections, membership, memberCount, moderatorIds_list] = await Promise.all([
    sectionsOf(ctx, groupId),
    findMembership(db, groupId, user.id),
    countMembers(db, groupId),
    moderatorIds(db, groupId),
  ]);
  return groupDto(group, {
    sections,
    membership: membership ? { role: membership.role, status: membership.status, notifications: membership.notifications } : null,
    mySectionScope: group.kind === 'SHARED' ? user.sectionCode : null,
  });
}

export async function discoverGroups(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const groups = await listDiscoverableGroups(db, user.id, {
    query: ctx.q('q'),
    subjectId: ctx.qInt('subjectId') ?? null,
    gradeId: ctx.qInt('gradeId') ?? null,
    limit: ctx.qInt('limit') ?? 30,
  });
  const withSections = await Promise.all(groups.map(async (group) => groupDto(group, { sections: await sectionsOf(ctx, group.id) })));
  return withSections;
}

const createGroupSchema = V.object({
  kind: V.oneOf(['OPTIONAL', 'SHARED'] as const),
  name: V.string({ min: 3, max: 60 }),
  description: V.optional(V.string({ max: 400 })),
  subjectId: V.optional(V.number({ min: 1, max: 999 })),
  emoji: V.optional(V.string({ max: 8 })),
  visibility: V.withDefault(V.oneOf(['DISCOVERABLE', 'PRIVATE'] as const), 'DISCOVERABLE'),
  joinPolicy: V.withDefault(V.oneOf(['REQUEST', 'AUTO', 'MODERATOR_ONLY'] as const), 'REQUEST'),
  /** [gradeId, sectionCode] pairs — required for SHARED groups. */
  sections: V.withDefault(V.arrayOf(V.arrayOf(V.string({ max: 6 }), { min: 2, max: 2 }), { max: 8 }), []),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

/**
 * Creating a group is open to any student (the school has no admin console yet,
 * §58). The creator becomes its moderator; nobody can moderate a group they do
 * not belong to.
 */
export async function createGroup(ctx: Ctx) {
  const input = await ctx.require(createGroupSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  const academicYear = await findActiveAcademicYear(db);
  if (!academicYear) throw new ApiError('INTERNAL_ERROR', 'لا توجد سنة دراسية نشطة.');

  const sections: Array<{ gradeId: number; sectionId: number }> = [];
  for (const [gradeRaw, codeRaw] of input.sections) {
    const gradeId = Number.parseInt(gradeRaw ?? '', 10);
    const code = (codeRaw ?? '').toUpperCase();
    if (!Number.isFinite(gradeId) || !/^[A-D]$/.test(code)) {
      throw new ApiError('VALIDATION_ERROR', 'صيغة الشعب غير صحيحة.');
    }
    const section = await findSection(db, gradeId, code);
    if (!section) throw new ApiError('VALIDATION_ERROR', 'شعبة غير موجودة.');
    sections.push({ gradeId, sectionId: section.id });
  }

  if (input.kind === 'SHARED' && sections.length < 2) {
    throw new ApiError('VALIDATION_ERROR', 'المجموعة المشتركة تحتاج شعبتين على الأقل.');
  }
  if (input.subjectId) {
    const subjects = await listSubjects(db);
    if (!subjects.some((subject) => subject.id === input.subjectId)) throw new ApiError('SUBJECT_NOT_FOUND');
  }

  const groupId = newId('grp');
  await insertGroup(db, {
    id: groupId,
    academicYearId: academicYear.id,
    kind: input.kind,
    name: input.name.trim(),
    description: input.description?.trim() ?? null,
    subjectId: input.subjectId ?? null,
    emoji: input.emoji ?? (input.kind === 'OPTIONAL' ? '✨' : null),
    visibility: input.visibility,
    joinPolicy: input.joinPolicy,
    createdBy: user.id,
    now: ctx.now,
  });

  if (sections.length > 0) await insertGroupSections(db, groupId, sections);
  await addMember(db, { groupId, userId: user.id, role: 'OWNER', now: ctx.now });
  const roomId = chatRoomIdForGroup(groupId);
  await insertRoom(db, { id: roomId, groupId, kind: 'GROUP', title: input.name.trim(), now: ctx.now });
  await addRoomMember(db, roomId, user.id, ctx.now);

  audit(ctx, { action: 'group.created', entityType: 'GROUP', entityId: groupId, groupId, meta: { kind: input.kind } });
  return groupDetails(ctx, groupId);
}

const joinSchema = V.object({
  message: V.optional(V.string({ max: 200 })),
  clientUploadId: V.optional(V.string({ max: 120 })),
});

export async function requestToJoin(ctx: Ctx, groupId: string) {
  const input = await ctx.require(joinSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  const group = await findGroupById(db, groupId);
  if (!group) throw new ApiError('GROUP_NOT_FOUND');
  if (group.status === 'ARCHIVED') throw new ApiError('GROUP_ARCHIVED');
  if (group.kind === 'CLASS') {
    // A class group is joined automatically, never by request.
    const myClassGroup = await findClassGroup(db, user.gradeId, user.sectionCode, user.academicYearId);
    if (myClassGroup?.id === groupId) {
      await addMember(db, { groupId, userId: user.id, role: 'MEMBER', now: ctx.now });
      const room = await findRoomForGroup(db, groupId);
      if (room) await addRoomMember(db, room.id, user.id, ctx.now);
      return { status: 'APPROVED' as const };
    }
    throw new ApiError('FORBIDDEN', 'مجموعة الصف تُنضم تلقائيًا.');
  }

  const membership = await findMembership(db, groupId, user.id);
  if (membership?.status === 'ACTIVE') throw new ApiError('ALREADY_A_MEMBER');
  if (membership?.status === 'BANNED') throw new ApiError('FORBIDDEN');

  if (group.join_policy === 'AUTO') {
    await addMember(db, { groupId, userId: user.id, role: 'MEMBER', now: ctx.now });
    const room = await findRoomForGroup(db, groupId);
    if (room) await addRoomMember(db, room.id, user.id, ctx.now);
    audit(ctx, { action: 'group.joined', entityType: 'GROUP', entityId: groupId, groupId });
    return { status: 'APPROVED' as const };
  }

  const pending = await findOpenJoinRequest(db, groupId, user.id);
  if (pending && pending.status === 'PENDING') throw new ApiError('JOIN_REQUEST_PENDING');

  const requestId = newId('greq');
  await insertJoinRequest(db, { id: requestId, groupId, userId: user.id, message: input.message ?? null, now: ctx.now });

  const moderators = await moderatorIds(db, groupId);
  await notifyUsers(ctx, moderators, {
    kind: 'GROUP',
    title: '📥 طلب انضمام',
    body: `${user.fullName} يريد الانضمام إلى ${group.name}`,
    groupId,
    entityType: 'GROUP',
    entityId: groupId,
    deepLink: `tanweer://group/${groupId}/requests`,
    batchKey: `join:${groupId}`,
    priority: 'NORMAL',
  });

  return { status: 'PENDING' as const, requestId };
}

export async function joinRequests(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const membership = await findMembership(db, groupId, user.id);
  if (membership?.role !== 'MODERATOR' && membership?.role !== 'OWNER' && user.role !== 'SCHOOL_ADMIN') {
    throw new ApiError('NOT_A_MODERATOR');
  }
  const rows = await listJoinRequests(db, groupId);
  return rows.map((row) => ({
    id: row.id,
    message: row.message,
    createdAt: row.created_at,
    user: {
      id: row.user_id,
      fullName: row.full_name,
      gradeId: row.grade_id,
      sectionCode: row.section_code,
      classId: `${row.grade_id}-${row.section_code}`,
    },
  }));
}

const decideSchema = V.object({
  decision: V.oneOf(['APPROVE', 'REJECT'] as const),
  reason: V.optional(V.string({ max: 200 })),
});

export async function decideJoinRequestById(ctx: Ctx, groupId: string, requestId: string) {
  const input = await ctx.require(decideSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const membership = await findMembership(db, groupId, user.id);
  if (membership?.role !== 'MODERATOR' && membership?.role !== 'OWNER' && user.role !== 'SCHOOL_ADMIN') {
    throw new ApiError('NOT_A_MODERATOR');
  }

  const request = await findJoinRequest(db, requestId);
  if (!request || request.group_id !== groupId) throw new ApiError('NOT_FOUND', 'طلب الانضمام غير موجود.');
  if (request.status !== 'PENDING') throw new ApiError('CONFLICT', 'تمت معالجة الطلب مسبقًا.');

  const approved = input.decision === 'APPROVE';
  await decideJoinRequest(db, requestId, approved ? 'APPROVED' : 'REJECTED', user.id, ctx.now);

  if (approved) {
    await addMember(db, { groupId, userId: request.user_id, role: 'MEMBER', now: ctx.now });
    const room = await findRoomForGroup(db, groupId);
    if (room) await addRoomMember(db, room.id, request.user_id, ctx.now);
  }

  const group = await findGroupById(db, groupId);
  await notifyUsers(ctx, [request.user_id], {
    kind: 'GROUP',
    title: approved ? '✓ انضممت إلى مجموعة' : 'طلب الانضمام',
    body: approved ? `تم قبولك في ${group?.name ?? 'المجموعة'}` : `لم يتم قبول طلبك في ${group?.name ?? 'المجموعة'}`,
    groupId,
    entityType: 'GROUP',
    entityId: groupId,
    deepLink: `tanweer://group/${groupId}`,
    batchKey: `join-result:${groupId}`,
    priority: 'NORMAL',
  });

  audit(ctx, { action: approved ? 'group.join.approved' : 'group.join.rejected', entityType: 'GROUP', entityId: groupId, groupId });
  return { status: approved ? 'APPROVED' : 'REJECTED' };
}

export async function leaveGroup(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const group = await findGroupById(db, groupId);
  if (!group) throw new ApiError('GROUP_NOT_FOUND');
  if (group.kind === 'CLASS') throw new ApiError('FORBIDDEN', 'لا يمكن مغادرة مجموعة الصف.');
  await setMemberStatus(db, groupId, user.id, 'LEFT');
  audit(ctx, { action: 'group.left', entityType: 'GROUP', entityId: groupId, groupId });
  return { left: true };
}

export async function groupMembers(ctx: Ctx, groupId: string) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const membership = await findMembership(db, groupId, user.id);
  if (membership?.status !== 'ACTIVE') throw new ApiError('NOT_A_MEMBER');
  const rows = await listMembers(db, groupId, { limit: ctx.qInt('limit') ?? 200 });
  const search = (ctx.q('q') ?? '').trim();
  return rows
    .filter((row) => (search.length === 0 ? true : row.full_name.includes(search)))
    .map((row) => ({
      id: row.user_id,
      fullName: row.full_name,
      gradeId: row.grade_id,
      sectionCode: row.section_code,
      classId: `${row.grade_id}-${row.section_code}`,
      role: row.role,
      joinedAt: row.joined_at,
    }));
}

const memberPatchSchema = V.object({
  role: V.optional(V.oneOf(['MEMBER', 'MODERATOR'] as const)),
  canVote: V.optional(V.boolean()),
  notifications: V.optional(V.oneOf(['ALL', 'IMPORTANT', 'MENTIONS', 'NONE'] as const)),
  status: V.optional(V.oneOf(['ACTIVE', 'LEFT', 'BANNED'] as const)),
});

export async function updateMember(ctx: Ctx, groupId: string, memberId: string) {
  const input = await ctx.require(memberPatchSchema);
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;

  const self = memberId === user.id;
  if (self) {
    // Members may tune their own notifications, nothing else.
    if (input.notifications) await setMemberNotifications(db, groupId, user.id, input.notifications);
    if (input.role || input.canVote || input.status) throw new ApiError('FORBIDDEN');
    return { updated: true };
  }

  const membership = await findMembership(db, groupId, user.id);
  if (membership?.role !== 'MODERATOR' && membership?.role !== 'OWNER' && user.role !== 'SCHOOL_ADMIN') {
    throw new ApiError('NOT_A_MODERATOR');
  }
  if (input.role) await setMemberRole(db, groupId, memberId, input.role);
  if (input.status) await setMemberStatus(db, groupId, memberId, input.status);
  if (input.notifications) await setMemberNotifications(db, groupId, memberId, input.notifications);
  audit(ctx, { action: 'group.member.updated', entityType: 'GROUP', entityId: groupId, groupId, meta: { memberId, ...input } });
  return { updated: true };
}

/** Who may vote on deletions and corrections in this group. */
export async function voters(ctx: Ctx, groupId: string) {
  const list = await eligibleVoters(ctx.env.TANWEER_DB, groupId);
  return { eligible: list.length };
}

/** Class group for a grade+section, used by the registration flow (§2). */
export async function classGroupFor(ctx: Ctx, gradeId: number, sectionCode: string) {
  const db = ctx.env.TANWEER_DB;
  const academicYear = await findActiveAcademicYear(db);
  const group = await findClassGroup(db, gradeId, sectionCode, academicYear?.id ?? null);
  if (!group) throw new ApiError('GROUP_NOT_FOUND', 'لا توجد مجموعة لهذه الشعبة.');
  return groupDto(group, { sections: await sectionsOf(ctx, group.id) });
}

export async function sharedSections(ctx: Ctx, groupId: string) {
  return sectionCodesForGroup(ctx.env.TANWEER_DB, groupId);
}
