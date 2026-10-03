import { beforeEach, describe, expect, it } from 'vitest';
import { api, cleanMutableData, expectError, expectOk, registerAccount, resetRateLimits, type TestAccount } from './helpers';

beforeEach(async () => {
  await cleanMutableData();
  await resetRateLimits();
});

interface ScheduleResponse {
  date: string;
  version: { id: string; title: string; effectiveFrom: string } | null;
  weekday: number;
  day: { weekday: number; slots: Array<{ id: string; weekday: number; period: number; subject: { id: number; name: string } }> };
  week: { version: unknown; days: Array<{ weekday: number; slots: Array<{ id: string; period: number; subject: { id: number; name: string } }> }> };
  canEdit: boolean;
}

async function fill(account: TestAccount, weekday: number, period: number, subjectId: number) {
  return expectOk<ScheduleResponse>('POST', '/api/v1/schedule/slots', {
    token: account.accessToken,
    body: { groupId: account.classGroupId, weekday, period, subjectId },
  });
}

describe('schedule', () => {
  it('starts from an empty version so the students can fill it', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'A' });
    const schedule = await expectOk<ScheduleResponse>('GET', '/api/v1/schedule?date=2026-09-06', { token: student.accessToken });

    expect(schedule.version?.title).toBe('الجدول الحالي');
    expect(schedule.day.slots).toHaveLength(0);
    expect(schedule.canEdit).toBe(true);
  });

  it('fills an empty period and refuses to overwrite it silently', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'A' });

    const afterFill = await fill(student, 0, 1, 5);
    const sunday = afterFill.week?.days.find((day) => day.weekday === 0);
    expect(sunday?.slots).toHaveLength(1);
    expect(sunday?.slots[0]?.subject.id).toBe(5);

    const duplicate = await expectError('POST', '/api/v1/schedule/slots', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, weekday: 0, period: 1, subjectId: 3 },
    });
    expect(duplicate.code).toBe('SLOT_ALREADY_FILLED');
  });

  it('shows the filled period on the day screen', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'A' });

    // The server decides which day is the next school day (Friday and Saturday
    // are the weekend here), so the test follows the API instead of guessing.
    const upcoming = await expectOk<{ date: string; weekday: number }>('GET', '/api/v1/tomorrow', { token: student.accessToken });
    await fill(student, upcoming.weekday, 2, 6);

    const day = await expectOk<{ cards: Array<{ period: number; subject: { id: number } | null; status: string }> }>(
      'GET',
      `/api/v1/day/${upcoming.date}`,
      { token: student.accessToken },
    );
    const card = day.cards.find((item) => item.period === 2);
    expect(card?.subject?.id).toBe(6);
    expect(card?.status).toBe('UPCOMING');
  });

  it('never applies a timetable change by itself, and applies it when the group agrees', async () => {
    const students: TestAccount[] = [];
    for (let index = 0; index < 5; index += 1) {
      students.push(await registerAccount({ gradeId: 10, sectionCode: 'B', fullName: `طالب رقم ${index} الاختبار` }));
    }
    const [proposer, ...others] = students as [TestAccount, ...TestAccount[]];

    await fill(proposer, 2, 3, 5);

    const proposal = await expectOk<{ id: string; status: string; eligibleCount: number; approveCount: number }>('POST', '/api/v1/schedule/proposals', {
      token: proposer.accessToken,
      body: { groupId: proposer.classGroupId, weekday: 2, period: 3, proposedSubjectId: 6, kind: 'CHANGE', reason: 'المعلم تغيّر هذا اليوم' },
    });
    expect(proposal.status).toBe('PENDING');
    expect(proposal.eligibleCount).toBe(5);

    const duplicate = await expectError('POST', '/api/v1/schedule/proposals', {
      token: proposer.accessToken,
      body: { groupId: proposer.classGroupId, weekday: 2, period: 3, proposedSubjectId: 7, kind: 'CHANGE', reason: 'اقتراح مكرر' },
    });
    expect(duplicate.code).toBe('DUPLICATE_REQUEST');

    // one vote out of five is not a decision
    const first = await expectOk<{ decision: string; counts: { approve: number; eligible: number } }>('POST', '/api/v1/votes', {
      token: others[0]?.accessToken ?? '',
      body: { targetType: 'SCHEDULE_PROPOSAL', targetId: proposal.id, value: 'APPROVE' },
    });
    expect(first.decision).toBe('PENDING');

    const stillOld = await expectOk<ScheduleResponse>('GET', '/api/v1/schedule?date=2026-09-08', { token: proposer.accessToken });
    expect(stillOld.day.slots.find((slot) => slot.period === 3)?.subject.id).toBe(5);

    const second = await expectOk<{ decision: string }>('POST', '/api/v1/votes', {
      token: others[1]?.accessToken ?? '',
      body: { targetType: 'SCHEDULE_PROPOSAL', targetId: proposal.id, value: 'APPROVE' },
    });
    expect(second.decision).toBe('APPROVED');

    const changed = await expectOk<ScheduleResponse>('GET', '/api/v1/schedule?date=2026-09-08', { token: proposer.accessToken });
    expect(changed.day.slots.find((slot) => slot.period === 3)?.subject.id).toBe(6);
  });

  it('lets the owner withdraw a proposal and refuses an outsider vote', async () => {
    const student = await registerAccount({ gradeId: 11, sectionCode: 'A' });
    const outsider = await registerAccount({ gradeId: 11, sectionCode: 'B' });
    await fill(student, 3, 1, 4);

    const proposal = await expectOk<{ id: string }>('POST', '/api/v1/schedule/proposals', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, weekday: 3, period: 1, proposedSubjectId: 3, kind: 'CHANGE', reason: 'تبديل المادة' },
    });

    const outsiderVote = await expectError('POST', '/api/v1/votes', {
      token: outsider.accessToken,
      body: { targetType: 'SCHEDULE_PROPOSAL', targetId: proposal.id, value: 'APPROVE' },
    });
    expect(outsiderVote.code).toBe('NOT_A_MEMBER');

    const withdrawn = await expectOk<{ withdrawn: boolean }>('POST', `/api/v1/schedule/proposals/${proposal.id}/withdraw`, {
      token: student.accessToken,
      body: {},
    });
    expect(withdrawn.withdrawn).toBe(true);

    const after = await expectOk<{ proposal: { status: string } }>('GET', `/api/v1/schedule/proposals/${proposal.id}`, { token: student.accessToken });
    expect(after.proposal.status).toBe('WITHDRAWN');
  });

  it('records a new version instead of rewriting the old days', async () => {
    const student = await registerAccount({ gradeId: 12, sectionCode: 'C' });
    await fill(student, 0, 4, 8);

    const versions = await expectOk<Array<{ id: string; status: string; title: string }>>(
      'GET',
      `/api/v1/schedule/versions?groupId=${student.classGroupId}`,
      { token: student.accessToken },
    );
    expect(versions.some((version) => version.status === 'ACTIVE')).toBe(true);
    const current = versions.find((version) => version.status === 'ACTIVE');
    expect(current).toBeTruthy();

    await expectOk('PATCH', `/api/v1/groups/${student.classGroupId}/members/${student.userId}`, {
      token: student.accessToken,
      body: { notifications: 'ALL' },
    });

    // only a moderator may open a version, and a plain member is refused
    const refused = await expectError('POST', '/api/v1/schedule/versions', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, title: 'جدول الفصل الثاني', effectiveFrom: '2027-01-10' },
    });
    expect(refused.code).toBe('NOT_A_MODERATOR');
  });

  it('rejects a vote target that does not exist', async () => {
    const student = await registerAccount({ gradeId: 8, sectionCode: 'A' });
    const missing = await expectError('POST', '/api/v1/votes', {
      token: student.accessToken,
      body: { targetType: 'DELETION', targetId: 'dlr_missing', value: 'APPROVE' },
    });
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('keeps anonymous timetable reads closed', async () => {
    const anonymous = await api('GET', '/api/v1/schedule?groupId=grp_class_10-A');
    expect(anonymous.status).toBe(401);
  });
});
