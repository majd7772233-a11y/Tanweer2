/**
 * البحث الزمني (§33, §117).
 *
 * Search stays inside the groups the student belongs to, never scans the whole
 * database, and returns results already sorted by date so the timeline reads
 * naturally. Filters: subject, date range, type, section, group, author.
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import { allRows } from '../db/queries/shared';
import { requireMembership } from '../middleware/permissions';
import { listGroupsForUser } from '../db/queries/groups';
import { contentDto, examDto, eventDto, homeworkDto, issueDto, bookDto } from './dto';
import { listBooks } from '../db/queries/books';

interface SearchHit {
  kind: 'CONTENT' | 'HOMEWORK' | 'EXAM' | 'EVENT' | 'ISSUE' | 'BOOK' | 'USER';
  id: string;
  title: string;
  date: string | null;
  groupId: string | null;
  groupName: string | null;
  subjectId: number | null;
  subjectName: string | null;
  snippet: string | null;
  createdAt: string;
}

export async function search(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const query = (ctx.q('q') ?? '').trim();
  if (query.length < 2) return { query, hits: [], counts: {}, cursor: null };

  const db = ctx.env.TANWEER_DB;
  const groups = await listGroupsForUser(db, user.id);
  const requestedGroup = ctx.q('groupId');
  const scope = requestedGroup ? groups.filter((group) => group.id === requestedGroup) : groups;
  if (requestedGroup && scope.length === 0) throw new ApiError('NOT_A_MEMBER');

  const clause = scope.length === 1 ? `AND x.group_id = '${scope[0]?.id.replace(/'/g, "''")}'` : scope.length > 0 ? `AND x.group_id IN (${scope.map((group) => `'${group.id.replace(/'/g, "''")}'`).join(', ')})` : 'AND 0';
  const like = `%${query}%`;
  const type = ctx.q('type');
  const from = ctx.q('from');
  const to = ctx.q('to');
  const subjectId = ctx.qInt('subjectId');
  const authorId = ctx.q('authorId');
  const limit = Math.min(ctx.qInt('limit') ?? 30, 80);

  const hits: SearchHit[] = [];
  const counts: Record<string, number> = {};

  if (!type || type === 'CONTENT') {
    const rows = await allRows<{ id: string; title: string; body: string | null; study_date: string; group_id: string; group_name: string; subject_id: number | null; subject_name: string | null; created_at: string }>(
      db
        .prepare(
          `SELECT c.id, c.title, c.body, c.study_date, c.group_id, g.name AS group_name, c.subject_id, s.name AS subject_name, c.created_at
             FROM content c JOIN groups g ON g.id = c.group_id LEFT JOIN subjects s ON s.id = c.subject_id
            WHERE (c.title LIKE ?1 OR COALESCE(c.body, '') LIKE ?1)
              AND c.status NOT IN ('DELETED','ARCHIVED')
              ${clause.replaceAll('x.', 'c.')}
              ${from ? 'AND c.study_date >= ?2' : ''}
              ${to ? `AND c.study_date <= ?${from ? 3 : 2}` : ''}
              ${subjectId ? `AND c.subject_id = ?${(from ? 1 : 0) + (to ? 1 : 0) + 2}` : ''}
              ${authorId ? `AND c.created_by = ?${(from ? 1 : 0) + (to ? 1 : 0) + (subjectId ? 1 : 0) + 2}` : ''}
            ORDER BY c.study_date DESC LIMIT ${limit}`,
        )
        .bind(like, ...buildBindings({ from, to, subjectId, authorId }))
        ,
    );
    counts.content = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'CONTENT',
        id: row.id,
        title: row.title,
        date: row.study_date,
        groupId: row.group_id,
        groupName: row.group_name,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        snippet: row.body ? row.body.slice(0, 120) : null,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'HOMEWORK') {
    const rows = await allRows<{ id: string; title: string; body: string | null; study_date: string; due_date: string | null; group_id: string; group_name: string; subject_id: number | null; subject_name: string | null; created_at: string }>(
      db
        .prepare(
          `SELECT h.id, h.title, h.body, h.study_date, h.due_date, h.group_id, g.name AS group_name, h.subject_id, s.name AS subject_name, h.created_at
             FROM homeworks h JOIN groups g ON g.id = h.group_id LEFT JOIN subjects s ON s.id = h.subject_id
            WHERE (h.title LIKE ?1 OR COALESCE(h.body, '') LIKE ?1) AND h.status NOT IN ('DELETED','ARCHIVED')
              ${clause.replaceAll('x.', 'h.')}
            ORDER BY COALESCE(h.due_date, h.study_date) DESC LIMIT ${limit}`,
        )
        .bind(like)
        ,
    );
    counts.homework = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'HOMEWORK',
        id: row.id,
        title: row.title,
        date: row.due_date ?? row.study_date,
        groupId: row.group_id,
        groupName: row.group_name,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        snippet: row.body ? row.body.slice(0, 120) : null,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'EXAM') {
    const rows = await allRows<{ id: string; title: string; notes: string | null; exam_date: string; group_id: string; group_name: string; subject_id: number | null; subject_name: string | null; created_at: string }>(
      db
        .prepare(
          `SELECT e.id, e.title, e.notes, e.exam_date, e.group_id, g.name AS group_name, e.subject_id, s.name AS subject_name, e.created_at
             FROM exams e JOIN groups g ON g.id = e.group_id LEFT JOIN subjects s ON s.id = e.subject_id
            WHERE (e.title LIKE ?1 OR COALESCE(e.notes, '') LIKE ?1) AND e.status NOT IN ('DELETED','ARCHIVED')
              ${clause.replaceAll('x.', 'e.')}
            ORDER BY e.exam_date DESC LIMIT ${limit}`,
        )
        .bind(like)
        ,
    );
    counts.exam = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'EXAM',
        id: row.id,
        title: row.title,
        date: row.exam_date,
        groupId: row.group_id,
        groupName: row.group_name,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        snippet: row.notes ? row.notes.slice(0, 120) : null,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'EVENT') {
    const rows = await allRows<{ id: string; title: string; description: string | null; event_date: string; group_id: string; group_name: string; created_at: string }>(
      db
        .prepare(
          `SELECT v.id, v.title, v.description, v.event_date, v.group_id, g.name AS group_name, v.created_at
             FROM events v JOIN groups g ON g.id = v.group_id
            WHERE (v.title LIKE ?1 OR COALESCE(v.description, '') LIKE ?1) AND v.status NOT IN ('DELETED','ARCHIVED')
              ${clause.replaceAll('x.', 'v.')}
            ORDER BY v.event_date DESC LIMIT ${limit}`,
        )
        .bind(like)
        ,
    );
    counts.event = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'EVENT',
        id: row.id,
        title: row.title,
        date: row.event_date,
        groupId: row.group_id,
        groupName: row.group_name,
        subjectId: null,
        subjectName: null,
        snippet: row.description ? row.description.slice(0, 120) : null,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'ISSUE') {
    const rows = await allRows<{ id: string; title: string; body: string | null; study_date: string | null; group_id: string; group_name: string; subject_id: number | null; subject_name: string | null; created_at: string }>(
      db
        .prepare(
          `SELECT i.id, i.title, i.body, i.study_date, i.group_id, g.name AS group_name, i.subject_id, s.name AS subject_name, i.created_at
             FROM issues i JOIN groups g ON g.id = i.group_id LEFT JOIN subjects s ON s.id = i.subject_id
            WHERE (i.title LIKE ?1 OR COALESCE(i.body, '') LIKE ?1)
              ${clause.replaceAll('x.', 'i.')}
            ORDER BY i.last_activity_at DESC LIMIT ${limit}`,
        )
        .bind(like)
        ,
    );
    counts.issue = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'ISSUE',
        id: row.id,
        title: row.title,
        date: row.study_date,
        groupId: row.group_id,
        groupName: row.group_name,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        snippet: row.body ? row.body.slice(0, 120) : null,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'BOOK') {
    const rows = await listBooks(db, { gradeId: user.gradeId, query, limit: 20 });
    counts.book = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'BOOK',
        id: row.id,
        title: row.title,
        date: null,
        groupId: null,
        groupName: null,
        subjectId: row.subject_id,
        subjectName: row.subject_name ?? null,
        snippet: row.publisher,
        createdAt: row.created_at,
      });
    }
  }

  if (!type || type === 'USER') {
    const rows = await allRows<{ id: string; full_name: string; grade_id: number; section_code: string; created_at: string }>(
      db
        .prepare(
          `SELECT DISTINCT u.id, u.full_name, u.grade_id, u.section_code, u.created_at
             FROM users u JOIN group_members m ON m.user_id = u.id
            WHERE u.full_name LIKE ?1 AND m.status = 'ACTIVE'
              AND m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?2 AND status = 'ACTIVE')
            LIMIT 20`,
        )
        .bind(like, user.id)
        ,
    );
    counts.user = rows.length;
    for (const row of rows) {
      hits.push({
        kind: 'USER',
        id: row.id,
        title: row.full_name,
        date: null,
        groupId: null,
        groupName: null,
        subjectId: null,
        subjectName: null,
        snippet: `${row.grade_id}-${row.section_code}`,
        createdAt: row.created_at,
      });
    }
  }

  hits.sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt));
  return { query, hits: hits.slice(0, limit * 2), counts, cursor: null };
}

function buildBindings(input: { from?: string | null; to?: string | null; subjectId?: number | null; authorId?: string | null }): unknown[] {
  const values: unknown[] = [];
  if (input.from) values.push(input.from);
  if (input.to) values.push(input.to);
  if (input.subjectId) values.push(input.subjectId);
  if (input.authorId) values.push(input.authorId);
  return values;
}

/** Re-exported mappers so the router can reuse one shape everywhere. */
export { contentDto, homeworkDto, examDto, eventDto, issueDto, bookDto };
