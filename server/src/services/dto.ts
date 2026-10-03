/**
 * Row → JSON mappers. The Android client only ever sees these shapes, and
 * contact details (phone, email) are never part of a public profile.
 */
import type { ContentMediaRow, ContentRow } from '../db/queries/content';
import type { ExamRow } from '../db/queries/exams';
import type { EventRow } from '../db/queries/events';
import type { GroupRow } from '../db/queries/groups';
import type { HomeworkRow } from '../db/queries/homework';
import type { IssueRow } from '../db/queries/issues';
import type { SubjectRow } from '../db/queries/structure';
import type { BookRow } from '../db/queries/books';
import type { NotificationRow } from '../db/queries/notifications';
import type { UserRow } from '../db/queries/users';
import { parseChapters } from '../db/queries/exams';

export interface ContentItemDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  studyDate: string;
  period: number | null;
  status: string;
  revision: number;
  groupId: string;
  groupName?: string;
  subject: SubjectDto | null;
  sectionScope: string | null;
  author: PublicUserDto;
  createdAt: string;
  updatedAt: string;
  mediaCount: number;
  contributionCount: number;
  commentCount: number;
  usefulCount: number;
  isPinned: boolean;
  sourceUrl?: string | null;
  canonicalId?: string | null;
  media?: MediaDto[];
  bookmarked?: boolean;
  useful?: boolean;
  mine?: boolean;
}

export interface SubjectDto {
  id: number;
  name: string;
  shortName: string | null;
  emoji: string | null;
  color: string | null;
}

export interface MediaDto {
  id: string;
  fileId: string;
  role: string;
  pageIndex: number;
  caption: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  uploadedBy: string;
  uploaderName?: string;
}

export interface PublicUserDto {
  id: string;
  fullName: string;
  gradeId: number;
  sectionCode: string;
  classId: string;
  avatarKey: string | null;
  role: string;
}

export function subjectDto(row: SubjectRow | null | undefined): SubjectDto | null {
  if (!row) return null;
  return { id: row.id, name: row.name, shortName: row.short_name, emoji: row.emoji, color: row.color };
}

function subjectFromJoined(row: { subject_id: number | null; subject_name?: string | null; subject_emoji?: string | null; subject_color?: string | null }): SubjectDto | null {
  if (!row.subject_id) return null;
  return {
    id: row.subject_id,
    name: row.subject_name ?? '',
    shortName: null,
    emoji: row.subject_emoji ?? null,
    color: row.subject_color ?? null,
  };
}

export function publicUser(user: Pick<UserRow, 'id' | 'full_name' | 'grade_id' | 'section_code' | 'class_id' | 'avatar_key' | 'role'>): PublicUserDto {
  return {
    id: user.id,
    fullName: user.full_name,
    gradeId: user.grade_id,
    sectionCode: user.section_code,
    classId: user.class_id,
    avatarKey: user.avatar_key,
    role: user.role,
  };
}

export function selfUser(user: UserRow) {
  return {
    ...publicUser(user),
    academicYearId: user.academic_year_id,
    bio: user.bio,
    hasEmail: user.email !== null,
    email: user.email,
    createdAt: user.created_at,
    lastSeenAt: user.last_seen_at,
  };
}

export function contentDto(
  row: ContentRow,
  extras: { media?: ContentMediaRow[]; bookmarked?: boolean; useful?: boolean; mine?: boolean } = {},
): ContentItemDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    studyDate: row.study_date,
    period: row.period,
    status: row.status,
    revision: row.revision,
    groupId: row.group_id,
    groupName: row.group_name,
    subject: subjectFromJoined(row),
    sectionScope: row.section_scope,
    author: {
      id: row.created_by,
      fullName: row.author_name ?? '',
      gradeId: row.author_grade ?? 0,
      sectionCode: row.author_section ?? '',
      classId: row.author_grade && row.author_section ? `${row.author_grade}-${row.author_section}` : '',
      avatarKey: null,
      role: 'MEMBER',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mediaCount: row.media_count,
    contributionCount: row.contribution_count,
    commentCount: row.comment_count,
    usefulCount: row.useful_count,
    isPinned: row.is_pinned === 1,
    sourceUrl: row.source_url,
    canonicalId: row.canonical_id,
    ...(extras.media ? { media: extras.media.map(mediaDto) } : {}),
    ...(extras.bookmarked !== undefined ? { bookmarked: extras.bookmarked } : {}),
    ...(extras.useful !== undefined ? { useful: extras.useful } : {}),
    ...(extras.mine !== undefined ? { mine: extras.mine } : {}),
  };
}

export function mediaDto(row: ContentMediaRow): MediaDto {
  return {
    id: row.id,
    fileId: row.file_id,
    role: row.role,
    pageIndex: row.page_index,
    caption: row.caption,
    mimeType: row.mime_type ?? 'application/octet-stream',
    sizeBytes: row.size_bytes ?? 0,
    width: row.width ?? null,
    height: row.height ?? null,
    url: `/api/v1/files/${row.file_id}/content`,
    uploadedBy: row.uploaded_by,
    uploaderName: row.uploader_name,
  };
}

export function homeworkDto(row: HomeworkRow, extras: { mine?: boolean; bookmarked?: boolean; homeworkIdOfSubject?: never } = {}) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    kind: row.kind,
    title: row.title,
    body: row.body,
    subject: subjectFromJoined(row),
    sectionScope: row.section_scope,
    studyDate: row.study_date,
    dueDate: row.due_date,
    dueTime: row.due_time,
    status: row.status,
    revision: row.revision,
    attachmentFileId: row.attachment_file_id,
    isPinned: row.is_pinned === 1,
    commentCount: row.comment_count,
    completionCount: row.completion_count,
    done: row.done === 'DONE',
    author: {
      id: row.created_by,
      fullName: row.author_name ?? '',
      gradeId: 0,
      sectionCode: '',
      classId: '',
      avatarKey: null,
      role: 'MEMBER',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(extras.mine !== undefined ? { mine: extras.mine } : {}),
    ...(extras.bookmarked !== undefined ? { bookmarked: extras.bookmarked } : {}),
  };
}

export function examDto(row: ExamRow, extras: { bookmarked?: boolean; useful?: boolean } = {}) {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    subject: subjectFromJoined(row),
    sectionScope: row.section_scope,
    examDate: row.exam_date,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    chapters: parseChapters(row.chapters),
    room: row.room,
    notes: row.notes,
    bookId: row.book_id,
    status: row.status,
    revision: row.revision,
    commentCount: row.comment_count,
    author: { id: row.created_by, fullName: row.author_name ?? '', gradeId: 0, sectionCode: '', classId: '', avatarKey: null, role: 'MEMBER' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(extras.bookmarked !== undefined ? { bookmarked: extras.bookmarked } : {}),
    ...(extras.useful !== undefined ? { useful: extras.useful } : {}),
  };
}

export function eventDto(row: EventRow, extras: { bookmarked?: boolean } = {}) {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    subject: subjectFromJoined(row),
    sectionScope: row.section_scope,
    eventDate: row.event_date,
    endDate: row.end_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    status: row.status,
    isPinned: row.is_pinned === 1,
    commentCount: row.comment_count,
    author: { id: row.created_by, fullName: row.author_name ?? '', gradeId: 0, sectionCode: '', classId: '', avatarKey: null, role: 'MEMBER' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(extras.bookmarked !== undefined ? { bookmarked: extras.bookmarked } : {}),
  };
}

export function issueDto(row: IssueRow, extras: { mine?: boolean; bookmarked?: boolean } = {}) {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    body: row.body,
    status: row.status,
    subject: subjectFromJoined(row),
    studyDate: row.study_date,
    homeworkId: row.homework_id,
    homeworkTitle: row.homework_title ?? null,
    examId: row.exam_id,
    examTitle: row.exam_title ?? null,
    contentId: row.content_id,
    contentTitle: row.content_title ?? null,
    bestCommentId: row.best_comment_id,
    commentCount: row.comment_count,
    isPinned: row.is_pinned === 1,
    author: { id: row.created_by, fullName: row.author_name ?? '', gradeId: 0, sectionCode: '', classId: '', avatarKey: null, role: 'MEMBER' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    ...(extras.mine !== undefined ? { mine: extras.mine } : {}),
    ...(extras.bookmarked !== undefined ? { bookmarked: extras.bookmarked } : {}),
  };
}

export function bookDto(row: BookRow, extras: { sources?: Array<{ id: string; label: string; url: string; kind: string }> } = {}) {
  return {
    id: row.id,
    title: row.title,
    gradeId: row.grade_id,
    gradeName: row.grade_name ?? null,
    subject: subjectFromJoined(row),
    edition: row.edition,
    publisher: row.publisher,
    rights: row.rights,
    pages: row.pages,
    sizeBytes: row.size_bytes,
    coverKey: row.cover_key,
    fileId: row.file_id,
    downloadUrl: row.file_id ? `/api/v1/files/${row.file_id}/content` : null,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    ...(extras.sources ? { sources: extras.sources } : {}),
  };
}

export function groupDto(
  row: GroupRow,
  extras: {
    sections?: Array<{ gradeId: number; gradeName: string; code: string; label: string }>;
    membership?: { role: string; status: string; notifications: string } | null;
    mySectionScope?: string | null;
  } = {},
) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    subjectId: row.subject_id,
    visibility: row.visibility,
    joinPolicy: row.join_policy,
    memberCount: row.member_count,
    status: row.status,
    academicYearId: row.academic_year_id,
    sections: extras.sections ?? [],
    membership: extras.membership ?? null,
    mySectionScope: extras.mySectionScope ?? null,
  };
}

export function notificationDto(row: NotificationRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    groupId: row.group_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    deepLink: row.deep_link,
    priority: row.priority,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

export function commentDto(row: {
  id: string;
  user_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  user_name?: string;
  user_grade?: number;
  user_section?: string;
  parent_id?: string | null;
}) {
  return {
    id: row.id,
    body: row.body,
    parentId: row.parent_id ?? null,
    author: {
      id: row.user_id,
      fullName: row.user_name ?? '',
      gradeId: row.user_grade ?? 0,
      sectionCode: row.user_section ?? '',
      classId: row.user_grade && row.user_section ? `${row.user_grade}-${row.user_section}` : '',
      avatarKey: null,
      role: 'MEMBER',
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function fileUrl(fileId: string, expiresSeconds = 3600): string {
  return `/api/v1/files/${fileId}/content?expires=${expiresSeconds}`;
}
