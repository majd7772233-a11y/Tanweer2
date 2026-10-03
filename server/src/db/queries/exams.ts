/**
 * Exams (§24): always attached to a date, optionally to a subject, and linked
 * to the lessons, homeworks, chapters and questions that belong to it so a
 * study pack can be opened in one place (§65).
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export type ExamStatus = 'DRAFT' | 'PUBLISHED' | 'EDITED' | 'PENDING_CORRECTION' | 'PENDING_DELETION' | 'DELETED' | 'ARCHIVED';

export interface ExamRow {
  id: string;
  group_id: string;
  academic_year_id: string;
  subject_id: number | null;
  section_scope: string | null;
  study_date: string;
  exam_date: string;
  starts_at: string | null;
  duration_minutes: number | null;
  title: string;
  chapters: string | null;
  room: string | null;
  notes: string | null;
  book_id: string | null;
  status: ExamStatus;
  useful_count: number;
  comment_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
  author_name?: string;
  subject_name?: string | null;
  subject_emoji?: string | null;
  subject_color?: string | null;
}

const SELECT = `SELECT e.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
                  FROM exams e
                  JOIN users u ON u.id = e.created_by
                  LEFT JOIN subjects s ON s.id = e.subject_id`;

export interface InsertExamInput {
  id: string;
  groupId: string;
  academicYearId: string;
  subjectId: number | null;
  sectionScope: string | null;
  studyDate: string;
  examDate: string;
  startsAt: string | null;
  durationMinutes: number | null;
  title: string;
  chapters: number[] | null;
  room: string | null;
  notes: string | null;
  bookId: string | null;
  createdBy: string;
  now: string;
}

export async function insertExam(db: D1Database, input: InsertExamInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO exams (id, group_id, academic_year_id, subject_id, section_scope, study_date, exam_date, starts_at,
                          duration_minutes, title, chapters, room, notes, book_id, status, created_by, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'PUBLISHED', ?15, ?16, ?16, 1)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.academicYearId,
      input.subjectId,
      input.sectionScope,
      input.studyDate,
      input.examDate,
      input.startsAt,
      input.durationMinutes,
      input.title,
      input.chapters ? JSON.stringify(input.chapters) : null,
      input.room,
      input.notes,
      input.bookId,
      input.createdBy,
      input.now,
    )
    .run();
}

export function findExamById(db: D1Database, id: string): Promise<ExamRow | null> {
  return firstOrNull<ExamRow>(db.prepare(`${SELECT} WHERE e.id = ?1`).bind(id));
}

export interface ExamFilter {
  groupId: string;
  section?: string | null;
  subjectId?: number | null;
  scope?: 'upcoming' | 'past' | 'all';
  today?: string;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export async function listExams(db: D1Database, filter: ExamFilter): Promise<ExamRow[]> {
  const where: string[] = ['e.group_id = ?1'];
  const bindings: unknown[] = [filter.groupId];
  where.push("e.status NOT IN ('DELETED','ARCHIVED')");
  if (filter.section) {
    where.push(`(e.section_scope IS NULL OR e.section_scope = ?${bindings.length + 1})`);
    bindings.push(filter.section);
  }
  if (filter.subjectId) {
    where.push(`e.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.scope === 'upcoming' && filter.today) {
    where.push(`e.exam_date >= ?${bindings.length + 1}`);
    bindings.push(filter.today);
  }
  if (filter.scope === 'past' && filter.today) {
    where.push(`e.exam_date < ?${bindings.length + 1}`);
    bindings.push(filter.today);
  }
  if (filter.from) {
    where.push(`e.exam_date >= ?${bindings.length + 1}`);
    bindings.push(filter.from);
  }
  if (filter.to) {
    where.push(`e.exam_date <= ?${bindings.length + 1}`);
    bindings.push(filter.to);
  }
  const limit = limitOrDefault(filter.limit, 50, 200);
  bindings.push(limit);
  const order = filter.scope === 'past' ? 'DESC' : 'ASC';
  return allRows<ExamRow>(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.exam_date ${order} LIMIT ?${bindings.length}`).bind(...bindings));
}

export async function updateExam(
  db: D1Database,
  id: string,
  patch: Partial<Pick<ExamRow, 'title' | 'notes' | 'exam_date' | 'starts_at' | 'duration_minutes' | 'chapters' | 'room' | 'subject_id' | 'section_scope' | 'status' | 'book_id'>>,
  now: string,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?${values.length + 1}`);
    values.push(value);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(now);
  sets.push('revision = revision + 1');
  values.push(id);
  await db.prepare(`UPDATE exams SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
}

export function parseChapters(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((value): value is number => typeof value === 'number');
    return [];
  } catch {
    return [];
  }
}
