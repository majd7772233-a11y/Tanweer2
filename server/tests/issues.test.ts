import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  cleanMutableData,
  expectError,
  expectOk,
  registerAccount,
  resetRateLimits,
  type TestAccount,
} from './helpers';

beforeEach(async () => {
  await cleanMutableData();
  await resetRateLimits();
});

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Aden',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function isoDay(daysBack = 0): string {
  return dateFormatter.format(new Date(Date.now() - daysBack * 86_400_000));
}

interface IssueDto {
  id: string;
  groupId: string;
  title: string;
  body: string | null;
  status: string;
  subject: { id: number; name: string } | null;
  studyDate: string;
  homeworkId: string | null;
  homeworkTitle: string | null;
  examId: string | null;
  contentId: string | null;
  contentTitle: string | null;
  bestCommentId: string | null;
  commentCount: number;
  mine?: boolean;
}

interface IssueDetail {
  issue: IssueDto;
  comments: Array<{ id: string; body: string; isBest: boolean; author: { id: string; fullName: string } }>;
}

async function ask(account: TestAccount, body: Record<string, unknown> = {}) {
  return expectOk<IssueDto>('POST', '/api/v1/issues', {
    token: account.accessToken,
    body: { groupId: account.classGroupId, title: 'كيف أحسب المشتقة؟', ...body },
  });
}

async function postHomework(account: TestAccount, overrides: Record<string, unknown> = {}) {
  return expectOk<{ id: string; subject: { id: number } | null }>('POST', '/api/v1/homeworks', {
    token: account.accessToken,
    body: { groupId: account.classGroupId, title: 'واجب الرياضيات', subjectId: 5, studyDate: isoDay(0), ...overrides },
  });
}

describe('issues', () => {
  it('links a question to its homework and inherits the subject', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'B' });
    const homework = await postHomework(student);

    const issue = await ask(student, { title: 'ما المطلوب في السؤال الثالث؟', homeworkId: homework.id });
    expect(issue.homeworkId).toBe(homework.id);
    expect(issue.homeworkTitle).toBe('واجب الرياضيات');
    expect(issue.subject?.id).toBe(5);
    expect(issue.status).toBe('OPEN');
    expect(issue.mine).toBe(true);

    const listed = await expectOk<IssueDto[]>('GET', `/api/v1/issues?groupId=${student.classGroupId}&homeworkId=${homework.id}`, {
      token: student.accessToken,
    });
    expect(listed.map((item) => item.id)).toContain(issue.id);

    // a question posted from a not-yet-existing homework is still linked, without a subject
    const exam = await expectOk<{ id: string }>('POST', '/api/v1/exams', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, title: 'اختبار الفيزياء', subjectId: 6, examDate: isoDay(-5) },
    });
    const examIssue = await ask(student, { title: 'هل الاختبار شامل؟', examId: exam.id });
    expect(examIssue.examId).toBe(exam.id);
    expect(examIssue.subject?.id).toBe(6);
  });

  it('asks from a lesson and shows the question under that lesson', async () => {
    const student = await registerAccount({ gradeId: 9, sectionCode: 'B' });
    const created = await expectOk<{ content: { id: string } }>('POST', '/api/v1/content', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, type: 'LESSON', title: 'درس الرياضيات', subjectId: 5, studyDate: isoDay(1) },
    });
    const lessonId = created.content.id;

    const issue = await expectOk<IssueDto>('POST', `/api/v1/content/${lessonId}/questions`, {
      token: student.accessToken,
      body: { title: 'لم أفهم الخطوة الأخيرة' },
    });
    expect(issue.contentId).toBe(lessonId);
    expect(issue.contentTitle).toBe('درس الرياضيات');

    const filtered = await expectOk<IssueDto[]>('GET', `/api/v1/issues?groupId=${student.classGroupId}&contentId=${lessonId}`, {
      token: student.accessToken,
    });
    expect(filtered.map((item) => item.id)).toContain(issue.id);

    const outsider = await registerAccount({ gradeId: 12, sectionCode: 'A' });
    const blocked = await expectError('POST', `/api/v1/content/${lessonId}/questions`, {
      token: outsider.accessToken,
      body: { title: 'سؤال من خارج المجموعة' },
    });
    expect(blocked.code).toBe('NOT_A_MEMBER');
  });

  it('moves to discussion on the first answer, and only the asker can mark it solved', async () => {
    const asker = await registerAccount({ gradeId: 11, sectionCode: 'A' });
    const classmate = await registerAccount({ gradeId: 11, sectionCode: 'A' });
    const issue = await ask(asker, { subjectId: 5 });

    const comment = await expectOk<{ id: string }>('POST', `/api/v1/issues/${issue.id}/comments`, {
      token: classmate.accessToken,
      body: { body: 'استخدم قاعدة السلسلة' },
    });
    expect(comment.id.startsWith('icmt_')).toBe(true);

    const afterAnswer = await expectOk<IssueDetail>('GET', `/api/v1/issues/${issue.id}`, { token: asker.accessToken });
    expect(afterAnswer.issue.status).toBe('IN_DISCUSSION');
    expect(afterAnswer.issue.commentCount).toBe(1);
    expect(afterAnswer.comments.map((item) => item.body)).toEqual(['استخدم قاعدة السلسلة']);

    const stranger = await expectError('PATCH', `/api/v1/issues/${issue.id}/status`, {
      token: classmate.accessToken,
      body: { status: 'SOLVED' },
    });
    expect(stranger.code).toBe('FORBIDDEN');

    const solved = await expectOk<IssueDto>('PATCH', `/api/v1/issues/${issue.id}/status`, {
      token: asker.accessToken,
      body: { status: 'SOLVED' },
    });
    expect(solved.status).toBe('SOLVED');
  });

  it('refuses new answers on a closed question', async () => {
    const asker = await registerAccount({ gradeId: 12, sectionCode: 'C' });
    const classmate = await registerAccount({ gradeId: 12, sectionCode: 'C' });
    const issue = await ask(asker);

    await expectOk<IssueDto>('PATCH', `/api/v1/issues/${issue.id}/status`, {
      token: asker.accessToken,
      body: { status: 'CLOSED' },
    });

    const late = await expectError('POST', `/api/v1/issues/${issue.id}/comments`, {
      token: classmate.accessToken,
      body: { body: 'رد متأخر' },
    });
    expect(late.code).toBe('FORBIDDEN');
  });

  it('marks the best answer and clears it when tapped again', async () => {
    const asker = await registerAccount({ gradeId: 10, sectionCode: 'A' });
    const first = await registerAccount({ gradeId: 10, sectionCode: 'A' });
    const second = await registerAccount({ gradeId: 10, sectionCode: 'A' });
    const issue = await ask(asker);

    const weak = await expectOk<{ id: string }>('POST', `/api/v1/issues/${issue.id}/comments`, { token: first.accessToken, body: { body: 'جرب الحاسبة' } });
    const good = await expectOk<{ id: string }>('POST', `/api/v1/issues/${issue.id}/comments`, { token: second.accessToken, body: { body: 'هذه هي القاعدة كاملة' } });

    const marked = await expectOk<IssueDto>('POST', `/api/v1/issues/${issue.id}/best-answer`, {
      token: asker.accessToken,
      body: { commentId: good.id },
    });
    expect(marked.bestCommentId).toBe(good.id);

    const detail = await expectOk<IssueDetail>('GET', `/api/v1/issues/${issue.id}`, { token: asker.accessToken });
    expect(detail.comments.find((item) => item.id === good.id)?.isBest).toBe(true);
    expect(detail.comments.find((item) => item.id === weak.id)?.isBest).toBe(false);

    const cleared = await expectOk<IssueDto>('POST', `/api/v1/issues/${issue.id}/best-answer`, {
      token: asker.accessToken,
      body: { commentId: good.id },
    });
    expect(cleared.bestCommentId).toBeNull();
  });

  it('hides a comment for its writer only', async () => {
    const asker = await registerAccount({ gradeId: 9, sectionCode: 'B' });
    const writer = await registerAccount({ gradeId: 9, sectionCode: 'B' });
    const issue = await ask(asker);

    const comment = await expectOk<{ id: string }>('POST', `/api/v1/issues/${issue.id}/comments`, { token: writer.accessToken, body: { body: 'رد فيه خطأ' } });

    const forbidden = await expectError('POST', `/api/v1/issues/${issue.id}/comments/${comment.id}/hide`, { token: asker.accessToken });
    expect(forbidden.code).toBe('FORBIDDEN');

    const hidden = await expectOk<{ hidden: boolean }>('POST', `/api/v1/issues/${issue.id}/comments/${comment.id}/hide`, { token: writer.accessToken });
    expect(hidden.hidden).toBe(true);

    const detail = await expectOk<IssueDetail>('GET', `/api/v1/issues/${issue.id}`, { token: asker.accessToken });
    expect(detail.comments.map((item) => item.id)).not.toContain(comment.id);
  });

  it('filters by status, subject and text', async () => {
    const student = await registerAccount({ gradeId: 8, sectionCode: 'A' });
    const math = await ask(student, { title: 'سؤال في الرياضيات', subjectId: 5 });
    const physics = await ask(student, { title: 'سؤال في الفيزياء', subjectId: 6 });
    await expectOk<IssueDto>('PATCH', `/api/v1/issues/${physics.id}/status`, { token: student.accessToken, body: { status: 'SOLVED' } });

    const open = await expectOk<IssueDto[]>('GET', `/api/v1/issues?groupId=${student.classGroupId}&status=OPEN`, { token: student.accessToken });
    expect(open.map((item) => item.id)).toContain(math.id);
    expect(open.map((item) => item.id)).not.toContain(physics.id);

    const mathOnly = await expectOk<IssueDto[]>('GET', `/api/v1/issues?groupId=${student.classGroupId}&subjectId=5`, { token: student.accessToken });
    expect(mathOnly.map((item) => item.id)).toEqual([math.id]);

    const searched = await expectOk<IssueDto[]>('GET', `/api/v1/issues?groupId=${student.classGroupId}&q=الفيزياء`, { token: student.accessToken });
    expect(searched.map((item) => item.id)).toContain(physics.id);
  });

  it('keeps the questions inside their group', async () => {
    const student = await registerAccount({ gradeId: 7, sectionCode: 'A' });
    const outsider = await registerAccount({ gradeId: 11, sectionCode: 'A' });
    const issue = await ask(student);

    const blocked = await expectError('GET', `/api/v1/issues/${issue.id}`, { token: outsider.accessToken });
    expect(blocked.code).toBe('NOT_A_MEMBER');

    const anonymous = await api('GET', `/api/v1/issues/${issue.id}`);
    expect(anonymous.status).toBe(401);

    const missing = await expectError('GET', `/api/v1/issues/iss_does_not_exist`, { token: student.accessToken });
    expect(missing.code).toBe('ISSUE_NOT_FOUND');

    const noGroup = await expectError('GET', '/api/v1/issues', { token: student.accessToken });
    expect(noGroup.code).toBe('VALIDATION_ERROR');
  });
});
