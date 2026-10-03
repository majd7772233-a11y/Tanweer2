/**
 * Events (§25): trips, competitions, announcements, activities, holidays.
 * An event is not a lesson and may hang directly off a date.
 */
import { allRows, firstOrNull, limitOrDefault } from './shared';

export type EventKind = 'TRIP' | 'COMPETITION' | 'ANNOUNCEMENT' | 'ACTIVITY' | 'HOLIDAY' | 'MEETING' | 'OTHER';

export interface EventRow {
  id: string;
  group_id: string;
  academic_year_id: string;
  subject_id: number | null;
  section_scope: string | null;
  title: string;
  description: string | null;
  kind: EventKind;
  event_date: string;
  end_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  status: string;
  is_pinned: number;
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

const SELECT = `SELECT v.*, u.full_name AS author_name, s.name AS subject_name, s.emoji AS subject_emoji, s.color AS subject_color
                  FROM events v
                  JOIN users u ON u.id = v.created_by
                  LEFT JOIN subjects s ON s.id = v.subject_id`;

export interface InsertEventInput {
  id: string;
  groupId: string;
  academicYearId: string;
  subjectId: number | null;
  sectionScope: string | null;
  title: string;
  description: string | null;
  kind: EventKind;
  eventDate: string;
  endDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  createdBy: string;
  now: string;
}

export async function insertEvent(db: D1Database, input: InsertEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events (id, group_id, academic_year_id, subject_id, section_scope, title, description, kind,
                           event_date, end_date, starts_at, ends_at, location, status, created_by, created_at, updated_at, revision)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'PUBLISHED', ?14, ?15, ?15, 1)`,
    )
    .bind(
      input.id,
      input.groupId,
      input.academicYearId,
      input.subjectId,
      input.sectionScope,
      input.title,
      input.description,
      input.kind,
      input.eventDate,
      input.endDate,
      input.startsAt,
      input.endsAt,
      input.location,
      input.createdBy,
      input.now,
    )
    .run();
}

export function findEventById(db: D1Database, id: string): Promise<EventRow | null> {
  return firstOrNull<EventRow>(db.prepare(`${SELECT} WHERE v.id = ?1`).bind(id));
}

export interface EventFilter {
  groupId: string;
  section?: string | null;
  subjectId?: number | null;
  from?: string | null;
  to?: string | null;
  kind?: EventKind | null;
  scope?: 'upcoming' | 'past' | 'all';
  today?: string;
  limit?: number;
}

export async function listEvents(db: D1Database, filter: EventFilter): Promise<EventRow[]> {
  const where: string[] = ['v.group_id = ?1'];
  const bindings: unknown[] = [filter.groupId];
  where.push("v.status NOT IN ('DELETED','ARCHIVED')");
  if (filter.section) {
    where.push(`(v.section_scope IS NULL OR v.section_scope = ?${bindings.length + 1})`);
    bindings.push(filter.section);
  }
  if (filter.subjectId) {
    where.push(`v.subject_id = ?${bindings.length + 1}`);
    bindings.push(filter.subjectId);
  }
  if (filter.kind) {
    where.push(`v.kind = ?${bindings.length + 1}`);
    bindings.push(filter.kind);
  }
  if (filter.from) {
    where.push(`COALESCE(v.end_date, v.event_date) >= ?${bindings.length + 1}`);
    bindings.push(filter.from);
  }
  if (filter.to) {
    where.push(`v.event_date <= ?${bindings.length + 1}`);
    bindings.push(filter.to);
  }
  if (filter.scope === 'upcoming' && filter.today) {
    where.push(`COALESCE(v.end_date, v.event_date) >= ?${bindings.length + 1}`);
    bindings.push(filter.today);
  }
  if (filter.scope === 'past' && filter.today) {
    where.push(`COALESCE(v.end_date, v.event_date) < ?${bindings.length + 1}`);
    bindings.push(filter.today);
  }
  const limit = limitOrDefault(filter.limit, 50, 200);
  bindings.push(limit);
  const order = filter.scope === 'past' ? 'DESC' : 'ASC';
  return allRows<EventRow>(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY v.event_date ${order} LIMIT ?${bindings.length}`).bind(...bindings));
}

export async function updateEvent(
  db: D1Database,
  id: string,
  patch: Partial<Pick<EventRow, 'title' | 'description' | 'event_date' | 'end_date' | 'starts_at' | 'ends_at' | 'location' | 'kind' | 'subject_id' | 'section_scope' | 'status' | 'is_pinned'>>,
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
  await db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?${values.length}`).bind(...values).run();
}
