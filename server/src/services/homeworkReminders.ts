/**
 * Reminder planning (§23, §78).
 *
 * The device schedules its own local notifications after each sync: the Worker
 * never runs a cron job per student per homework. The server only says *what*
 * to remind about, and the app decides *when* to show it.
 */
import * as V from '../lib/validation';

export const homeworkDueSchema = V.object({
  weeksAhead: V.withDefault(V.number({ min: 1, max: 8 }), 2),
});

export interface ReminderPlan {
  homeworkId: string;
  title: string;
  subject: string | null;
  dueDate: string;
  dueTime: string | null;
  daysBefore: number[];
  deepLink: string;
}

export function buildReminderPlan(
  homeworks: Array<{ id: string; title: string; subject_name?: string | null; due_date: string | null; study_date: string; due_time: string | null }>,
): ReminderPlan[] {
  return homeworks
    .filter((homework) => homework.due_date !== null)
    .map((homework) => ({
      homeworkId: homework.id,
      title: homework.title,
      subject: homework.subject_name ?? null,
      dueDate: homework.due_date as string,
      dueTime: homework.due_time,
      /** 2 days before, 1 day before and the morning of the due date. */
      daysBefore: [2, 1, 0],
      deepLink: `tanweer://homework/${homework.id}`,
    }));
}
