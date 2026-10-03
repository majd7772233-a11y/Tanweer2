/**
 * 🔒 Private notes (§45). They belong to one student and are never part of
 * group content: no sharing endpoint exists on purpose.
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export interface NoteRow {
  id: string;
  user_id: string;
  group_id: string | null;
  subject_id: number | null;
  content_id: string | null;
  study_date: string | null;
  title: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  revision: number;
  subject_name?: string | null;
}

const SELECT = `SELECT n.*, s.name AS subject_name FROM notes n LEFT JOIN subjects s ON s.id = n.subject_id`;

export function listNotes(
  db: D1Database,
  userId: string,
  filters: { groupId?: string | null; subjectId?: number | null; date?: string | null; limit?: number } = {},
): Promise<NoteRow[]> {
  const where = ['n.user_id = ?1'];
  const bindings: unknown[] = [userId];
  if (filters.groupId) {
    where.push(`n.group_id = ?${bindings.length + 1}`);
    bindings.push(filters.groupId);
  }
  if (filters.subjectId) {
    where.push(`n.subject_id = ?${bindings.length + 1}`);
    bindings.push(filters.subjectId);
  }
  if (filters.date) {
    where.push(`n.study_date = ?${bindings.length + 1}`);
    bindings.push(filters.date);
  }
  bindings.push(limitOrDefault(filters.limit, 50, 200));
  return allRows<NoteRow>(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY n.updated_at DESC LIMIT ?${bindings.length}`).bind(...bindings));
}

export function findNote(db: D1Database, id: string, userId: string): Promise<NoteRow | null> {
  return firstOrNull<NoteRow>(db.prepare(`${SELECT} WHERE n.id = ?1 AND n.user_id = ?2`).bind(id, userId));
}

export async function insertNote(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    groupId: string | null;
    subjectId: number | null;
    contentId: string | null;
    studyDate: string | null;
    title: string | null;
    body: string;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notes (id, user_id, group_id, subject_id, content_id, study_date, title, body, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1)`,
    )
    .bind(input.id, input.userId, input.groupId, input.subjectId, input.contentId, input.studyDate, input.title, input.body, input.now)
    .run();
}

export async function updateNote(
  db: D1Database,
  id: string,
  userId: string,
  patch: { title?: string | null; body?: string },
  now: string,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push(`title = ?${values.length + 1}`);
    values.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push(`body = ?${values.length + 1}`);
    values.push(patch.body);
  }
  if (sets.length === 0) return false;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(now);
  sets.push('revision = revision + 1');
  values.push(id, userId);
  const result = await db
    .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?${values.length - 1} AND user_id = ?${values.length}`)
    .bind(...values)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteNote(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}
