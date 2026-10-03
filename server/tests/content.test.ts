import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  cleanMutableData,
  expectError,
  expectOk,
  registerAccount,
  resetRateLimits,
  uploadFile,
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

interface ContentDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  studyDate: string;
  period: number | null;
  status: string;
  revision: number;
  mediaCount: number;
  contributionCount: number;
  canonicalId: string | null;
  subject: { id: number; name: string } | null;
  author: { id: string; fullName: string };
  media?: Array<{ id: string; fileId: string; pageIndex: number; role: string }>;
}

interface DetailDto {
  content: ContentDto;
  comments: Array<{ id: string; body: string }>;
  contributions: Array<{ id: string; kind: string }>;
  relations: Array<{ id: string; toId: string; kind: string }>;
  history: Array<{ revision: number; action: string }>;
}

async function postLesson(account: TestAccount, overrides: Record<string, unknown> = {}) {
  const image = await uploadFile(account);
  const result = await expectOk<{ merged: boolean; content: ContentDto; similar: ContentDto[] }>('POST', '/api/v1/content', {
    token: account.accessToken,
    body: {
      groupId: account.classGroupId,
      type: 'LESSON',
      title: 'درس الرياضيات — المتتابعات',
      subjectId: 5,
      studyDate: isoDay(1),
      period: 2,
      files: [{ fileId: image.fileId, role: 'REFERENCE' }],
      ...overrides,
    },
  });
  return { ...result, image };
}

describe('content', () => {
  it('stores a multi page lesson and serves its pages in order', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'D' });
    const page1 = await uploadFile(student, { bytes: new TextEncoder().encode('page-one') });
    const page2 = await uploadFile(student, { bytes: new TextEncoder().encode('page-two') });
    const page3 = await uploadFile(student, { bytes: new TextEncoder().encode('page-three') });

    const created = await expectOk<{ merged: boolean; content: ContentDto }>('POST', '/api/v1/content', {
      token: student.accessToken,
      body: {
        groupId: student.classGroupId,
        type: 'LESSON',
        title: 'درس الأحياء — الخلية',
        subjectId: 8,
        studyDate: isoDay(2),
        period: 3,
        files: [
          { fileId: page1.fileId, role: 'REFERENCE' },
          { fileId: page2.fileId },
          { fileId: page3.fileId },
        ],
      },
    });
    expect(created.merged).toBe(false);
    expect(created.content.mediaCount).toBe(3);

    const detail = await expectOk<DetailDto>('GET', `/api/v1/content/${created.content.id}`, { token: student.accessToken });
    expect(detail.content.media?.map((page) => page.fileId)).toEqual([page1.fileId, page2.fileId, page3.fileId]);
    expect(detail.content.media?.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
    expect(detail.content.media?.[0]?.role).toBe('REFERENCE');
    expect(detail.history.map((entry) => entry.action)).toContain('CREATED');

    // the bytes come back through the signed gateway from the uploader
    const download = await SELF.fetch(`https://tanweer.test/api/v1/files/${page2.fileId}/content`, {
      headers: { authorization: `Bearer ${student.accessToken}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('page-two');
  });

  it('rejects a lesson dated in the future and a file that belongs to somebody else', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'D' });
    const other = await registerAccount({ gradeId: 10, sectionCode: 'D' });
    const foreignImage = await uploadFile(other);

    const future = await expectError('POST', '/api/v1/content', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, type: 'LESSON', title: 'درس لم يأتِ بعد', studyDate: '2099-01-01', files: [] },
    });
    expect(future.code).toBe('VALIDATION_ERROR');

    const stolen = await expectError('POST', '/api/v1/content', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, type: 'PHOTO', title: 'صورة ليست لي', studyDate: isoDay(1), files: [{ fileId: foreignImage.fileId }] },
    });
    expect(stolen.code).toBe('FORBIDDEN');

    const outsider = await registerAccount({ gradeId: 12, sectionCode: 'C' });
    const wrongGroup = await expectError('POST', '/api/v1/content', {
      token: outsider.accessToken,
      body: { groupId: student.classGroupId, type: 'NOTE', title: 'ملاحظة', studyDate: isoDay(1), files: [] },
    });
    expect(wrongGroup.code).toBe('NOT_A_MEMBER');
  });

  it('turns the same photographed page into a contribution instead of a second card', async () => {
    const first = await registerAccount({ gradeId: 11, sectionCode: 'B' });
    const second = await registerAccount({ gradeId: 11, sectionCode: 'B' });

    const page = new TextEncoder().encode('the-very-same-page');
    const original = await uploadFile(first, { bytes: page });
    const lesson = await expectOk<{ merged: boolean; content: ContentDto }>('POST', '/api/v1/content', {
      token: first.accessToken,
      body: {
        groupId: first.classGroupId,
        type: 'LESSON',
        title: 'درس الكيمياء — التفاعلات',
        subjectId: 7,
        studyDate: isoDay(1),
        files: [{ fileId: original.fileId, role: 'REFERENCE' }],
      },
    });
    expect(lesson.merged).toBe(false);

    // the classmate photographs the same page and uploads the identical bytes
    const copy = await uploadFile(second, { bytes: page });
    expect(copy.checksum).toBe(original.checksum);
    const duplicate = await expectOk<{ merged: boolean; content: ContentDto }>('POST', '/api/v1/content', {
      token: second.accessToken,
      body: {
        groupId: second.classGroupId,
        type: 'PHOTO',
        title: 'صورة الصفحة نفسها',
        subjectId: 7,
        studyDate: isoDay(1),
        files: [{ fileId: copy.fileId }],
      },
    });

    // same fingerprint, same group, same day → one card, two contributions
    expect(duplicate.merged).toBe(true);
    expect(duplicate.content.id).toBe(lesson.content.id);
    const detail = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: second.accessToken });
    expect(detail.content.mediaCount).toBe(2);
    expect(detail.contributions.length).toBe(2);

    // a genuinely different page is still its own card
    const other = await uploadFile(second, { bytes: new TextEncoder().encode('another-page') });
    const separate = await expectOk<{ merged: boolean }>('POST', '/api/v1/content', {
      token: second.accessToken,
      body: {
        groupId: second.classGroupId,
        type: 'PHOTO',
        title: 'صفحة مختلفة',
        subjectId: 7,
        studyDate: isoDay(1),
        files: [{ fileId: other.fileId }],
      },
    });
    expect(separate.merged).toBe(false);

    const dayList = await expectOk<ContentDto[]>('GET', `/api/v1/content?groupId=${second.classGroupId}&date=${isoDay(1)}`, {
      token: second.accessToken,
    });
    expect(dayList).toHaveLength(2);
  });

  it('files a lesson on a past date without rewriting its creation time', async () => {
    const student = await registerAccount({ gradeId: 12, sectionCode: 'B' });
    const old = isoDay(9);
    const lesson = await expectOk<{ content: ContentDto }>('POST', '/api/v1/content', {
      token: student.accessToken,
      body: { groupId: student.classGroupId, type: 'LESSON', title: 'درس قديم نُسي', subjectId: 10, studyDate: old, body: 'وثّقناه متأخرين' },
    });
    expect(lesson.content.studyDate).toBe(old);
    expect(lesson.content.id.startsWith('cnt_')).toBe(true);
  });

  it('lets the author edit, a classmate request a correction, and the group approve it', async () => {
    const author = await registerAccount({ gradeId: 9, sectionCode: 'A' });
    const classmate = await registerAccount({ gradeId: 9, sectionCode: 'A' });

    const lesson = await postLesson(author, { title: 'درس الفيزياء — الحركة', subjectId: 5 });

    const edited = await expectOk<{ content: ContentDto }>('PATCH', `/api/v1/content/${lesson.content.id}`, {
      token: author.accessToken,
      body: { body: 'أضفت ملاحظة', reason: 'توضيح' },
    });
    expect(edited.content.revision).toBeGreaterThan(lesson.content.revision);

    const forbidden = await expectError('PATCH', `/api/v1/content/${lesson.content.id}`, {
      token: classmate.accessToken,
      body: { title: 'عنوان من شخص آخر' },
    });
    expect(forbidden.code).toBe('FORBIDDEN');

    const correction = await expectOk<{ requestId: string }>('POST', `/api/v1/content/${lesson.content.id}/corrections`, {
      token: classmate.accessToken,
      body: { field: 'subject_id', proposedValue: '6', reason: 'المادة الصحيحة هي الفيزياء' },
    });

    const firstVote = await expectOk<{ decision: string }>('POST', '/api/v1/votes', {
      token: classmate.accessToken,
      body: { targetType: 'CORRECTION', targetId: correction.requestId, value: 'APPROVE' },
    });
    expect(firstVote.decision).toBe('PENDING');

    const secondVote = await expectOk<{ decision: string }>('POST', '/api/v1/votes', {
      token: author.accessToken,
      body: { targetType: 'CORRECTION', targetId: correction.requestId, value: 'APPROVE' },
    });
    expect(secondVote.decision).toBe('APPROVED');

    const after = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: author.accessToken });
    expect(after.content.subject?.id).toBe(6);
    expect(after.history.some((entry) => entry.action === 'CORRECTED_BY_COMMUNITY' && entry.revision === 9998)).toBe(true);
  });

  it('keeps content when one member refuses, and deletes it when everyone agrees', async () => {
    const one = await registerAccount({ gradeId: 8, sectionCode: 'B' });
    const two = await registerAccount({ gradeId: 8, sectionCode: 'B' });
    const lesson = await postLesson(one, { title: 'درس قابل للنقاش' });

    const request = await expectOk<{ requestId: string }>('POST', `/api/v1/content/${lesson.content.id}/deletion-requests`, {
      token: two.accessToken,
      body: { reason: 'المحتوى غير دقيق' },
    });

    const pending = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: one.accessToken });
    expect(pending.content.status).toBe('PENDING_DELETION');

    const refused = await expectOk<{ decision: string }>('POST', '/api/v1/votes', {
      token: one.accessToken,
      body: { targetType: 'DELETION', targetId: request.requestId, value: 'REJECT' },
    });
    expect(refused.decision).toBe('REJECTED');

    const kept = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: one.accessToken });
    expect(kept.content.status).toBe('PUBLISHED');

    const second = await expectOk<{ requestId: string }>('POST', `/api/v1/content/${lesson.content.id}/deletion-requests`, {
      token: two.accessToken,
      body: { reason: 'مكرر' },
    });
    await expectOk('POST', '/api/v1/votes', { token: one.accessToken, body: { targetType: 'DELETION', targetId: second.requestId, value: 'APPROVE' } });
    const approved = await expectOk<{ decision: string }>('POST', '/api/v1/votes', {
      token: two.accessToken,
      body: { targetType: 'DELETION', targetId: second.requestId, value: 'APPROVE' },
    });
    expect(approved.decision).toBe('APPROVED');

    const deleted = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: two.accessToken });
    expect(deleted.content.status).toBe('DELETED');
    expect(deleted.history.some((entry) => entry.action === 'DELETED_BY_COMMUNITY' && entry.revision === 9999)).toBe(true);
  });

  it('takes a comment, a useful mark and a bookmark', async () => {
    const student = await registerAccount({ gradeId: 12, sectionCode: 'A' });
    const lesson = await postLesson(student);

    await expectOk('POST', `/api/v1/content/${lesson.content.id}/comments`, {
      token: student.accessToken,
      body: { body: 'شكرًا، الشرح واضح' },
    });
    const detail = await expectOk<DetailDto>('GET', `/api/v1/content/${lesson.content.id}`, { token: student.accessToken });
    expect(detail.comments.map((comment) => comment.body)).toContain('شكرًا، الشرح واضح');

    const useful = await expectOk<{ active: boolean }>('POST', `/api/v1/content/${lesson.content.id}/useful`, { token: student.accessToken, body: {} });
    expect(useful.active).toBe(true);
    const toggledOff = await expectOk<{ active: boolean }>('POST', `/api/v1/content/${lesson.content.id}/useful`, { token: student.accessToken, body: {} });
    expect(toggledOff.active).toBe(false);

    const saved = await expectOk<{ active: boolean }>('POST', `/api/v1/content/${lesson.content.id}/save`, { token: student.accessToken, body: {} });
    expect(saved.active).toBe(true);
    const bookmarks = await expectOk<Array<{ entityId: string }>>('GET', '/api/v1/bookmarks', { token: student.accessToken });
    expect(bookmarks.map((bookmark) => bookmark.entityId)).toContain(lesson.content.id);
  });

  it('keeps a group private to its own members', async () => {
    const student = await registerAccount({ gradeId: 7, sectionCode: 'A' });
    const outsider = await registerAccount({ gradeId: 12, sectionCode: 'C' });
    const lesson = await postLesson(student);

    const blocked = await expectError('GET', `/api/v1/content/${lesson.content.id}`, { token: outsider.accessToken });
    expect(blocked.code).toBe('NOT_A_MEMBER');

    const anonymous = await api('GET', `/api/v1/content/${lesson.content.id}`);
    expect(anonymous.status).toBe(401);
  });

  it('lists a day with its documentation percentage and filters', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'A' });
    const today = isoDay(0);
    const lesson = await postLesson(student, { title: 'درس اليوم', subjectId: 3, period: 1, studyDate: today });

    const day = await expectOk<{
      date: string;
      progress: number;
      documentedCount: number;
      cards: unknown[];
      content: ContentDto[];
    }>('GET', `/api/v1/day/${today}`, { token: student.accessToken });
    expect(day.date).toBe(today);
    expect(day.content.map((item) => item.id)).toContain(lesson.content.id);
    expect(day.documentedCount).toBeGreaterThanOrEqual(1);
    expect(day.progress).toBeGreaterThan(0);

    const list = await expectOk<ContentDto[]>('GET', `/api/v1/content?groupId=${student.classGroupId}&subjectId=3`, { token: student.accessToken });
    expect(list.map((item) => item.id)).toContain(lesson.content.id);

    const filtered = await expectOk<ContentDto[]>(
      'GET',
      `/api/v1/content?groupId=${student.classGroupId}&date=${isoDay(5)}`,
      { token: student.accessToken },
    );
    expect(filtered).toHaveLength(0);
  });
});
