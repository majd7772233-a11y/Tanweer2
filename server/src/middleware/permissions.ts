/**
 * "Can this student do this?" — deliberately separated from "how does the
 * handler do it?" (§96).
 *
 * Core rules:
 *  • only members see a group's content;
 *  • in a CLASS group everybody sees everything;
 *  • in a SHARED group (كيمياء: أ + ب) content is visible to its own section,
 *    or to both when section_scope is NULL;
 *  • moderators can always act, but deletion of content is never theirs alone.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import { findGroupById, findMembership, type GroupMemberRow, type GroupRow } from '../db/queries/groups';

export interface GroupAccess {
  group: GroupRow;
  membership: GroupMemberRow | null;
  isMember: boolean;
  isModerator: boolean;
  /** Sections whose content this member may read. */
  visibleSections: string[] | null;
}

export async function loadGroupAccess(ctx: Ctx, groupId: string): Promise<GroupAccess> {
  const group = await findGroupById(ctx.env.TANWEER_DB, groupId);
  if (!group) throw new ApiError('GROUP_NOT_FOUND');
  if (group.status === 'ARCHIVED') throw new ApiError('GROUP_ARCHIVED');

  const membership = ctx.user ? await findMembership(ctx.env.TANWEER_DB, groupId, ctx.user.id) : null;
  const isMember = membership?.status === 'ACTIVE';
  const isModerator = isMember && (membership?.role === 'MODERATOR' || membership?.role === 'OWNER');

  const visibleSections = isMember && group.kind === 'SHARED' && ctx.user ? [ctx.user.sectionCode] : null;

  return { group, membership, isMember, isModerator, visibleSections };
}

export async function requireMembership(ctx: Ctx, groupId: string): Promise<GroupAccess> {
  const access = await loadGroupAccess(ctx, groupId);
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');
  return access;
}

export async function requireModerator(ctx: Ctx, groupId: string): Promise<GroupAccess> {
  const access = await requireMembership(ctx, groupId);
  if (!access.isModerator && ctx.user?.role !== 'SCHOOL_ADMIN') throw new ApiError('NOT_A_MODERATOR');
  return access;
}

export function canVote(access: GroupAccess): boolean {
  return access.isMember && (access.membership?.can_vote ?? 0) === 1;
}

export function requireVoteRight(access: GroupAccess): void {
  if (!canVote(access)) throw new ApiError('VOTE_NOT_ALLOWED');
}

/**
 * Section scope of new content: a student of 11-B writing inside كيمياء (أ+ب)
 * creates 11-B material unless they explicitly share it with everybody.
 */
export function defaultSectionScope(
  access: GroupAccess,
  requested: string | undefined | null,
  sectionCodes: string[],
  authorSection: string | undefined,
): string | null {
  if (access.group.kind !== 'SHARED') return null;
  // explicit "كل الشعب"
  if (requested === null) return null;
  if (requested) {
    if (!sectionCodes.includes(requested)) {
      throw new ApiError('VALIDATION_ERROR', 'الشعبة غير تابعة لهذه المجموعة.', {
        fields: { sectionScope: 'الشعبة غير تابعة لهذه المجموعة.' },
      });
    }
    return requested;
  }
  // omitted → the author's own section, so 11-A material never leaks into 11-B
  return authorSection ?? null;
}

/** SQL fragment for section visibility, with the value already bound. */
export function sectionVisibilitySql(access: GroupAccess, column = 'c.section_scope'): { sql: string; values: string[] } {
  if (access.group.kind !== 'SHARED') return { sql: '', values: [] };
  const section = access.visibleSections?.[0];
  if (!section) return { sql: `AND ${column} IS NULL`, values: [] };
  return { sql: `AND (${column} IS NULL OR ${column} = ?)`, values: [section] };
}

/** Content authored by a member of another section of a shared group. */
export function assertSectionVisible(access: GroupAccess, sectionScope: string | null): void {
  if (access.group.kind !== 'SHARED') return;
  if (sectionScope === null) return;
  const visible = access.visibleSections ?? [];
  if (!visible.includes(sectionScope)) throw new ApiError('FORBIDDEN', 'هذا المحتوى يخص شعبة أخرى.');
}

/** Authors may edit/withdraw their own work; moderators may tidy up. */
export function assertCanMutate(access: GroupAccess, ownerId: string, ctx: Ctx): void {
  if (!access.isMember) throw new ApiError('NOT_A_MEMBER');
  const isOwner = ctx.user?.id === ownerId;
  if (isOwner || access.isModerator) return;
  throw new ApiError('FORBIDDEN');
}

/**
 * Only the author, a moderator, or an approved community vote may change the
 * meaning of content. Everyone else proposes a correction (§62).
 */
export function requiresCommunityDecision(access: GroupAccess, ownerId: string, ctx: Ctx): boolean {
  return !(ctx.user?.id === ownerId || access.isModerator);
}
