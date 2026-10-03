/**
 * Questions, the GitHub-issues way (§30, §31, §32).
 * An issue can be attached to a homework, an exam, a lesson — or to nothing
 * but a group and a day.
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export type IssueStatus = 'OPEN' | 'IN_DISCUSSION' | 'SOLVED' | 'CLOSED';

export interface IssueRow {
  id: string;
  group_id: string;
  academic_year_id: string;
  subject_id: number | null;
  section_scope: string | null;
  study_date: string | null;
  title: string;
  body: string | null;
  status: IssueStatus;
  content_id: string | null;
  homework_id: string | null;
  exam_id: string | null;
  best_comment_id: string | null;
  comment_count: number;
  is_pinned: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  revision: number;
  author_name?: string;
  subject_name?: string | null;
  subject_emoji?: string | null;
  subject_color?: string | null;
  homework_title?: string | null;
  exam_title?: string | null;
  content_title?: string | null;
}

const SELECT = `SELECT i.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color,
                       hw.title AS homework_title, ex.title AS exam_title, ct.title AS content_title
                  FROM issues i
                  JOIN users u ON u.id = i.created_by
                  LEFT JOIN subjects s ON s.id = i.subject_id
                  LEFT JOIN homeworks hw ON hw.id = i.homework_id
                  LEFT JOIN exams ex ON ex.id = i.exam_id
                  LEFT JOIN content ct ON ct.id = i.content_id`;

export interface InsertIssueInput {
  id: string;
  groupId: string;
  academicYearId: string;
  subjectId: number | null;
  sectionScope: string | null;
  studyDate: string | null;
  title: string;
  body: string | null;
  contentId: string | null;
  homeworkId: string | null;
  examId: string | null;
  createdBy: string;
  now: string;
}

export async function insertIssue(db: D1Database, input: InsertIssueInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issues (id, group_id, academic_year_id, subject_id, section_scope, study_date, title, body, status,
                           content_id, homework_id, exam_id, comment_count, created_by, created_at, updated_at, last_activity_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'OPEN', ?9, ?10, ?11, 0, ?12, ?13, ?13, ?13, 1)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.academicYearId,
      input.subjectId,
      input.sectionScope,
      input.studyDate,
      input.title,
      input.body,
      input.contentId,
      input.homeworkId,
      input.examId,
      input.createdBy,
      input.now,
    )
    .run();
}

export function findIssueById(db: D1Database, id: string): Promise<IssueRow | null> {
  return firstOrNull<IssueRow>(db.prepare(`${SELECT} WHERE i.id = ?1`).bind(id));
}

export interface IssueFilter {
  groupId: string;
  section?: string | null;
  subjectId?: number | null;
  status?: IssueStatus | null;
  homeworkId?: string | null;
  examId?: string | null;
  contentId?: string | null;
  authorId?: string | null;
  query?: string | null;
  limit?: number;
}

export async function listIssues(db: D1Database, filter: IssueFilter): Promise<IssueRow[]> {
  const where: string[] = ['i.group_id = ?1'];
  const bindings: unknown[] = [filter.groupId];
  if (filter.section) {
    where.push(`(i.section_scope IS NULL OR i.section_scope = ?${bindings.length + 1})`);
    bindings.push(filter.section);
  }
  if (filter.subjectId) {
    where.push(`i.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.status) {
    where.push(`i.status = ?${bindings.length + 1}`);
    bindings.push(filter.status);
  }
  if (filter.homeworkId) {
    where.push(`i.homework_id = ?${bindings.length + 1}`);
    bindings.push(filter.homeworkId);
  }
  if (filter.examId) {
    where.push(`i.exam_id = ?${bindings.length + 1}`);
    bindings.push(filter.examId);
  }
  if (filter.contentId) {
    where.push(`i.content_id = ?${bindings.length + 1}`);
    bindings.push(filter.contentId);
  }
  if (filter.authorId) {
    where.push(`i.created_by = ?${bindings.length + 1}`);
    bindings.push(filter.authorId);
  }
  if (filter.query) {
    where.push(`(i.title LIKE ?${bindings.length + 1} OR COALESCE(i.body, '') LIKE ?${bindings.length + 1})`);
    bindings.push(`%${filter.query}%`);
  }
  const limit = limitOrDefault(filter.limit, 40, 100);
  bindings.push(limit);
  return allRows<IssueRow>(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY i.last_activity_at DESC LIMIT ?${bindings.length}`).bind(...bindings));
}

export async function updateIssueStatus(db: D1Database, id: string, status: IssueStatus, now: string): Promise<void> {
  await db
    .prepare('UPDATE issues SET status = ?1, updated_at = ?2, last_activity_at = ?2, revision = revision + 1 WHERE id = ?3')
    .bind(status, now, id)
    .run();
}

export async function setBestAnswer(db: D1Database, issueId: string, commentId: string | null, now: string): Promise<void> {
  await db
    .prepare('UPDATE issues SET best_comment_id = ?1, updated_at = ?2, last_activity_at = ?2, revision = revision + 1 WHERE id = ?3')
    .bind(commentId, now, issueId)
    .run();
}

export async function touchIssue(db: D1Database, id: string, now: string): Promise<void> {
  await db
    .prepare('UPDATE issues SET comment_count = comment_count + 1, last_activity_at = ?1, updated_at = ?1, revision = revision + 1 WHERE id = ?2')
    .bind(now, id)
    .run();
}

export interface IssueCommentRow {
  id: string;
  issue_id: string;
  user_id: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
  user_name?: string;
  user_grade?: number;
  user_section?: string;
}

export function listIssueComments(db: D1Database, issueId: string, limit = 100): Promise<IssueCommentRow[]> {
  return allRows<IssueCommentRow>(
    db
      .prepare(
        `SELECT ic.*, u.full_name AS user_name, u.grade_id AS user_grade, u.section_code AS user_section
           FROM issue_comments ic JOIN users u ON u.id = ic.user_id
          WHERE ic.issue_id = ?1 AND ic.status = 'VISIBLE'
          ORDER BY ic.created_at ASC LIMIT ?2`,
      )
      .bind(issueId, limit),
  );
}

export function findIssueComment(db: D1Database, id: string): Promise<IssueCommentRow | null> {
  return firstOrNull<IssueCommentRow>(db.prepare('SELECT * FROM issue_comments WHERE id = ?1').bind(id));
}

export async function insertIssueComment(
  db: D1Database,
  input: { id: string; issueId: string; userId: string; body: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issue_comments (id, issue_id, user_id, body, status, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, 'VISIBLE', ?5, ?5, 1)`,
    )
    .bind(input.id, input.issueId, input.userId, input.body, input.now)
    .run();
}

export async function setIssueCommentStatus(db: D1Database, id: string, status: 'VISIBLE' | 'HIDDEN' | 'DELETED', now: string): Promise<void> {
  await db.prepare('UPDATE issue_comments SET status = ?1, updated_at = ?2, revision = revision + 1 WHERE id = ?3').bind(status, now, id).run();
}
