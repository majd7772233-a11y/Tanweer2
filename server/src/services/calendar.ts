/**
 * The calendar is the heart of Tanweer (§12, §13, §14, §34, §35).
 *
 *  • "اليوم" reads the real timetable, never a guess;
 *  • a subject card is ✅ documented, 🟡 needs a contribution, or ⚪ not yet;
 *  • "غدًا" jumps to the next real school day (Friday, Saturday and holidays are
 *    skipped);
 *  • any day can still receive content afterwards — a lesson from last week is
 *    valid documentation (§15).
 */
import type { Ctx } from '../lib/context';
import { ApiError } from '../lib/errors';
import { addDays, isIsoDate, localMinutes, monthBounds, nextSchoolDay, previousSchoolDay, weekdayOf, monthOf, addMonths, WEEKDAYS, daysBetween } from '../lib/date';
import { getDayBundle, getMonthDigest, nextExamForGroup, upcomingExams, type MonthDigestRow } from '../db/queries/calendar';
import { holidayDates, listAcademicYears } from '../db/queries/structure';
import { findVersionForDate, listSlots, listVersions, type SlotWithSubject } from '../db/queries/schedule';
import { requireMembership } from '../middleware/permissions';
import { listContent, listMediaForContents, subjectTimeline, type ContentRow } from '../db/queries/content';
import { listHomeworks } from '../db/queries/homework';
import { listExams } from '../db/queries/exams';
import { listEvents } from '../db/queries/events';
import { listIssues } from '../db/queries/issues';
import { listGroupsForUser } from '../db/queries/groups';
import { contentDto, examDto, eventDto, homeworkDto, subjectDto } from './dto';
import { defaultGroupIdFor } from './groups';
import { listSubjects } from '../db/queries/structure';

export type CardStatus = 'DOCUMENTED' | 'NEEDS_CONTRIBUTION' | 'UPCOMING' | 'NOT_SCHOOL_DAY';

export interface DayCard {
  period: number | null;
  title: string;
  subject: ReturnType<typeof subjectDto>;
  status: CardStatus;
  lessons: number;
  homeworks: number;
  files: number;
  notes: number;
  contributions: number;
  lastContributionAt: string | null;
  canContribute: boolean;
}

interface DayOverviewOptions {
  groupId: string;
  date: string;
}

/** The subject cards of one day (§8, §9, §14). */
export async function dayOverview(ctx: Ctx, options: DayOverviewOptions) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, options.groupId);
  const section = access.group.kind === 'SHARED' ? user.sectionCode : null;

  const [bundle, homeworkRows, examRows, eventRows] = await Promise.all([
    getDayBundle(db, { groupId: options.groupId, date: options.date, weekday: weekdayOf(options.date), section }),
    listHomeworks(db, { groupId: options.groupId, userId: user.id, section, from: options.date, to: options.date, limit: 50 }),
    listExams(db, { groupId: options.groupId, section, scope: 'all', from: options.date, to: options.date, limit: 30 }),
    listEvents(db, { groupId: options.groupId, section, scope: 'all', from: options.date, to: options.date, limit: 30 }),
  ]);

  const statsBySubject = new Map<number, { lessons: number; files: number; notes: number; photos: number; contributions: number }>();
  for (const stat of bundle.contentStats) {
    if (stat.subject_id === null) continue;
    const entry = statsBySubject.get(stat.subject_id) ?? { lessons: 0, files: 0, notes: 0, photos: 0, contributions: 0 };
    if (stat.type === 'LESSON' || stat.type === 'SUMMARY') entry.lessons += stat.n;
    else if (stat.type === 'FILE') entry.files += stat.n;
    else if (stat.type === 'NOTE') entry.notes += stat.n;
    else if (stat.type === 'PHOTO') entry.photos += stat.n;
    statsBySubject.set(stat.subject_id, entry);
  }

  const nowMinutes = localMinutes(ctx.timeZone);
  const isToday = options.date === ctx.today;
  const isPast = options.date < ctx.today;
  const holidaySet = await holidayDates(db, access.group.academic_year_id, options.date, options.date, options.groupId);
  const isHoliday = holidaySet.includes(options.date);
  const weekday = weekdayOf(options.date);
  const isSchoolDay = weekday !== 5 && weekday !== 6 && !isHoliday;

  const cards: DayCard[] = [];
  for (const slot of bundle.slots) {
    const stats = statsBySubject.get(slot.subject_id) ?? { lessons: 0, files: 0, notes: 0, photos: 0, contributions: 0 };
    const total = stats.lessons + stats.files + stats.notes + stats.photos;
    let status: CardStatus;
    if (total > 0) status = 'DOCUMENTED';
    else if (!isSchoolDay) status = 'NOT_SCHOOL_DAY';
    else if (isPast) status = 'NEEDS_CONTRIBUTION';
    else if (isToday && periodEnded(nowMinutes, slot.period)) status = 'NEEDS_CONTRIBUTION';
    else status = 'UPCOMING';

    cards.push({
      period: slot.period,
      title: slot.subject_name,
      subject: { id: slot.subject_id, name: slot.subject_name, shortName: slot.subject_short, emoji: slot.subject_emoji, color: slot.subject_color },
      status,
      lessons: stats.lessons,
      homeworks: homeworkRows.filter((homework) => homework.subject_id === slot.subject_id).length,
      files: stats.files,
      notes: stats.notes,
      contributions: stats.contributions,
      lastContributionAt: null,
      canContribute: isSchoolDay && access.isMember,
    });
  }

  // Content that has no matching timetable slot (a late upload, a club lesson).
  for (const row of bundle.latestContent) {
    if (row.subject_id && cards.some((card) => card.subject?.id === row.subject_id)) continue;
    const subject = row.subject_id
      ? { id: row.subject_id, name: row.subject_name ?? '', shortName: null, emoji: row.subject_emoji ?? null, color: row.subject_color ?? null }
      : null;
    cards.push({
      period: row.period,
      title: subject?.name ?? row.title,
      subject,
      status: 'DOCUMENTED',
      lessons: row.type === 'LESSON' ? 1 : 0,
      homeworks: 0,
      files: row.type === 'FILE' ? 1 : 0,
      notes: row.type === 'NOTE' ? 1 : 0,
      contributions: row.contribution_count,
      lastContributionAt: row.updated_at,
      canContribute: access.isMember,
    });
  }

  const documented = cards.filter((card) => card.status === 'DOCUMENTED').length;
  const needsContribution = cards.filter((card) => card.status === 'NEEDS_CONTRIBUTION').length;
  const upcoming = cards.filter((card) => card.status === 'UPCOMING').length;

  const nextExam = await nextExamForGroup(db, options.groupId, ctx.today);
  const progress = cards.length === 0 ? 0 : Math.round((documented / cards.length) * 100);

  return {
    date: options.date,
    weekday,
    weekdayName: WEEKDAYS[weekday] ?? '',
    isToday,
    isSchoolDay,
    isHoliday,
    holidayTitle: isHoliday ? 'يوم إجازة' : null,
    scheduleVersionId: bundle.version?.id ?? null,
    cards,
    documentedCount: documented,
    needsContributionCount: needsContribution,
    upcomingCount: upcoming,
    totalCount: cards.length,
    progress,
    homeworks: homeworkRows.map((row) => homeworkDto(row, { mine: row.created_by === user.id })),
    exams: examRows.map((row) => examDto(row)),
    events: eventRows.map((row) => eventDto(row)),
    nextExam: nextExam
      ? {
          id: nextExam.id,
          title: nextExam.title,
          examDate: nextExam.exam_date,
          daysUntil: daysBetween(ctx.today, nextExam.exam_date),
          subject: nextExam.subject_id ? { id: nextExam.subject_id, name: nextExam.subject_name ?? '', shortName: null, emoji: nextExam.subject_emoji ?? null, color: nextExam.subject_color ?? null } : null,
        }
      : null,
  };
}

function periodEnded(nowMinutes: number, period: number): boolean {
  // Periods are 45 minutes long starting at 07:30 with a 15 minute break.
  const start = 7 * 60 + 30 + (period - 1) * 60;
  return nowMinutes >= start + 45;
}

/** GET /day/:date */
export async function dayPage(ctx: Ctx) {
  const date = ctx.param('date');
  if (!isIsoDate(date)) throw new ApiError('VALIDATION_ERROR', 'التاريخ غير صحيح.');
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');

  const overview = await dayOverview(ctx, { groupId, date });
  const content = await listContent(ctx.env.TANWEER_DB, {
    groupId,
    section: await sectionFor(ctx, groupId),
    date,
    limit: 60,
  });
  const media = await listMediaForContents(ctx.env.TANWEER_DB, content.map((row) => row.id));
  const issues = await listIssues(ctx.env.TANWEER_DB, { groupId, limit: 30 });

  return {
    ...overview,
    content: content.map((row) => contentDto(row, { media: media.get(row.id) ?? [], mine: row.created_by === ctx.user?.id })),
    openIssues: issues.filter((issue) => issue.status === 'OPEN' || issue.status === 'IN_DISCUSSION').length,
  };
}

async function sectionFor(ctx: Ctx, groupId: string): Promise<string | null> {
  const access = await requireMembership(ctx, groupId);
  return access.group.kind === 'SHARED' ? ctx.user?.sectionCode ?? null : null;
}

async function defaultGroupId(ctx: Ctx): Promise<string | null> {
  return defaultGroupIdFor(ctx);
}

/** GET /today */
export async function today(ctx: Ctx) {
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  return dayOverview(ctx, { groupId, date: ctx.today });
}

/** GET /tomorrow — the next *school* day, not tomorrow's date (§11). */
export async function nextDay(ctx: Ctx) {
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, groupId);
  const holidays = new Set(await holidayDates(db, access.group.academic_year_id, ctx.today, addDays(ctx.today, 45), groupId));
  const target = nextSchoolDay(ctx.today, holidays);
  const overview = await dayOverview(ctx, { groupId, date: target });
  const dueTomorrow = await listHomeworks(db, {
    groupId,
    userId: user.id,
    section: access.group.kind === 'SHARED' ? user.sectionCode : null,
    dueFrom: target,
    dueTo: target,
    limit: 30,
  });
  return { ...overview, skippedDays: daysBetween(ctx.today, target) - 1, homeworksDue: dueTomorrow.map((row) => homeworkDto(row)) };
}

/** GET /yesterday — practical when a lesson was only photographed later. */
export async function previousDay(ctx: Ctx) {
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const holidays = new Set(await holidayDates(ctx.env.TANWEER_DB, access.group.academic_year_id, addDays(ctx.today, -45), ctx.today, groupId));
  const target = previousSchoolDay(ctx.today, holidays);
  return dayOverview(ctx, { groupId, date: target });
}

/** GET /calendar?month=YYYY-MM */
export async function month(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const monthRaw = ctx.q('month') ?? monthOf(ctx.today);
  const { start, end, days } = monthBounds(monthRaw);
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const db = ctx.env.TANWEER_DB;
  const access = await requireMembership(ctx, groupId);
  const section = access.group.kind === 'SHARED' ? user.sectionCode : null;

  const [digest, holidays, homeworkDue, exams, events, version] = await Promise.all([
    getMonthDigest(db, { groupId, start, end, section }),
    holidayDates(db, access.group.academic_year_id, start, end, groupId),
    listHomeworks(db, { groupId, userId: user.id, section, dueFrom: start, dueTo: end, limit: 200 }),
    listExams(db, { groupId, section, scope: 'all', from: start, to: end, limit: 100 }),
    listEvents(db, { groupId, section, scope: 'all', from: start, to: end, limit: 100 }),
    findVersionForDate(db, groupId, end),
  ]);

  const schoolWeekdays = new Set<number>();
  if (version) {
    const slots = await listSlots(db, version.id);
    for (const slot of slots) schoolWeekdays.add(slot.weekday);
  }

  const digestMap = new Map<string, MonthDigestRow>(digest.map((row) => [row.date, row]));
  const daysOut: Array<{
    date: string;
    weekday: number;
    isSchoolDay: boolean;
    isHoliday: boolean;
    lessons: number;
    files: number;
    homeworks: number;
    exams: number;
    events: number;
    documentedSubjects: number;
    needsContribution: boolean;
  }> = [];

  for (let index = 0; index < days; index += 1) {
    const date = addDays(start, index);
    const weekday = weekdayOf(date);
    const isHoliday = holidays.includes(date);
    const isSchoolDay = weekday !== 5 && weekday !== 6 && !isHoliday && (schoolWeekdays.size === 0 || schoolWeekdays.has(weekday));
    const row = digestMap.get(date);
    daysOut.push({
      date,
      weekday,
      isSchoolDay,
      isHoliday,
      lessons: row?.lessons ?? 0,
      files: row?.files ?? 0,
      homeworks: row?.homeworks ?? 0,
      exams: row?.exams ?? 0,
      events: row?.events ?? 0,
      documentedSubjects: row?.documented_subjects ?? 0,
      needsContribution: isSchoolDay && date <= ctx.today && (row?.lessons ?? 0) === 0,
    });
  }

  return {
    month: monthRaw,
    start,
    end,
    previousMonth: addMonths(monthRaw, -1),
    nextMonth: addMonths(monthRaw, 1),
    today: ctx.today,
    days: daysOut,
    homeworkDue: homeworkDue.map((row) => ({ id: row.id, title: row.title, dueDate: row.due_date, subject: row.subject_name ?? null })),
    exams: exams.map((row) => ({ id: row.id, title: row.title, examDate: row.exam_date, subject: row.subject_name ?? null })),
    events: events.map((row) => ({ id: row.id, title: row.title, eventDate: row.event_date, kind: row.kind })),
  };
}

/** GET /subjects/:id/timeline — رحلة المادة (§34) */
export async function subjectJourney(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const groupId = ctx.q('groupId') ?? (await defaultGroupId(ctx));
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const subjectId = Number.parseInt(ctx.param('subjectId'), 10);
  if (!Number.isFinite(subjectId)) throw new ApiError('SUBJECT_NOT_FOUND');
  const access = await requireMembership(ctx, groupId);
  const section = access.group.kind === 'SHARED' ? user.sectionCode : null;
  const db = ctx.env.TANWEER_DB;

  const [timeline, subjects, exams, homeworkRows] = await Promise.all([
    subjectTimeline(db, groupId, subjectId, section, 120),
    listSubjects(db),
    listExams(db, { groupId, section, subjectId, scope: 'all', limit: 100 }),
    listHomeworks(db, { groupId, userId: user.id, section, subjectId, limit: 100 }),
  ]);

  const subject = subjects.find((item) => item.id === subjectId);
  if (!subject) throw new ApiError('SUBJECT_NOT_FOUND');

  return {
    subject: subjectDto(subject),
    timeline,
    exams: exams.map((row) => examDto(row)),
    homeworks: homeworkRows.map((row) => homeworkDto(row)),
    firstDate: timeline.length > 0 ? timeline[timeline.length - 1]?.date ?? null : null,
    lastDate: timeline[0]?.date ?? null,
    counts: {
      content: timeline.filter((item) => item.kind === 'CONTENT').length,
      homeworks: timeline.filter((item) => item.kind === 'HOMEWORK').length,
      exams: timeline.filter((item) => item.kind === 'EXAM').length,
    },
  };
}

/** GET /year-map — خريطة العام الدراسي (§35) */
export async function yearMap(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError('UNAUTHORIZED');
  const db = ctx.env.TANWEER_DB;
  const years = await listAcademicYears(db);
  const groups = await listGroupsForUser(db, user.id);
  const groupId = ctx.q('groupId') ?? groups.find((group) => group.kind === 'CLASS')?.id ?? groups[0]?.id ?? null;
  if (!groupId) throw new ApiError('VALIDATION_ERROR', 'groupId مطلوب.');
  const access = await requireMembership(ctx, groupId);
  const group = access.group;
  const year = years.find((item) => item.id === group.academic_year_id) ?? years[0];
  if (!year) throw new ApiError('INTERNAL_ERROR');

  const months: Array<{ month: string; lessons: number; homeworks: number; exams: number; events: number }> = [];
  const startMonth = monthOf(year.start_date);
  const endMonth = monthOf(year.end_date);
  let cursor = startMonth;
  for (let guard = 0; guard < 14 && cursor <= endMonth; guard += 1) {
    const bounds = monthBounds(cursor);
    const digest = await getMonthDigest(db, { groupId, start: bounds.start, end: bounds.end, section: access.group.kind === 'SHARED' ? user.sectionCode : null });
    months.push({
      month: cursor,
      lessons: digest.reduce((total, row) => total + row.lessons, 0),
      homeworks: digest.reduce((total, row) => total + row.homeworks, 0),
      exams: digest.reduce((total, row) => total + row.exams, 0),
      events: digest.reduce((total, row) => total + row.events, 0),
    });
    cursor = addMonths(cursor, 1);
  }

  return {
    academicYear: { id: year.id, title: year.title, startDate: year.start_date, endDate: year.end_date, status: year.status },
    months,
    subjects: (await listSubjects(db, user.gradeId)).map(subjectDto),
  };
}

/** The timetable for one week, as the client shows it (§27). */
export async function weekSchedule(ctx: Ctx, groupId: string, fromDate: string) {
  const db = ctx.env.TANWEER_DB;
  const version = await findVersionForDate(db, groupId, fromDate);
  if (!version) return { version: null, days: [] };
  const slots = await listSlots(db, version.id);
  const days = [0, 1, 2, 3, 4].map((weekday) => ({
    weekday,
    weekdayName: WEEKDAYS[weekday] ?? '',
    slots: slots.filter((slot) => slot.weekday === weekday).map(slotDto),
  }));
  return { version: { id: version.id, title: version.title, effectiveFrom: version.effective_from, effectiveTo: version.effective_to, status: version.status }, days };
}

export function slotDto(slot: SlotWithSubject) {
  return {
    id: slot.id,
    weekday: slot.weekday,
    period: slot.period,
    subject: { id: slot.subject_id, name: slot.subject_name, shortName: slot.subject_short, emoji: slot.subject_emoji, color: slot.subject_color },
    room: slot.room,
    notes: slot.notes,
  };
}

export async function scheduleVersionsFor(ctx: Ctx, groupId: string) {
  const rows = await listVersions(ctx.env.TANWEER_DB, groupId);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    notes: row.notes,
  }));
}

export { upcomingExams };

export type { ContentRow };
