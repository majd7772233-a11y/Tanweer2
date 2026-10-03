/**
 * All study dates are plain 'YYYY-MM-DD' strings in the school timezone
 * (Asia/Aden, UTC+3, no daylight saving). Keeping them as strings makes the
 * database, the API and the client agree on exactly one meaning: "the school
 * day", not "an instant somewhere in the world".
 *
 * weekday: 0 = الأحد … 6 = السبت  (identical to Date.getUTCDay)
 * school week: الأحد → الخميس, weekend: الجمعة + السبت
 */

export const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
export const SCHOOL_DAYS = [0, 1, 2, 3, 4] as const;
export const WEEKEND_DAYS = [5, 6] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isIsoMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value);
}

export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

export function todayIso(timeZone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** Current local time in the school timezone as 'HH:MM'. */
export function localClock(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

export function localMinutes(timeZone: string, now: Date = new Date()): number {
  const [hours, minutes] = localClock(timeZone, now).split(':').map((part) => Number.parseInt(part, 10));
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function toUtcDate(date: string): Date {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const base = toUtcDate(date);
  base.setUTCDate(base.getUTCDate() + days);
  return fromUtcDate(base);
}

export function weekdayOf(date: string): number {
  return toUtcDate(date).getUTCDay();
}

export function weekdayName(date: string): string {
  return WEEKDAYS[weekdayOf(date)] ?? '';
}

export function isWeekend(date: string): boolean {
  const day = weekdayOf(date);
  return day === 5 || day === 6;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000);
}

/**
 * The next school day that actually has school: skips Friday, Saturday and any
 * registered holiday (§11 "غدًا" must read the timetable, not just add a day).
 */
export function nextSchoolDay(from: string, holidays: ReadonlySet<string>, maxLookahead = 45): string {
  let cursor = from;
  for (let step = 0; step < maxLookahead; step += 1) {
    cursor = addDays(cursor, 1);
    if (isWeekend(cursor)) continue;
    if (holidays.has(cursor)) continue;
    return cursor;
  }
  return cursor;
}

export function previousSchoolDay(from: string, holidays: ReadonlySet<string>, maxLookahead = 45): string {
  let cursor = from;
  for (let step = 0; step < maxLookahead; step += 1) {
    cursor = addDays(cursor, -1);
    if (isWeekend(cursor)) continue;
    if (holidays.has(cursor)) continue;
    return cursor;
  }
  return cursor;
}

export function monthBounds(month: string): { start: string; end: string; days: number } {
  const [y, m] = month.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
  const start = `${month}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(days).padStart(2, '0')}`, days };
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
  const base = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function academicYearOf(date: string, startMonth = 8): string {
  const [y, m] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
  const startYear = m >= startMonth ? y : y - 1;
  return `${startYear}-${startYear + 1}`;
}

/** ISO instant for 'YYYY-MM-DD' + 'HH:MM' in a fixed-offset timezone. */
export function schoolDateTimeToIso(date: string, time: string, offsetMinutes = 180): string {
  const [y, m, d] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const [hh, mm] = time.split(':').map((part) => Number.parseInt(part, 10)) as [number, number];
  const utc = Date.UTC(y, m - 1, d, hh, mm) - offsetMinutes * 60_000;
  return new Date(utc).toISOString();
}

export function isFuture(date: string, today: string): boolean {
  return daysBetween(today, date) > 0;
}

export function isPast(date: string, today: string): boolean {
  return daysBetween(today, date) < 0;
}

export function formatArabicDayTitle(date: string): string {
  return `${weekdayName(date)} ${toUtcDate(date).getUTCDate()}`;
}
