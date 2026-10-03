/**
 * Groups, memberships and join requests.
 *
 * Three kinds (§3):
 *   CLASS    ثاني ثانوي — ب        the backbone group of one section
 *   SHARED   كيمياء (11-A + 11-B)  one subject, several sections, scoped content
 *   OPTIONAL نادي البرمجة          discoverable, join by request
 */
import { allRows, firstOrNull, placeholders } from './shared';

export type GroupKind = 'CLASS' | 'SHARED' | 'OPTIONAL';
export type MemberRole = 'MEMBER' | 'MODERATOR' | 'OWNER';

export interface GroupRow {
  id: string;
  academic_year_id: string;
  kind: GroupKind;
  name: string;
  description: string | null;
  subject_id: number | null;
  emoji: string | null;
  visibility: string;
  join_policy: string;
  member_count: number;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface GroupSectionRow {
  group_id: string;
  grade_id: number;
  section_id: number;
}

export interface GroupMemberRow {
  group_id: string;
  user_id: string;
  role: MemberRole;
  status: string;
  can_vote: number;
  joined_at: string;
  last_read_at: string | null;
  notifications: string;
}

export interface JoinRequestRow {
  id: string;
  group_id: string;
  user_id: string;
  message: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export function findGroupById(db: D1Database, id: string): Promise<GroupRow | null> {
  return firstOrNull<GroupRow>(db.prepare('SELECT * FROM groups WHERE id = ?1').bind(id));
}

export function findMembership(db: D1Database, groupId: string, userId: string): Promise<GroupMemberRow | null> {
  return firstOrNull<GroupMemberRow>(
    db.prepare('SELECT * FROM group_members WHERE group_id = ?1 AND user_id = ?2').bind(groupId, userId),
  );
}

export function listGroupsForUser(db: D1Database, userId: string, options: { kind?: GroupKind; onlyActiveYear?: boolean } = {}): Promise<GroupRow[]> {
  const filters = ["m.status = 'ACTIVE'"];
  if (options.kind) filters.push(`g.kind = '${options.kind}'`);
  if (options.onlyActiveYear) filters.push("y.status = 'ACTIVE'");
  return allRows<GroupRow>(
    db
      .prepare(
        `SELECT g.* FROM group_members m
           JOIN groups g ON g.id = m.group_id
           JOIN academic_years y ON y.id = g.academic_year_id
          WHERE m.user_id = ?1 AND ${filters.join(' AND ')}
          ORDER BY g.kind = 'CLASS' DESC, g.created_at ASC`,
      )
      .bind(userId),
  );
}

/** Class groups are found by (grade, section) instead of by membership. */
export function findClassGroup(db: D1Database, gradeId: number, sectionCode: string, academicYearId?: string | null): Promise<GroupRow | null> {
  const statement = academicYearId
    ? db
        .prepare(
          `SELECT g.* FROM groups g
             JOIN group_sections gs ON gs.group_id = g.id
             JOIN sections s ON s.id = gs.section_id
            WHERE g.kind = 'CLASS' AND g.academic_year_id = ?1 AND s.grade_id = ?2 AND s.code = ?3
            LIMIT 1`,
        )
        .bind(academicYearId, gradeId, sectionCode)
    : db
        .prepare(
          `SELECT g.* FROM groups g
             JOIN group_sections gs ON gs.group_id = g.id
             JOIN sections s ON s.id = gs.section_id
            WHERE g.kind = 'CLASS' AND s.grade_id = ?1 AND s.code = ?2
            ORDER BY g.created_at DESC LIMIT 1`,
        )
        .bind(gradeId, sectionCode);
  return firstOrNull<GroupRow>(statement);
}

export function listGroupSections(db: D1Database, groupId: string): Promise<Array<GroupSectionRow & { code: string; label: string; grade_name: string }>> {
  return allRows(
    db
      .prepare(
        `SELECT gs.*, s.code, s.label, gr.name AS grade_name
           FROM group_sections gs
           JOIN sections s ON s.id = gs.section_id
           JOIN grades gr ON gr.id = gs.grade_id
          WHERE gs.group_id = ?1
          ORDER BY gs.grade_id ASC, s.order_index ASC`,
      )
      .bind(groupId),
  );
}

export function sectionCodesForGroup(db: D1Database, groupId: string): Promise<string[]> {
  return allRows<{ code: string }>(
    db
      .prepare('SELECT s.code FROM group_sections gs JOIN sections s ON s.id = gs.section_id WHERE gs.group_id = ?1')
      .bind(groupId),
  ).then((rows) => rows.map((row) => row.code));
}

export function listMembers(db: D1Database, groupId: string, options: { limit?: number } = {}): Promise<Array<GroupMemberRow & { full_name: string; grade_id: number; section_code: string }>> {
  return allRows(
    db
      .prepare(
        `SELECT m.*, u.full_name, u.grade_id, u.section_code
           FROM group_members m JOIN users u ON u.id = m.user_id
          WHERE m.group_id = ?1 AND m.status = 'ACTIVE'
          ORDER BY m.role DESC, m.joined_at ASC
          LIMIT ?2`,
      )
      .bind(groupId, options.limit ?? 300),
  );
}

export interface DiscoverOptions {
  query?: string | null;
  subjectId?: number | null;
  gradeId?: number | null;
  limit?: number;
}

/** Optional groups the user has not joined yet (§119). */
export function listDiscoverableGroups(db: D1Database, userId: string, options: DiscoverOptions = {}): Promise<GroupRow[]> {
  const filters = ["g.visibility = 'DISCOVERABLE'", "g.status = 'ACTIVE'"];
  const bindings: unknown[] = [userId];
  if (options.subjectId) {
    filters.push(`g.subject_id = ?${bindings.length + 1}`);
    bindings.push(options.subjectId);
  }
  if (options.gradeId) {
    filters.push(`EXISTS (SELECT 1 FROM group_sections gs WHERE gs.group_id = g.id AND gs.grade_id = ?${bindings.length + 1})`);
    bindings.push(options.gradeId);
  }
  if (options.query && options.query.trim().length > 0) {
    filters.push(`(g.name LIKE ?${bindings.length + 1} OR COALESCE(g.description, '') LIKE ?${bindings.length + 1})`);
    bindings.push(`%${options.query.trim()}%`);
  }
  bindings.push(options.limit ?? 30);
  return allRows<GroupRow>(
    db
      .prepare(
        `SELECT g.* FROM groups g
          WHERE ${filters.join(' AND ')}
            AND NOT EXISTS (
              SELECT 1 FROM group_members m
               WHERE m.group_id = g.id AND m.user_id = ?1 AND m.status IN ('ACTIVE','PENDING')
            )
          ORDER BY g.member_count DESC, g.created_at DESC
          LIMIT ?${bindings.length}`,
      )
      .bind(...bindings),
  );
}

export interface InsertGroupInput {
  id: string;
  academicYearId: string;
  kind: GroupKind;
  name: string;
  description: string | null;
  subjectId: number | null;
  emoji: string | null;
  visibility: 'PRIVATE' | 'DISCOVERABLE';
  joinPolicy: 'AUTO' | 'REQUEST' | 'MODERATOR_ONLY';
  createdBy: string | null;
  now: string;
}

export async function insertGroup(db: D1Database, input: InsertGroupInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO groups (id, academic_year_id, kind, name, description, subject_id, emoji, visibility, join_policy,
                           member_count, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 'ACTIVE', ?10, ?11, ?11)`,
    )
    .bind(
      input.id,
      input.academicYearId,
      input.kind,
      input.name,
      input.description,
      input.subjectId,
      input.emoji,
      input.visibility,
      input.joinPolicy,
      input.createdBy,
      input.now,
    )
    .run();
}

export async function insertGroupSections(
  db: D1Database,
  groupId: string,
  sections: Array<{ gradeId: number; sectionId: number }>,
): Promise<void> {
  if (sections.length === 0) return;
  const statements = sections.map((section) =>
    db
      .prepare('INSERT OR IGNORE INTO group_sections (group_id, grade_id, section_id) VALUES (?1, ?2, ?3)')
      .bind(groupId, section.gradeId, section.sectionId),
  );
  await db.batch(statements);
}

export interface AddMemberInput {
  groupId: string;
  userId: string;
  role?: MemberRole;
  now: string;
}

export async function addMember(db: D1Database, input: AddMemberInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO group_members (group_id, user_id, role, status, can_vote, joined_at, notifications)
       VALUES (?1, ?2, ?3, 'ACTIVE', 1, ?4, 'ALL')
       ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'ACTIVE', role = excluded.role, joined_at = excluded.joined_at`,
    )
    .bind(input.groupId, input.userId, input.role ?? 'MEMBER', input.now)
    .run();
  await refreshMemberCount(db, input.groupId);
}

export async function setMemberStatus(db: D1Database, groupId: string, userId: string, status: 'ACTIVE' | 'LEFT' | 'BANNED'): Promise<void> {
  await db.prepare('UPDATE group_members SET status = ?1 WHERE group_id = ?2 AND user_id = ?3').bind(status, groupId, userId).run();
  await refreshMemberCount(db, groupId);
}

export async function setMemberRole(db: D1Database, groupId: string, userId: string, role: MemberRole): Promise<void> {
  await db.prepare('UPDATE group_members SET role = ?1 WHERE group_id = ?2 AND user_id = ?3').bind(role, groupId, userId).run();
}

export async function setMemberVoteRight(db: D1Database, groupId: string, userId: string, canVote: boolean): Promise<void> {
  await db
    .prepare('UPDATE group_members SET can_vote = ?1 WHERE group_id = ?2 AND user_id = ?3')
    .bind(canVote ? 1 : 0, groupId, userId)
    .run();
}

export async function setMemberNotifications(db: D1Database, groupId: string, userId: string, level: 'ALL' | 'IMPORTANT' | 'MENTIONS' | 'NONE'): Promise<void> {
  await db
    .prepare('UPDATE group_members SET notifications = ?1 WHERE group_id = ?2 AND user_id = ?3')
    .bind(level, groupId, userId)
    .run();
}

export async function markGroupRead(db: D1Database, groupId: string, userId: string, now: string): Promise<void> {
  await db.prepare('UPDATE group_members SET last_read_at = ?1 WHERE group_id = ?2 AND user_id = ?3').bind(now, groupId, userId).run();
}

export async function refreshMemberCount(db: D1Database, groupId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE groups SET member_count = (SELECT COUNT(*) FROM group_members WHERE group_id = ?1 AND status = 'ACTIVE')
        WHERE id = ?1`,
    )
    .bind(groupId)
    .run();
}

// ── join requests ────────────────────────────────────────────────────────────

export function findOpenJoinRequest(db: D1Database, groupId: string, userId: string): Promise<JoinRequestRow | null> {
  return firstOrNull<JoinRequestRow>(
    db
      .prepare("SELECT * FROM group_join_requests WHERE group_id = ?1 AND user_id = ?2 AND status IN ('PENDING','APPROVED') ORDER BY created_at DESC LIMIT 1")
      .bind(groupId, userId),
  );
}

export function findJoinRequest(db: D1Database, id: string): Promise<JoinRequestRow | null> {
  return firstOrNull<JoinRequestRow>(db.prepare('SELECT * FROM group_join_requests WHERE id = ?1').bind(id));
}

export function listJoinRequests(db: D1Database, groupId: string, status = 'PENDING'): Promise<Array<JoinRequestRow & { full_name: string; grade_id: number; section_code: string }>> {
  return allRows(
    db
      .prepare(
        `SELECT r.*, u.full_name, u.grade_id, u.section_code
           FROM group_join_requests r JOIN users u ON u.id = r.user_id
          WHERE r.group_id = ?1 AND r.status = ?2
          ORDER BY r.created_at ASC
          LIMIT 200`,
      )
      .bind(groupId, status),
  );
}

export async function insertJoinRequest(
  db: D1Database,
  input: { id: string; groupId: string; userId: string; message: string | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO group_join_requests (id, group_id, user_id, message, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5)`,
    )
    .bind(input.id, input.groupId, input.userId, input.message, input.now)
    .run();
}

export async function decideJoinRequest(
  db: D1Database,
  requestId: string,
  status: 'APPROVED' | 'REJECTED' | 'WITHDRAWN',
  decidedBy: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare('UPDATE group_join_requests SET status = ?1, decided_by = ?2, decided_at = ?3 WHERE id = ?4')
    .bind(status, decidedBy, now, requestId)
    .run();
}

export async function countMembers(db: D1Database, groupId: string): Promise<number> {
  const row = await firstOrNull<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?1 AND status = 'ACTIVE'").bind(groupId),
  );
  return row?.n ?? 0;
}

/** Members allowed to vote on deletions, corrections and timetable changes. */
export async function eligibleVoters(db: D1Database, groupId: string): Promise<string[]> {
  const rows = await allRows<{ user_id: string }>(
    db
      .prepare("SELECT user_id FROM group_members WHERE group_id = ?1 AND status = 'ACTIVE' AND can_vote = 1")
      .bind(groupId),
  );
  return rows.map((row) => row.user_id);
}

export async function moderatorIds(db: D1Database, groupId: string): Promise<string[]> {
  const rows = await allRows<{ user_id: string }>(
    db
      .prepare("SELECT user_id FROM group_members WHERE group_id = ?1 AND status = 'ACTIVE' AND role IN ('MODERATOR','OWNER')")
      .bind(groupId),
  );
  return rows.map((row) => row.user_id);
}

export async function groupsByIds(db: D1Database, ids: string[]): Promise<GroupRow[]> {
  if (ids.length === 0) return [];
  return allRows<GroupRow>(db.prepare(`SELECT * FROM groups WHERE id IN (${placeholders(ids.length)})`).bind(...ids));
}
