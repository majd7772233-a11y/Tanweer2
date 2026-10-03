package com.magd.tanweer.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * نماذج العقد مع الخادم. كل الحقول الرقمية/النصية التي قد يضيفها الخادم لاحقًا
 * اختيارية (لها قيم افتراضية) حتى لا ينكسر تطبيق قديم.
 */

@Serializable
data class KdfParams(
    val phone: String,
    val kdf: String = "pbkdf2-sha256",
    val algorithm: String = "PBKDF2-HMAC-SHA256",
    val iterations: Int = PasswordCrypto.DEFAULT_ITERATIONS,
    val keyLength: Int = PasswordCrypto.DEFAULT_KEY_LENGTH,
    val salt: String,
)

@Serializable
data class Tokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long = 3600,
    val refreshExpiresIn: Long = 15_552_000,
)

@Serializable
data class User(
    val id: String,
    val fullName: String = "",
    val gradeId: Int = 0,
    val sectionCode: String = "",
    val classId: String = "",
    val avatarKey: String? = null,
    val role: String = "MEMBER",
    val academicYearId: String? = null,
    val bio: String? = null,
    val hasEmail: Boolean = false,
    val email: String? = null,
    val createdAt: String? = null,
    val lastSeenAt: String? = null,
)

@Serializable
data class GroupRef(val id: String, val kind: String = "CLASS", val name: String = "")

@Serializable
data class RegisterResult(
    val user: User,
    val tokens: Tokens,
    val recoveryCode: String? = null,
    val groups: List<GroupRef> = emptyList(),
)

@Serializable
data class LoginResult(val user: User, val tokens: Tokens, val classId: String? = null)

@Serializable
data class RefreshResult(val user: User, val tokens: Tokens)

@Serializable
data class Subject(
    val id: Int,
    val name: String = "",
    val shortName: String? = null,
    val emoji: String? = null,
    val color: String? = null,
)

@Serializable
data class Media(
    val id: String,
    val fileId: String,
    val role: String = "EXTRA",
    val pageIndex: Int = 0,
    val caption: String? = null,
    val mimeType: String = "application/octet-stream",
    val sizeBytes: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val url: String = "",
    val uploadedBy: String = "",
    val uploaderName: String? = null,
)

@Serializable
data class Author(
    val id: String = "",
    val fullName: String = "",
    val gradeId: Int = 0,
    val sectionCode: String = "",
    val classId: String = "",
    val avatarKey: String? = null,
    val role: String = "MEMBER",
)

@Serializable
data class Content(
    val id: String,
    val type: String = "LESSON",
    val title: String = "",
    val body: String? = null,
    val studyDate: String = "",
    val period: Int? = null,
    val status: String = "PUBLISHED",
    val revision: Int = 1,
    val groupId: String = "",
    val groupName: String? = null,
    val subject: Subject? = null,
    val sectionScope: String? = null,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val mediaCount: Int = 0,
    val contributionCount: Int = 0,
    val commentCount: Int = 0,
    val usefulCount: Int = 0,
    val isPinned: Boolean = false,
    val sourceUrl: String? = null,
    val canonicalId: String? = null,
    val media: List<Media> = emptyList(),
    val bookmarked: Boolean? = null,
    val useful: Boolean? = null,
    val mine: Boolean? = null,
)

@Serializable
data class Contribution(
    val id: String,
    val kind: String = "PHOTO",
    val note: String? = null,
    val fileId: String? = null,
    val createdAt: String = "",
    val user: Author = Author(),
)

@Serializable
data class Revision(
    val id: String,
    val revision: Int = 1,
    val action: String = "",
    val reason: String? = null,
    val changedBy: String = "",
    val changedByName: String = "",
    val changedAt: String = "",
)

@Serializable
data class Relation(val id: String, val toType: String = "", val toId: String = "", val kind: String = "RELATED")

@Serializable
data class ContentDetail(
    val content: Content,
    val comments: List<Comment> = emptyList(),
    val contributions: List<Contribution> = emptyList(),
    val relations: List<Relation> = emptyList(),
    val history: List<Revision> = emptyList(),
    val pinned: Boolean = false,
)

@Serializable
data class Comment(
    val id: String,
    val body: String = "",
    val parentId: String? = null,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val isBest: Boolean = false,
)

@Serializable
data class DayCard(
    val period: Int? = null,
    val title: String = "",
    val subject: Subject? = null,
    val status: String = "UPCOMING",
    val lessons: Int = 0,
    val homeworks: Int = 0,
    val files: Int = 0,
    val notes: Int = 0,
    val contributions: Int = 0,
    val lastContributionAt: String? = null,
    val canContribute: Boolean = false,
)

@Serializable
data class Homework(
    val id: String,
    val groupId: String = "",
    val groupName: String? = null,
    val kind: String = "HOMEWORK",
    val title: String = "",
    val body: String? = null,
    val subject: Subject? = null,
    val sectionScope: String? = null,
    val studyDate: String = "",
    val dueDate: String? = null,
    val dueTime: String? = null,
    val status: String = "PUBLISHED",
    val revision: Int = 1,
    val attachmentFileId: String? = null,
    val isPinned: Boolean = false,
    val commentCount: Int = 0,
    val completionCount: Int = 0,
    val done: Boolean = false,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val mine: Boolean? = null,
)

@Serializable
data class Exam(
    val id: String,
    val groupId: String = "",
    val title: String = "",
    val subject: Subject? = null,
    val sectionScope: String? = null,
    val examDate: String = "",
    val startsAt: String? = null,
    val durationMinutes: Int? = null,
    val chapters: List<String> = emptyList(),
    val room: String? = null,
    val notes: String? = null,
    val bookId: String? = null,
    val status: String = "PUBLISHED",
    val revision: Int = 1,
    val commentCount: Int = 0,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class Event(
    val id: String,
    val groupId: String = "",
    val title: String = "",
    val description: String? = null,
    val kind: String = "ACTIVITY",
    val subject: Subject? = null,
    val sectionScope: String? = null,
    val eventDate: String = "",
    val endDate: String? = null,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val location: String? = null,
    val status: String = "PUBLISHED",
    val isPinned: Boolean = false,
    val commentCount: Int = 0,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class Issue(
    val id: String,
    val groupId: String = "",
    val title: String = "",
    val body: String? = null,
    val status: String = "OPEN",
    val subject: Subject? = null,
    val studyDate: String = "",
    val homeworkId: String? = null,
    val homeworkTitle: String? = null,
    val examId: String? = null,
    val examTitle: String? = null,
    val contentId: String? = null,
    val contentTitle: String? = null,
    val bestCommentId: String? = null,
    val commentCount: Int = 0,
    val isPinned: Boolean = false,
    val author: Author = Author(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val lastActivityAt: String? = null,
    val mine: Boolean? = null,
)

@Serializable
data class IssueDetail(val issue: Issue, val comments: List<Comment> = emptyList())

@Serializable
data class NextExam(
    val id: String,
    val title: String = "",
    val examDate: String = "",
    val daysUntil: Long = 0,
    val subject: Subject? = null,
)

@Serializable
data class DayOverview(
    val date: String = "",
    val weekday: Int? = null,
    val weekdayName: String = "",
    val isToday: Boolean = false,
    val isSchoolDay: Boolean = true,
    val isHoliday: Boolean = false,
    val holidayTitle: String? = null,
    val scheduleVersionId: String? = null,
    val cards: List<DayCard> = emptyList(),
    val documentedCount: Int = 0,
    val needsContributionCount: Int = 0,
    val upcomingCount: Int = 0,
    val totalCount: Int = 0,
    val progress: Int = 0,
    val homeworks: List<Homework> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val events: List<Event> = emptyList(),
    val nextExam: NextExam? = null,
    val content: List<Content> = emptyList(),
    val openIssues: Int = 0,
)

@Serializable
data class ScheduleSlot(
    val id: String = "",
    val weekday: Int = 0,
    val period: Int = 1,
    val subject: Subject? = null,
    val room: String? = null,
    val notes: String? = null,
)

@Serializable
data class ScheduleDay(
    val weekday: Int,
    val weekdayName: String = "",
    val slots: List<ScheduleSlot> = emptyList(),
)

@Serializable
data class ScheduleVersion(
    val id: String = "",
    val title: String = "",
    val effectiveFrom: String? = null,
    val effectiveTo: String? = null,
    val status: String = "ACTIVE",
    val notes: String? = null,
)

/** `GET /schedule` يعيد الأسبوع كاملًا: `{version, days[]}`. */
@Serializable
data class ScheduleWeek(
    val version: ScheduleVersion? = null,
    val days: List<ScheduleDay> = emptyList(),
)

@Serializable
data class ScheduleView(
    val date: String = "",
    val weekday: Int? = null,
    val version: ScheduleVersion? = null,
    val day: ScheduleDay = ScheduleDay(weekday = 0),
    val week: ScheduleWeek = ScheduleWeek(),
    val canEdit: Boolean = false,
    val mySection: String? = null,
)

@Serializable
data class Proposal(
    val id: String,
    val groupId: String = "",
    val versionId: String? = null,
    val weekday: Int = 0,
    val weekdayName: String = "",
    val period: Int = 1,
    val kind: String = "CHANGE",
    val currentSubjectId: Int? = null,
    val proposedSubjectId: Int? = null,
    val reason: String? = null,
    val status: String = "PENDING",
    val approveCount: Int = 0,
    val rejectCount: Int = 0,
    val eligibleCount: Int = 0,
    val remaining: Int = 0,
    val proposedBy: String = "",
    val createdAt: String = "",
    val decidedAt: String? = null,
)

@Serializable
data class VoteCounts(val approve: Int = 0, val reject: Int = 0, val eligible: Int = 0, val remaining: Int = 0)

@Serializable
data class VoteResult(val counts: VoteCounts = VoteCounts(), val decision: String = "PENDING")

@Serializable
data class DeletionRequest(
    val id: String,
    val entityType: String = "",
    val entityId: String = "",
    val reason: String? = null,
    val status: String = "PENDING",
    val approveCount: Int = 0,
    val rejectCount: Int = 0,
    val eligibleCount: Int = 0,
    val requestedBy: Author = Author(),
    val createdAt: String = "",
)

@Serializable
data class CorrectionRequest(
    val id: String,
    val entityType: String = "",
    val entityId: String = "",
    val field: String = "",
    val currentValue: String? = null,
    val proposedValue: String = "",
    val reason: String? = null,
    val status: String = "PENDING",
    val approveCount: Int = 0,
    val rejectCount: Int = 0,
    val eligibleCount: Int = 0,
    val requestedBy: Author = Author(),
    val createdAt: String = "",
)

@Serializable
data class CommunityRequests(
    val deletions: List<DeletionRequest> = emptyList(),
    val corrections: List<CorrectionRequest> = emptyList(),
)

@Serializable
data class Book(
    val id: String,
    val title: String = "",
    val gradeId: Int? = null,
    val gradeName: String? = null,
    val subject: Subject? = null,
    val edition: String? = null,
    val publisher: String? = null,
    val rights: String = "OFFICIAL_LINK",
    val pages: Int? = null,
    val sizeBytes: Long? = null,
    val coverKey: String? = null,
    val fileId: String? = null,
    val downloadUrl: String? = null,
    val sourceUrl: String? = null,
    val createdAt: String = "",
)

@Serializable
data class Note(
    val id: String,
    val title: String? = null,
    val body: String = "",
    val groupId: String? = null,
    val subjectId: Int? = null,
    val studyDate: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class NotificationItem(
    val id: String,
    val kind: String = "",
    val title: String = "",
    val body: String? = null,
    val groupId: String? = null,
    val entityType: String? = null,
    val entityId: String? = null,
    val deepLink: String? = null,
    val priority: String = "NORMAL",
    val read: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class NotificationPreferences(
    val lessons: Boolean = true,
    val homeworks: Boolean = true,
    val exams: Boolean = true,
    val events: Boolean = true,
    val issues: Boolean = true,
    val messages: Boolean = true,
    val contributions: Boolean = true,
    val schedule: Boolean = true,
    val quietFrom: String? = null,
    val quietTo: String? = null,
)

@Serializable
data class DeviceInfo(
    val id: String,
    val deviceId: String = "",
    val platform: String = "android",
    val model: String? = null,
    val appVersion: String? = null,
    val osVersion: String? = null,
    val lastSeenAt: String? = null,
    val current: Boolean = false,
)

@Serializable
data class BookmarkEntry(
    val id: String,
    val entityType: String = "",
    val entityId: String = "",
    val groupId: String? = null,
    val createdAt: String = "",
)

@Serializable
data class ChatRoom(
    val id: String,
    val kind: String = "GROUP",
    val title: String = "",
    val groupId: String? = null,
    val lastSeq: Long = 0,
    val unread: Int = 0,
    val lastMessageAt: String? = null,
)

@Serializable
data class ChatMessage(
    val id: String,
    val roomId: String = "",
    val seq: Long = 0,
    val body: String? = null,
    val kind: String = "TEXT",
    val fileId: String? = null,
    val replyToId: String? = null,
    val replyPreview: String? = null,
    val replySender: String? = null,
    val createdAt: String = "",
    val editedAt: String? = null,
    val deleted: Boolean = false,
    val sender: Author = Author(),
)

@Serializable
data class ChatPage(
    val messages: List<ChatMessage> = emptyList(),
    val cursor: Long? = null,
    val lastReadSeq: Long = 0,
    val hasMore: Boolean = false,
)

@Serializable
data class ContributionSummary(
    val user: Author = Author(),
    val count: Int = 0,
    val lastAt: String? = null,
)

@Serializable
data class MissedSince(
    val since: String? = null,
    val contents: List<Content> = emptyList(),
    val homeworks: List<Homework> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val issues: List<Issue> = emptyList(),
    val events: List<Event> = emptyList(),
    val total: Int = 0,
)

@Serializable
data class WidgetSummary(
    val date: String = "",
    val weekdayName: String = "",
    val isSchoolDay: Boolean = true,
    val progress: Int = 0,
    val documentedCount: Int = 0,
    val totalCount: Int = 0,
    val nextSubject: Subject? = null,
    val nextExam: NextExam? = null,
    val needsContribution: Int = 0,
)

@Serializable
data class SyncResult(
    val contents: List<Content> = emptyList(),
    val homeworks: List<Homework> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val issues: List<Issue> = emptyList(),
    val events: List<Event> = emptyList(),
    val cursor: String? = null,
    val queuedCount: Int = 0,
)

@Serializable
data class Grade(val id: Int, val name: String = "", val stage: String = "PREPARATORY")

@Serializable
data class Section(val id: Int, val gradeId: Int = 0, val code: String = "", val label: String = "")

@Serializable
data class Structure(val grades: List<Grade> = emptyList(), val sections: List<Section> = emptyList())

@Serializable
data class FileCompletion(
    val id: String,
    val mimeType: String = "",
    val kind: String = "IMAGE",
    val sizeBytes: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val checksum: String? = null,
    val status: String = "READY",
)

// ── نماذج إضافية ─────────────────────────────────────────────────────────────

@Serializable
data class AcademicYear(
    val id: String,
    val title: String = "",
    val startDate: String? = null,
    val endDate: String? = null,
    val status: String = "ACTIVE",
)

@Serializable
data class SchoolStructure(
    val academicYear: AcademicYear? = null,
    val grades: List<Grade> = emptyList(),
    val sections: List<Section> = emptyList(),
    val subjects: List<Subject> = emptyList(),
    val today: String = "",
)

@Serializable
data class MonthDay(
    val date: String,
    val weekday: Int = 0,
    val isSchoolDay: Boolean = true,
    val isHoliday: Boolean = false,
    val lessons: Int = 0,
    val files: Int = 0,
    val homeworks: Int = 0,
    val exams: Int = 0,
    val events: Int = 0,
    val documentedSubjects: Int = 0,
    val needsContribution: Boolean = false,
)

@Serializable
data class AgendaItem(
    val id: String,
    val title: String = "",
    val dueDate: String? = null,
    val examDate: String? = null,
    val eventDate: String? = null,
    val subject: String? = null,
    val kind: String? = null,
)

@Serializable
data class CalendarMonth(
    val month: String = "",
    val start: String = "",
    val end: String = "",
    val previousMonth: String = "",
    val nextMonth: String = "",
    val today: String = "",
    val days: List<MonthDay> = emptyList(),
    val homeworkDue: List<AgendaItem> = emptyList(),
    val exams: List<AgendaItem> = emptyList(),
    val events: List<AgendaItem> = emptyList(),
)

@Serializable
data class TimelineItem(
    val kind: String = "CONTENT",
    val id: String,
    val date: String = "",
    val title: String = "",
    val status: String = "PUBLISHED",
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class SubjectCounts(
    val content: Int = 0,
    val homeworks: Int = 0,
    val exams: Int = 0,
)

@Serializable
data class SubjectJourney(
    val subject: Subject,
    val timeline: List<TimelineItem> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val homeworks: List<Homework> = emptyList(),
    val firstDate: String? = null,
    val lastDate: String? = null,
    val counts: SubjectCounts = SubjectCounts(),
)

@Serializable
data class SearchHit(
    val kind: String = "CONTENT",
    val id: String,
    val title: String = "",
    val date: String? = null,
    val groupId: String? = null,
    val groupName: String? = null,
    val subjectId: Int? = null,
    val subjectName: String? = null,
    val snippet: String? = null,
)

@Serializable
data class SearchResults(
    val query: String = "",
    val hits: List<SearchHit> = emptyList(),
    val counts: Map<String, Int> = emptyMap(),
    val cursor: String? = null,
)

@Serializable
data class ContributionStats(
    val lessons: Int = 0,
    val homeworks: Int = 0,
    val photos: Int = 0,
    val files: Int = 0,
    val issues: Int = 0,
    val answers: Int = 0,
)

@Serializable
data class MissedResult(
    val since: String? = null,
    val contents: List<Content> = emptyList(),
    val homeworks: List<Homework> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val issues: List<Issue> = emptyList(),
    val events: List<Event> = emptyList(),
    val total: Int = 0,
    val unreadMessages: Int = 0,
    val groupCount: Int = 0,
    val serverToday: String = "",
)

@Serializable
data class GroupInfo(
    val id: String,
    val kind: String = "CLASS",
    val name: String = "",
    val description: String? = null,
    val emoji: String? = null,
    val subjectId: Int? = null,
    val visibility: String = "PRIVATE",
    val joinPolicy: String = "AUTO",
    val memberCount: Int = 0,
    val status: String = "ACTIVE",
    val academicYearId: String? = null,
)

@Serializable
data class UploadIntent(
    val fileId: String,
    val uploadIntentId: String = "",
    val uploadUrl: String = "",
    val method: String = "PUT",
    val expiresAt: String? = null,
    val maxBytes: Long = 0,
)

@Serializable
data class FileCompleteResult(val file: FileCompletion? = null)
