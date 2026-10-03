import { beforeEach, describe, expect, it } from 'vitest';
import { api, cleanMutableData, expectError, expectOk, registerAccount, resetRateLimits, type TestAccount } from './helpers';

beforeEach(async () => {
  await cleanMutableData();
  await resetRateLimits();
});

interface GroupDto {
  id: string;
  kind: string;
  name: string;
  role?: string;
  memberCount?: number;
  sections?: Array<{ gradeId: number; code: string; label: string }>;
  membership?: { role: string; status: string } | null;
}

describe('groups', () => {
  it('puts every new student in the class group of their section', async () => {
    const student = await registerAccount({ gradeId: 10, sectionCode: 'B' });
    expect(student.classGroupId).not.toBe('');

    const groups = await expectOk<GroupDto[]>('GET', '/api/v1/groups', { token: student.accessToken });
    const classGroup = groups.find((group) => group.id === student.classGroupId);
    expect(classGroup?.kind).toBe('CLASS');
    expect(classGroup?.membership?.status).toBe('ACTIVE');

    const members = await expectOk<Array<{ id: string; classId: string }>>('GET', `/api/v1/groups/${student.classGroupId}/members`, {
      token: student.accessToken,
    });
    expect(members.map((member) => member.id)).toContain(student.userId);
    expect(members[0]?.classId).toBe('10-B');
  });

  it('requires a token and membership to read a group', async () => {
    const student = await registerAccount();
    const anonymous = await api('GET', '/api/v1/groups');
    expect(anonymous.status).toBe(401);

    const outsider = await registerAccount({ gradeId: 11, sectionCode: 'C' });
    const forbidden = await expectError('GET', `/api/v1/groups/${student.classGroupId}/members`, { token: outsider.accessToken });
    expect(forbidden.code).toBe('NOT_A_MEMBER');
  });

  it('walks a club through request → approval', async () => {
    const owner = await registerAccount({ gradeId: 11, sectionCode: 'A', fullName: 'سالم عبدالله المقطري' });
    const applicant = await registerAccount({ gradeId: 11, sectionCode: 'A', fullName: 'هيثم ناصر الشرعبي' });

    const club = await expectOk<GroupDto>(
      'POST',
      '/api/v1/groups',
      {
        token: owner.accessToken,
        body: { kind: 'OPTIONAL', name: 'نادي الرياضيات', description: 'تمارين أسبوعية', visibility: 'DISCOVERABLE', joinPolicy: 'REQUEST', emoji: '📐' },
      },
    );
    expect(club.id).toMatch(/^grp_/);
    expect(club.membership?.role).toBe('OWNER');

    // the applicant can find it…
    const discover = await expectOk<GroupDto[]>('GET', '/api/v1/groups/discover', { token: applicant.accessToken });
    expect(discover.map((group) => group.id)).toContain(club.id);

    // …but cannot read its members before joining
    const before = await expectError('GET', `/api/v1/groups/${club.id}/members`, { token: applicant.accessToken });
    expect(before.code).toBe('NOT_A_MEMBER');

    const request = await expectOk<{ status: string; requestId: string }>('POST', `/api/v1/groups/${club.id}/join-request`, {
      token: applicant.accessToken,
      body: { message: 'أحب الرياضيات' },
    });
    expect(request.status).toBe('PENDING');

    const duplicate = await expectError('POST', `/api/v1/groups/${club.id}/join-request`, { token: applicant.accessToken, body: {} });
    expect(duplicate.code).toBe('JOIN_REQUEST_PENDING');

    // the applicant is not a moderator, so they cannot see the inbox
    const inboxDenied = await expectError('GET', `/api/v1/groups/${club.id}/join-requests`, { token: applicant.accessToken });
    expect(inboxDenied.code).toBe('NOT_A_MODERATOR');

    const inbox = await expectOk<Array<{ id: string; user: { id: string } }>>('GET', `/api/v1/groups/${club.id}/join-requests`, { token: owner.accessToken });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.user.id).toBe(applicant.userId);

    const decided = await expectOk<{ status: string }>('POST', `/api/v1/groups/${club.id}/join-requests/${request.requestId}/decide`, {
      token: owner.accessToken,
      body: { decision: 'APPROVE' },
    });
    expect(decided.status).toBe('APPROVED');

    const members = await expectOk<Array<{ id: string; role: string }>>('GET', `/api/v1/groups/${club.id}/members`, { token: applicant.accessToken });
    expect(members.map((member) => member.id).sort()).toEqual([owner.userId, applicant.userId].sort());

    // deciding twice is a conflict, not a second membership
    const again = await expectError('POST', `/api/v1/groups/${club.id}/join-requests/${request.requestId}/decide`, {
      token: owner.accessToken,
      body: { decision: 'APPROVE' },
    });
    expect(again.code).toBe('CONFLICT');
  });

  it('rejects a join request and keeps the applicant out', async () => {
    const owner = await registerAccount({ gradeId: 9, sectionCode: 'A' });
    const applicant = await registerAccount({ gradeId: 9, sectionCode: 'A' });

    const club = await expectOk<GroupDto>('POST', '/api/v1/groups', {
      token: owner.accessToken,
      body: { kind: 'OPTIONAL', name: 'نادي العلوم', joinPolicy: 'REQUEST' },
    });
    const request = await expectOk<{ requestId: string }>('POST', `/api/v1/groups/${club.id}/join-request`, { token: applicant.accessToken, body: {} });
    const decided = await expectOk<{ status: string }>('POST', `/api/v1/groups/${club.id}/join-requests/${request.requestId}/decide`, {
      token: owner.accessToken,
      body: { decision: 'REJECT', reason: 'لا' },
    });
    expect(decided.status).toBe('REJECTED');

    const blocked = await expectError('GET', `/api/v1/groups/${club.id}/members`, { token: applicant.accessToken });
    expect(blocked.code).toBe('NOT_A_MEMBER');
  });

  it('joins an open club directly and can leave it', async () => {
    const owner = await registerAccount({ gradeId: 12, sectionCode: 'A' });
    const student = await registerAccount({ gradeId: 12, sectionCode: 'A' });

    const club = await expectOk<GroupDto>('POST', '/api/v1/groups', {
      token: owner.accessToken,
      body: { kind: 'OPTIONAL', name: 'نادي القراءة', joinPolicy: 'AUTO' },
    });

    const joined = await expectOk<{ status: string }>('POST', `/api/v1/groups/${club.id}/join-request`, { token: student.accessToken, body: {} });
    expect(joined.status).toBe('APPROVED');

    const members = await expectOk<Array<{ id: string }>>('GET', `/api/v1/groups/${club.id}/members`, { token: student.accessToken });
    expect(members).toHaveLength(2);

    await expectOk('POST', `/api/v1/groups/${club.id}/leave`, { token: student.accessToken, body: {} });
    const after = await expectError('GET', `/api/v1/groups/${club.id}/members`, { token: student.accessToken });
    expect(after.code).toBe('NOT_A_MEMBER');
  });

  it('builds a shared group across sections and refuses one with a single section', async () => {
    const founder = await registerAccount({ gradeId: 11, sectionCode: 'D' });

    const invalid = await expectError('POST', '/api/v1/groups', {
      token: founder.accessToken,
      body: { kind: 'SHARED', name: 'شعبة واحدة فقط', sections: [['11', 'D']] },
    });
    expect(invalid.code).toBe('VALIDATION_ERROR');

    const shared = await expectOk<GroupDto>('POST', '/api/v1/groups', {
      token: founder.accessToken,
      body: { kind: 'SHARED', name: 'رياضيات ثاني ثانوي', subjectId: 5, joinPolicy: 'AUTO', sections: [['11', 'A'], ['11', 'B'], ['11', 'C']] },
    });
    expect(shared.sections?.map((section) => section.code).sort()).toEqual(['A', 'B', 'C']);

    const otherSection = await registerAccount({ gradeId: 11, sectionCode: 'B' });
    await expectOk('POST', `/api/v1/groups/${shared.id}/join-request`, { token: otherSection.accessToken, body: {} });
    const members = await expectOk<Array<{ id: string }>>('GET', `/api/v1/groups/${shared.id}/members`, { token: otherSection.accessToken });
    expect(members.map((member) => member.id)).toContain(otherSection.userId);

    const voters = await expectOk<{ eligible: number }>('GET', `/api/v1/groups/${shared.id}/voters`, { token: otherSection.accessToken });
    expect(voters.eligible).toBe(2);
  });

  it('never lets a student leave the class group', async () => {
    const student = await registerAccount({ gradeId: 8, sectionCode: 'B' });
    const result = await expectError('POST', `/api/v1/groups/${student.classGroupId}/leave`, { token: student.accessToken, body: {} });
    expect(result.code).toBe('FORBIDDEN');
  });

  it('lets a moderator promote a member but nobody promote themselves', async () => {
    const owner = await registerAccount({ gradeId: 10, sectionCode: 'C', fullName: 'أحمد صالح الحميري' });
    const member = await registerAccount({ gradeId: 10, sectionCode: 'C', fullName: 'خالد فهد العزاني' });

    const club = await expectOk<GroupDto>('POST', '/api/v1/groups', {
      token: owner.accessToken,
      body: { kind: 'OPTIONAL', name: 'نادي الكيمياء', joinPolicy: 'AUTO' },
    });
    await expectOk('POST', `/api/v1/groups/${club.id}/join-request`, { token: member.accessToken, body: {} });

    const selfPromotion = await expectError('PATCH', `/api/v1/groups/${club.id}/members/${member.userId}`, {
      token: member.accessToken,
      body: { role: 'MODERATOR' },
    });
    expect(selfPromotion.code).toBe('FORBIDDEN');

    await expectOk('PATCH', `/api/v1/groups/${club.id}/members/${member.userId}`, { token: owner.accessToken, body: { role: 'MODERATOR' } });

    // a promoted moderator can now read the inbox
    const inbox = await expectOk<unknown[]>('GET', `/api/v1/groups/${club.id}/join-requests`, { token: member.accessToken });
    expect(Array.isArray(inbox)).toBe(true);

    // and can silence their own notifications without touching their role
    await expectOk('PATCH', `/api/v1/groups/${club.id}/members/${member.userId}`, { token: member.accessToken, body: { notifications: 'MENTIONS' } });
  });

  it('resolves the class group by grade and section', async () => {
    const student = await registerAccount({ gradeId: 9, sectionCode: 'B' });
    const data = await expectOk<GroupDto>('GET', '/api/v1/class-group?gradeId=9&sectionCode=B', { token: student.accessToken });
    expect(data.id).toBe(student.classGroupId);

    const missing = await expectError('GET', '/api/v1/class-group?gradeId=7&sectionCode=D', { token: student.accessToken });
    expect(missing.code).toBe('GROUP_NOT_FOUND');
  });
});
