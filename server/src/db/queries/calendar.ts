/**
 * Everything the calendar and the "اليوم" screen need, in as few D1 round
 * trips as possible: one `db.batch` per screen instead of a request per widget.
 */
import { allRows, firstOrNull } from './shared';
import type { ContentRow } from './content';
import type { EventRow } from './events';
import type { ExamRow } from './exams';
import type { HomeworkRow } from './homework';
import { findVersionForDate, listSlots, type ScheduleVersionRow, type SlotWithSubject } from './schedule';

export interface DayContentStat {
  subject_id: number | null;
  type: string;
  n: number;
}

export interface DayBundle {
  date: string;
  version: ScheduleVersionRow | null;
  slots: SlotWithSubject[];
  contentStats: DayContentStat[];
  homeworks: HomeworkRow[];
  exams: ExamRow[];
  events: EventRow[];
  latestContent: ContentRow[];
}

function sectionClause(section: string | null | undefined, column: string): string {
  if (!section) return '';
  return ` AND (${column} IS NULL OR ${column} = '${section.replace(/'/g, "''")}')`;
}

/**
 * One day = one batch: timetable for that weekday, content counters per subject,
 * homeworks, exams, events and the most recent contributions.
 */
export async function getDayBundle(
  db: D1Database,
  params: { groupId: string; date: string; weekday: number; section?: string | null },
): Promise<DayBundle> {
  const { groupId, date, weekday, section } = params;
  const version = await findVersionForDate(db, groupId, date);

  const [slots, contentStats, homeworks, exams, events, latestContent] = await db.batch<
    SlotWithSubject | DayContentStat | HomeworkRow | ExamRow | EventRow | ContentRow
  >([
    version
      ? db
          .prepare(
            `SELECT sl.*, s.name AS subject_name, s.short_name AS subject_short, s.emoji AS subject_emoji, s.color AS subject_color
               FROM schedule_slots sl JOIN subjects s ON s.id = sl.subject_id
              WHERE sl.version_id = ?1 AND sl.weekday = ?2 ORDER BY sl.period ASC`,
          )
          .bind(version.id, weekday)
      : db.prepare('SELECT 1 WHERE 0'),
    db
      .prepare(
        `SELECT subject_id, type, COUNT(*) AS n FROM content
          WHERE group_id = ?1 AND study_date = ?2 AND status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'section_scope')}
          GROUP BY subject_id, type`,
      )
      .bind(groupId, date),
    db
      .prepare(
        `SELECT h.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, u.full_name AS author_name
           FROM homeworks h
           LEFT JOIN subjects s ON s.id = h.subject_id
           JOIN users u ON u.id = h.created_by
          WHERE h.group_id = ?1 AND (h.study_date = ?2 OR h.due_date = ?2) AND h.status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'h.section_scope')}
          ORDER BY h.created_at DESC LIMIT 50`,
      )
      .bind(groupId, date),
    db
      .prepare(
        `SELECT e.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, u.full_name AS author_name
           FROM exams e
           LEFT JOIN subjects s ON s.id = e.subject_id
           JOIN users u ON u.id = e.created_by
          WHERE e.group_id = ?1 AND e.exam_date = ?2 AND e.status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'e.section_scope')}
          ORDER BY e.starts_at ASC LIMIT 30`,
      )
      .bind(groupId, date),
    db
      .prepare(
        `SELECT v.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, u.full_name AS author_name
           FROM events v
           LEFT JOIN subjects s ON s.id = v.subject_id
           JOIN users u ON u.id = v.created_by
          WHERE v.group_id = ?1 AND v.event_date <= ?2 AND COALESCE(v.end_date, v.event_date) >= ?2 AND v.status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'v.section_scope')}
          ORDER BY v.starts_at ASC LIMIT 30`,
      )
      .bind(groupId, date),
    db
      .prepare(
        `SELECT c.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
           FROM content c
           JOIN users u ON u.id = c.created_by
           LEFT JOIN subjects s ON s.id = c.subject_id
          WHERE c.group_id = ?1 AND c.study_date = ?2 AND c.status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'c.section_scope')}
          ORDER BY c.created_at DESC LIMIT 60`,
      )
      .bind(groupId, date),
  ]);

  return {
    date,
    version,
    slots: (slots?.results ?? []) as SlotWithSubject[],
    contentStats: (contentStats?.results ?? []) as DayContentStat[],
    homeworks: (homeworks?.results ?? []) as HomeworkRow[],
    exams: (exams?.results ?? []) as ExamRow[],
    events: (events?.results ?? []) as EventRow[],
    latestContent: (latestContent?.results ?? []) as ContentRow[],
  };
}

export interface MonthDigestRow {
  date: string;
  lessons: number;
  files: number;
  homeworks: number;
  homework_due: number;
  exams: number;
  events: number;
  documented_subjects: number;
}

/**
 * Focused month digest for the calendar grid: one aggregate row per day that
 * actually has something, plus the days that have school but nothing yet.
 */
export async function getMonthDigest(
  db: D1Database,
  params: { groupId: string; start: string; end: string; section?: string | null },
): Promise<MonthDigestRow[]> {
  const { groupId, start, end, section } = params;
  const clause = sectionClause(section, 'section_scope');

  const [contentRows, homeworkRows, examRows, eventRows] = await db.batch<
    { study_date?: string; due_date?: string; exam_date?: string; event_date?: string; n: number; lessons?: number; files?: number; subjects?: number }
  >([
    db
      .prepare(
        `SELECT study_date AS date, COUNT(*) AS n,
                SUM(CASE WHEN type = 'LESSON' THEN 1 ELSE 0 END) AS lessons,
                SUM(CASE WHEN type IN ('FILE','PHOTO') THEN 1 ELSE 0 END) AS files,
                COUNT(DISTINCT subject_id) AS subjects
           FROM content
          WHERE group_id = ?1 AND study_date BETWEEN ?2 AND ?3 AND status NOT IN ('DELETED','ARCHIVED')${clause}
          GROUP BY study_date`,
      )
      .bind(groupId, start, end),
    db
      .prepare(
        `SELECT study_date AS date,
                SUM(CASE WHEN kind = 'HOMEWORK' THEN 1 ELSE 0 END) AS homeworks,
                SUM(CASE WHEN due_date = study_date THEN 1 ELSE 0 END) AS homework_due
           FROM homeworks
          WHERE group_id = ?1 AND study_date BETWEEN ?2 AND ?3 AND status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'section_scope')}
          GROUP BY study_date`,
      )
      .bind(groupId, start, end),
    db
      .prepare(
        `SELECT exam_date AS date, COUNT(*) AS n FROM exams
          WHERE group_id = ?1 AND exam_date BETWEEN ?2 AND ?3 AND status NOT IN ('DELETED','ARCHIVED')${clause}
          GROUP BY exam_date`,
      )
      .bind(groupId, start, end),
    db
      .prepare(
        `SELECT event_date AS date, COUNT(*) AS n FROM events
          WHERE group_id = ?1 AND event_date BETWEEN ?2 AND ?3 AND status NOT IN ('DELETED','ARCHIVED')${sectionClause(section, 'section_scope')}
          GROUP BY event_date`,
      )
      .bind(groupId, start, end),
  ]);

  const byDate = new Map<string, MonthDigestRow>();
  const ensure = (date: string): MonthDigestRow => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const fresh: MonthDigestRow = {
      date,
      lessons: 0,
      files: 0,
      homeworks: 0,
      homework_due: 0,
      exams: 0,
      events: 0,
      documented_subjects: 0,
    };
    byDate.set(date, fresh);
    return fresh;
  };

  for (const row of (contentRows?.results ?? []) as unknown as Array<{ date: string; lessons: number; files: number; subjects: number }>) {
    const entry = ensure(row.date);
    entry.lessons = Number(row.lessons ?? 0);
    entry.files = Number(row.files ?? 0);
    entry.documented_subjects = Number(row.subjects ?? 0);
  }
  for (const row of (homeworkRows?.results ?? []) as unknown as Array<{ date: string; homeworks: number; homework_due: number }>) {
    const entry = ensure(row.date);
    entry.homeworks = Number(row.homeworks ?? 0);
    entry.homework_due = Number(row.homework_due ?? 0);
  }
  for (const row of (examRows?.results ?? []) as unknown as Array<{ date: string; n: number }>) {
    ensure(row.date).exams = Number(row.n ?? 0);
  }
  for (const row of (eventRows?.results ?? []) as Array<{ date: string; n: number }>) {
    ensure(row.date).events = Number(row.n ?? 0);
  }

  return [...byDate.values()];
}

/** "ماذا فاتني؟" (§36) — counted on the server, one batch, from last_seen_at. */
export interface MissedSummary {
  since: string;
  lessons: number;
  homeworks: number;
  exams: number;
  events: number;
  solvedIssues: number;
  contributions: number;
}

export async function getMissedSummary(db: D1Database, params: { userId: string; since: string; today: string }): Promise<MissedSummary> {
  const { userId, since, today } = params;
  const membership = `JOIN group_members m ON m.group_id = x.group_id AND m.user_id = ?1 AND m.status = 'ACTIVE'`;

  const [lessons, homeworks, exams, events, solved, contributions] = await db.batch<{ n: number }>([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM content x ${membership}
          WHERE x.created_at > ?2 AND x.status NOT IN ('DELETED','ARCHIVED') AND x.type IN ('LESSON','PHOTO') AND x.created_by <> ?1`,
      )
      .bind(userId, since),
    db
      .prepare(`SELECT COUNT(*) AS n FROM homeworks x ${membership} WHERE x.created_at > ?2 AND x.status NOT IN ('DELETED','ARCHIVED') AND x.created_by <> ?1`)
      .bind(userId, since),
    db
      .prepare(`SELECT COUNT(*) AS n FROM exams x ${membership} WHERE x.created_at > ?2 AND x.exam_date >= ?3 AND x.status NOT IN ('DELETED','ARCHIVED')`)
      .bind(userId, since, today),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events x ${membership} WHERE x.created_at > ?2 AND COALESCE(x.end_date, x.event_date) >= ?3 AND x.status NOT IN ('DELETED','ARCHIVED')`,
      )
      .bind(userId, since, today),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM issues i ${membership.replace('x.', 'i.')}
          WHERE i.status = 'SOLVED' AND i.updated_at > ?2`,
      )
      .bind(userId, since),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM content_contributions cc ${membership.replace('x.', 'cc.')} WHERE cc.created_at > ?2 AND cc.user_id <> ?1`,
      )
      .bind(userId, since),
  ]);

  const value = (result: D1Result<unknown> | undefined): number => Number((result?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return {
    since,
    lessons: value(lessons),
    homeworks: value(homeworks),
    exams: value(exams),
    events: value(events),
    solvedIssues: value(solved),
    contributions: value(contributions),
  };
}

/** Upcoming exams / nearest event, for the home summary strip. */
export async function nextExamForGroup(db: D1Database, groupId: string, today: string): Promise<ExamRow | null> {
  return firstOrNull<ExamRow>(
    db
      .prepare(
        `SELECT e.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, u.full_name AS author_name
           FROM exams e LEFT JOIN subjects s ON s.id = e.subject_id JOIN users u ON u.id = e.created_by
          WHERE e.group_id = ?1 AND e.exam_date >= ?2 AND e.status NOT IN ('DELETED','ARCHIVED')
          ORDER BY e.exam_date ASC LIMIT 1`,
      )
      .bind(groupId, today),
  );
}

export async function upcomingExams(db: D1Database, groupId: string, today: string, limit = 20): Promise<ExamRow[]> {
  return allRows<ExamRow>(
    db
      .prepare(
        `SELECT e.*, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color, u.full_name AS author_name
           FROM exams e LEFT JOIN subjects s ON s.id = e.subject_id JOIN users u ON u.id = e.created_by
          WHERE e.group_id = ?1 AND e.exam_date >= ?2 AND e.status NOT IN ('DELETED','ARCHIVED')
          ORDER BY e.exam_date ASC LIMIT ?3`,
      )
      .bind(groupId, today, limit),
  );
}
