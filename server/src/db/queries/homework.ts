/**
 * Homework and tasks (§21, §22).
 *
 * 📝 واجب = something to solve      ✅ مهمة = something to bring or do
 * "تم الإنجاز" is stored per student and is private.
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export type HomeworkKind = 'HOMEWORK' | 'TASK';
export type HomeworkStatus = 'DRAFT' | 'PUBLISHED' | 'EDITED' | 'PENDING_CORRECTION' | 'PENDING_DELETION' | 'DELETED' | 'ARCHIVED';

export interface HomeworkRow {
  id: string;
  group_id: string;
  academic_year_id: string;
  subject_id: number | null;
  section_scope: string | null;
  study_date: string;
  due_date: string | null;
  due_time: string | null;
  kind: HomeworkKind;
  title: string;
  body: string | null;
  attachment_file_id: string | null;
  status: HomeworkStatus;
  is_pinned: number;
  useful_count: number;
  comment_count: number;
  completion_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
  // joined
  author_name?: string;
  subject_name?: string | null;
  subject_emoji?: string | null;
  subject_color?: string | null;
  group_name?: string;
  done?: string | null;
}

const SELECT = `SELECT h.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color,
                       g.name AS group_name,
                       COALESCE((SELECT hc.status FROM homework_completions hc WHERE hc.homework_id = h.id AND hc.user_id = ?1), 'NOT_DONE') AS done
                  FROM homeworks h
                  JOIN users u ON u.id = h.created_by
                  JOIN groups g ON g.id = h.group_id
                  LEFT JOIN subjects s ON s.id = h.subject_id`;

export interface InsertHomeworkInput {
  id: string;
  groupId: string;
  academicYearId: string;
  subjectId: number | null;
  sectionScope: string | null;
  studyDate: string;
  dueDate: string | null;
  dueTime: string | null;
  kind: HomeworkKind;
  title: string;
  body: string | null;
  attachmentFileId: string | null;
  createdBy: string;
  now: string;
}

export async function insertHomework(db: D1Database, input: InsertHomeworkInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO homeworks (id, group_id, academic_year_id, subject_id, section_scope, study_date, due_date, due_time, kind,
                              title, body, attachment_file_id, status, created_by, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'PUBLISHED', ?13, ?14, ?14, 1)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.academicYearId,
      input.subjectId,
      input.sectionScope,
      input.studyDate,
      input.dueDate,
      input.dueTime,
      input.kind,
      input.title,
      input.body,
      input.attachmentFileId,
      input.createdBy,
      input.now,
    )
    .run();
}

export function findHomeworkById(db: D1Database, userId: string, id: string): Promise<HomeworkRow | null> {
  return firstOrNull<HomeworkRow>(db.prepare(`${SELECT} WHERE h.id = ?2`).bind(userId, id));
}

export interface HomeworkFilter {
  groupId: string;
  userId: string;
  section?: string | null;
  subjectId?: number | null;
  from?: string | null;
  to?: string | null;
  dueFrom?: string | null;
  dueTo?: string | null;
  kind?: HomeworkKind | null;
  status?: HomeworkStatus | 'OPEN' | 'DONE' | null;
  limit?: number;
}

export async function listHomeworks(db: D1Database, filter: HomeworkFilter): Promise<HomeworkRow[]> {
  const where: string[] = ['h.group_id = ?2'];
  const bindings: unknown[] = [filter.userId, filter.groupId];
  where.push("h.status NOT IN ('DELETED','ARCHIVED')");
  if (filter.section) {
    where.push(`(h.section_scope IS NULL OR h.section_scope = ?${bindings.length + 1})`);
    bindings.push(filter.section);
  }
  if (filter.subjectId) {
    where.push(`h.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.from) {
    where.push(`h.study_date >= ?${bindings.length + 1}`);
    bindings.push(filter.from);
  }
  if (filter.to) {
    where.push(`h.study_date <= ?${bindings.length + 1}`);
    bindings.push(filter.to);
  }
  if (filter.dueFrom) {
    where.push(`COALESCE(h.due_date, h.study_date) >= ?${bindings.length + 1}`);
    bindings.push(filter.dueFrom);
  }
  if (filter.dueTo) {
    where.push(`COALESCE(h.due_date, h.study_date) <= ?${bindings.length + 1}`);
    bindings.push(filter.dueTo);
  }
  if (filter.kind) {
    where.push(`h.kind = ?${bindings.length + 1}`);
    bindings.push(filter.kind);
  }
  if (filter.status === 'DONE') where.push("done = 'DONE'");
  if (filter.status === 'OPEN') where.push("done <> 'DONE'");

  const limit = limitOrDefault(filter.limit, 50, 200);
  bindings.push(limit);
  return allRows<HomeworkRow>(
    db
      .prepare(
        `${SELECT} WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(h.due_date, h.study_date) ASC, h.is_pinned DESC, h.created_at DESC
          LIMIT ?${bindings.length}`,
      )
      .bind(...bindings),
  );
}

export async function listDayHomeworks(db: D1Database, userId: string, groupId: string, date: string, section: string | null): Promise<HomeworkRow[]> {
  const clamp = section ? 'AND (h.section_scope IS NULL OR h.section_scope = ?4)' : '';
  const statement = db
    .prepare(
      `${SELECT} WHERE h.group_id = ?2 AND h.status NOT IN ('DELETED','ARCHIVED')
         AND (h.study_date = ?3 OR h.due_date = ?3) ${clamp}
        ORDER BY h.kind ASC, h.created_at DESC LIMIT 60`,
    )
    .bind(...(section ? [userId, groupId, date, section] : [userId, groupId, date]));
  return allRows<HomeworkRow>(statement);
}

export async function updateHomework(
  db: D1Database,
  id: string,
  patch: Partial<Pick<HomeworkRow, 'title' | 'body' | 'due_date' | 'due_time' | 'kind' | 'subject_id' | 'study_date' | 'section_scope' | 'status' | 'attachment_file_id' | 'is_pinned'>>,
  now: string,
  expectedRevision?: number,
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?${values.length + 1}`);
    values.push(value);
  }
  if (sets.length === 0) return true;
  sets.push(`updated_at = ?${values.length + 1}`);
  values.push(now);
  sets.push('revision = revision + 1');
  const where = [`id = ?${values.length + 1}`];
  values.push(id);
  if (expectedRevision !== undefined) {
    where.push(`revision = ?${values.length + 1}`);
    values.push(expectedRevision);
  }
  const result = await db.prepare(`UPDATE homeworks SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).bind(...values).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function setHomeworkCompletion(
  db: D1Database,
  homeworkId: string,
  userId: string,
  done: boolean,
  now: string,
  note: string | null = null,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO homework_completions (homework_id, user_id, status, note, completed_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (homework_id, user_id) DO UPDATE SET status = excluded.status, note = excluded.note,
         completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
    )
    .bind(homeworkId, userId, done ? 'DONE' : 'NOT_DONE', note, now)
    .run();

  const count = await firstOrNull<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM homework_completions WHERE homework_id = ?1 AND status = 'DONE'").bind(homeworkId),
  );
  const total = count?.n ?? 0;
  await db.prepare('UPDATE homeworks SET completion_count = ?1 WHERE id = ?2').bind(total, homeworkId).run();
  return total;
}

/** Due reminders for the local device scheduler (§78). */
export async function dueSoonHomeworks(db: D1Database, userId: string, date: string, limit = 50): Promise<HomeworkRow[]> {
  return allRows<HomeworkRow>(
    db
      .prepare(
        `${SELECT} WHERE h.due_date = ?2 AND h.status NOT IN ('DELETED','ARCHIVED')
           AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = h.group_id AND m.user_id = ?1 AND m.status = 'ACTIVE')
          ORDER BY h.due_time ASC LIMIT ?3`,
      )
      .bind(userId, date, limit),
  );
}

export async function homeworkStats(db: D1Database, userId: string, groupIds: string[], today: string): Promise<{ open: number; overdue: number; dueToday: number }> {
  if (groupIds.length === 0) return { open: 0, overdue: 0, dueToday: 0 };
  const row = await firstOrNull<{ open: number; overdue: number; due_today: number }>(
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN COALESCE(done.status, 'NOT_DONE') <> 'DONE' THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN COALESCE(done.status, 'NOT_DONE') <> 'DONE' AND COALESCE(h.due_date, h.study_date) < ?2 THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN COALESCE(done.status, 'NOT_DONE') <> 'DONE' AND h.due_date = ?2 THEN 1 ELSE 0 END) AS due_today
         FROM homeworks h
         LEFT JOIN homework_completions done ON done.homework_id = h.id AND done.user_id = ?1
        WHERE h.group_id IN (${groupIds.map(() => '?').join(', ')}) AND h.status NOT IN ('DELETED','ARCHIVED')`,
      )
      .bind(userId, today, ...groupIds),
  );
  return { open: Number(row?.open ?? 0), overdue: Number(row?.overdue ?? 0), dueToday: Number(row?.due_today ?? 0) };
}
