/**
 * School structure — the single source of truth the Android client reads
 * instead of hardcoding grades, sections or subjects anywhere (§112).
 */
import { allRows, firstOrNull } from './shared';

export interface AcademicYearRow {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface GradeRow {
  id: number;
  name: string;
  stage: string;
  order_index: number;
}

export interface SectionRow {
  id: number;
  grade_id: number;
  code: string;
  label: string;
  order_index: number;
}

export interface SubjectRow {
  id: number;
  name: string;
  short_name: string | null;
  emoji: string | null;
  color: string | null;
  order_index: number;
  is_active: number;
}

export function listAcademicYears(db: D1Database): Promise<AcademicYearRow[]> {
  return allRows<AcademicYearRow>(db.prepare('SELECT * FROM academic_years ORDER BY start_date DESC'));
}

export function findActiveAcademicYear(db: D1Database): Promise<AcademicYearRow | null> {
  return firstOrNull<AcademicYearRow>(db.prepare("SELECT * FROM academic_years WHERE status = 'ACTIVE' ORDER BY start_date DESC LIMIT 1"));
}

export function findAcademicYear(db: D1Database, id: string): Promise<AcademicYearRow | null> {
  return firstOrNull<AcademicYearRow>(db.prepare('SELECT * FROM academic_years WHERE id = ?1').bind(id));
}

export function listGrades(db: D1Database): Promise<GradeRow[]> {
  return allRows<GradeRow>(db.prepare('SELECT * FROM grades ORDER BY order_index ASC'));
}

export function listSections(db: D1Database): Promise<SectionRow[]> {
  return allRows<SectionRow>(db.prepare('SELECT * FROM sections ORDER BY grade_id ASC, order_index ASC'));
}

export function findSection(db: D1Database, gradeId: number, code: string): Promise<SectionRow | null> {
  return firstOrNull<SectionRow>(db.prepare('SELECT * FROM sections WHERE grade_id = ?1 AND code = ?2').bind(gradeId, code));
}

export function listSubjects(db: D1Database, gradeId?: number): Promise<SubjectRow[]> {
  if (!gradeId) {
    return allRows<SubjectRow>(db.prepare('SELECT * FROM subjects WHERE is_active = 1 ORDER BY order_index ASC'));
  }
  return allRows<SubjectRow>(
    db
      .prepare(
        `SELECT s.* FROM subjects s
           JOIN subject_grades sg ON sg.subject_id = s.id
          WHERE sg.grade_id = ?1 AND s.is_active = 1
          ORDER BY s.order_index ASC`,
      )
      .bind(gradeId),
  );
}

export function findSubject(db: D1Database, id: number): Promise<SubjectRow | null> {
  return firstOrNull<SubjectRow>(db.prepare('SELECT * FROM subjects WHERE id = ?1').bind(id));
}

export function subjectsByIds(db: D1Database, ids: number[]): Promise<SubjectRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return allRows<SubjectRow>(db.prepare(`SELECT * FROM subjects WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids));
}

export interface SchoolStructure {
  academicYear: AcademicYearRow | null;
  grades: GradeRow[];
  sections: SectionRow[];
  subjects: SubjectRow[];
}

/** One batched read for the registration screen and the settings screen. */
export async function loadSchoolStructure(db: D1Database, gradeId?: number): Promise<SchoolStructure> {
  const [academicYear, grades, sections, subjects] = await db.batch<AcademicYearRow | GradeRow | SectionRow | SubjectRow>([
    db.prepare("SELECT * FROM academic_years WHERE status = 'ACTIVE' ORDER BY start_date DESC LIMIT 1"),
    db.prepare('SELECT * FROM grades ORDER BY order_index ASC'),
    db.prepare('SELECT * FROM sections ORDER BY grade_id ASC, order_index ASC'),
    gradeId
      ? db
          .prepare(
            `SELECT s.* FROM subjects s JOIN subject_grades sg ON sg.subject_id = s.id
              WHERE sg.grade_id = ?1 AND s.is_active = 1 ORDER BY s.order_index ASC`,
          )
          .bind(gradeId)
      : db.prepare('SELECT * FROM subjects WHERE is_active = 1 ORDER BY order_index ASC'),
  ]);

  return {
    academicYear: (academicYear?.results?.[0] as AcademicYearRow | undefined) ?? null,
    grades: (grades?.results ?? []) as GradeRow[],
    sections: (sections?.results ?? []) as SectionRow[],
    subjects: (subjects?.results ?? []) as SubjectRow[],
  };
}

// ── holidays ─────────────────────────────────────────────────────────────────

export interface HolidayRow {
  id: string;
  academic_year_id: string;
  group_id: string | null;
  date: string;
  end_date: string | null;
  title: string;
  kind: string;
  created_by: string | null;
  created_at: string;
}

export async function holidayDates(db: D1Database, academicYearId: string, from: string, to: string, groupId?: string | null): Promise<string[]> {
  const rows = await allRows<{ date: string; end_date: string | null }>(
    db
      .prepare(
        `SELECT date, end_date FROM holidays
          WHERE academic_year_id = ?1
            AND (group_id IS NULL OR group_id = ?2)
            AND date <= ?4
            AND COALESCE(end_date, date) >= ?3`,
      )
      .bind(academicYearId, groupId ?? null, from, to),
  );
  const dates = new Set<string>();
  for (const row of rows) {
    let cursor = row.date;
    const end = row.end_date ?? row.date;
    for (let guard = 0; guard < 120; guard += 1) {
      dates.add(cursor);
      if (cursor >= end) break;
      const next = new Date(`${cursor}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
  }
  return [...dates].sort();
}

export function listHolidays(db: D1Database, academicYearId: string, from: string, to: string): Promise<HolidayRow[]> {
  return allRows<HolidayRow>(
    db
      .prepare('SELECT * FROM holidays WHERE academic_year_id = ?1 AND date <= ?3 AND COALESCE(end_date, date) >= ?2 ORDER BY date ASC')
      .bind(academicYearId, from, to),
  );
}

export async function insertHoliday(db: D1Database, row: HolidayRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO holidays (id, academic_year_id, group_id, date, end_date, title, kind, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(row.id, row.academic_year_id, row.group_id, row.date, row.end_date, row.title, row.kind, row.created_by, row.created_at)
    .run();
}
