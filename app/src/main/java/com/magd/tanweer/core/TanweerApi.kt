package com.magd.tanweer.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/**
 * كل نداءات الخادم في مكان واحد. لا تعرف الشاشات شيئًا عن HTTP أو JSON،
 * وكل مسار هنا مطابق لما في `server/src/router.ts` بالحرف.
 */
class TanweerApi(private val session: SessionManager) {

    private val api = session.api
    private val json = TanweerJson

    // ── المدرسة والمجموعات ─────────────────────────────────────────────────────

    suspend fun structure(gradeId: Int? = null): SchoolStructure =
        decode(
            api.request("GET", "/api/v1/school/structure", query = buildQuery("gradeId" to gradeId), authenticated = false),
            SchoolStructure.serializer(),
        )

    suspend fun myGroups(): List<GroupInfo> = decodeList(api.request("GET", "/api/v1/groups"), GroupInfo.serializer())

    /** مجموعة الصف النشطة — الافتراضي لكل الشاشات. */
    suspend fun classGroupId(): String? = myGroups().firstOrNull { it.kind == "CLASS" }?.id

    // ── اليوم والتقويم ─────────────────────────────────────────────────────────

    suspend fun today(groupId: String? = null): DayOverview =
        decode(api.request("GET", "/api/v1/today", query = buildQuery("groupId" to groupId)), DayOverview.serializer())

    suspend fun tomorrow(groupId: String? = null): DayOverview =
        decode(api.request("GET", "/api/v1/tomorrow", query = buildQuery("groupId" to groupId)), DayOverview.serializer())

    suspend fun day(date: String, groupId: String? = null): DayOverview =
        decode(api.request("GET", "/api/v1/day/$date", query = buildQuery("groupId" to groupId)), DayOverview.serializer())

    suspend fun calendar(month: String, groupId: String? = null): CalendarMonth =
        decode(
            api.request("GET", "/api/v1/calendar", query = buildQuery("month" to month, "groupId" to groupId)),
            CalendarMonth.serializer(),
        )

    suspend fun subjectJourney(subjectId: Int, groupId: String? = null): SubjectJourney =
        decode(
            api.request("GET", "/api/v1/subjects/$subjectId/journey", query = buildQuery("groupId" to groupId)),
            SubjectJourney.serializer(),
        )

    // ── المحتوى ───────────────────────────────────────────────────────────────

    suspend fun content(
        groupId: String,
        subjectId: Int? = null,
        date: String? = null,
        type: String? = null,
        authorId: String? = null,
        limit: Int = 30,
    ): List<Content> = decodeList(
        api.request(
            "GET",
            "/api/v1/content",
            query = buildQuery(
                "groupId" to groupId,
                "subjectId" to subjectId,
                "date" to date,
                "type" to type,
                "authorId" to authorId,
                "limit" to limit,
            ),
        ),
        Content.serializer(),
    )

    suspend fun contentDetail(id: String): ContentDetail =
        decode(api.request("GET", "/api/v1/content/$id"), ContentDetail.serializer())

    suspend fun createContent(
        groupId: String,
        type: String,
        title: String,
        body: String?,
        subjectId: Int?,
        studyDate: String,
        period: Int?,
        sectionScope: String?,
        sourceUrl: String?,
        fileIds: List<String>,
        mergeIntoId: String? = null,
    ): JsonElement = api.request(
        "POST",
        "/api/v1/content",
        buildJsonObject {
            put("groupId", groupId)
            put("type", type)
            put("title", title)
            body?.takeIf { it.isNotBlank() }?.let { put("body", it) }
            subjectId?.let { put("subjectId", it) }
            put("studyDate", studyDate)
            period?.let { put("period", it) }
            if (sectionScope != null) put("sectionScope", sectionScope)
            sourceUrl?.takeIf { it.isNotBlank() }?.let { put("sourceUrl", it) }
            mergeIntoId?.let { put("mergeIntoId", it) }
            putJsonArray("files") {
                fileIds.forEachIndexed { index, fileId ->
                    add(
                        buildJsonObject {
                            put("fileId", fileId)
                            put("role", if (index == 0) "REFERENCE" else "EXTRA")
                        },
                    )
                }
            }
        },
    )

    suspend fun addMedia(contentId: String, fileIds: List<String>, caption: String? = null) = api.request(
        "POST",
        "/api/v1/content/$contentId/media",
        buildJsonObject {
            caption?.let { put("caption", it) }
            putJsonArray("files") { fileIds.forEach { add(buildJsonObject { put("fileId", it) }) } }
        },
    )

    suspend fun mergeContent(sourceId: String, intoId: String) = api.request(
        "POST",
        "/api/v1/content/$sourceId/merge",
        buildJsonObject { put("intoId", intoId) },
    )

    suspend fun updateContent(id: String, fields: Map<String, String?>, reason: String? = null) = api.request(
        "PATCH",
        "/api/v1/content/$id",
        buildJsonObject {
            fields.forEach { (key, value) -> value?.let { put(key, it) } }
            reason?.let { put("reason", it) }
        },
    )

    suspend fun addComment(entityType: String, entityId: String, body: String, parentId: String? = null) = api.request(
        "POST",
        "/api/v1/${pathOf(entityType)}/$entityId/comments",
        buildJsonObject {
            put("body", body)
            parentId?.let { put("parentId", it) }
        },
    )

    suspend fun comments(entityType: String, entityId: String): List<Comment> =
        decodeList(api.request("GET", "/api/v1/${pathOf(entityType)}/$entityId/comments"), Comment.serializer())

    suspend fun toggleUseful(entityType: String, entityId: String) =
        api.request("POST", "/api/v1/${pathOf(entityType)}/$entityId/useful", buildJsonObject { })

    suspend fun toggleSaved(entityType: String, entityId: String) =
        api.request("POST", "/api/v1/${pathOf(entityType)}/$entityId/save", buildJsonObject { })

    suspend fun requestCorrection(entityType: String, entityId: String, field: String, value: String, reason: String) =
        api.request(
            "POST",
            "/api/v1/${pathOf(entityType)}/$entityId/corrections",
            buildJsonObject {
                put("field", field)
                put("proposedValue", value)
                put("reason", reason)
            },
        )

    suspend fun requestDeletion(entityType: String, entityId: String, reason: String) =
        api.request(
            "POST",
            "/api/v1/${pathOf(entityType)}/$entityId/deletion-requests",
            buildJsonObject { put("reason", reason) },
        )

    suspend fun askAbout(entityType: String, entityId: String, title: String, body: String?) =
        api.request(
            "POST",
            "/api/v1/${pathOf(entityType)}/$entityId/questions",
            buildJsonObject {
                put("title", title)
                body?.let { put("body", it) }
            },
        )

    // ── الواجبات والاختبارات والفعاليات ───────────────────────────────────────

    suspend fun homeworks(scope: String, groupId: String? = null): List<Homework> = decodeList(
        api.request("GET", "/api/v1/homeworks", query = buildQuery("scope" to scope, "groupId" to groupId)),
        Homework.serializer(),
    )

    suspend fun markHomework(id: String, done: Boolean) = api.request(
        "POST",
        "/api/v1/homeworks/$id/complete",
        buildJsonObject { put("done", done) },
    )

    suspend fun createHomework(
        groupId: String,
        title: String,
        body: String?,
        subjectId: Int?,
        dueDate: String?,
        dueTime: String?,
        kind: String,
    ) = api.request(
        "POST",
        "/api/v1/homeworks",
        buildJsonObject {
            put("groupId", groupId)
            put("kind", kind)
            put("title", title)
            body?.takeIf { it.isNotBlank() }?.let { put("body", it) }
            subjectId?.let { put("subjectId", it) }
            put("studyDate", Dates.toIso(Dates.today()))
            dueDate?.let { put("dueDate", it) }
            dueTime?.let { put("dueTime", it) }
        },
    )

    suspend fun exams(scope: String, groupId: String? = null): List<Exam> = decodeList(
        api.request("GET", "/api/v1/exams", query = buildQuery("scope" to scope, "groupId" to groupId)),
        Exam.serializer(),
    )

    suspend fun examDetail(id: String): JsonElement = api.request("GET", "/api/v1/exams/$id")

    suspend fun events(scope: String, groupId: String? = null): List<Event> = decodeList(
        api.request("GET", "/api/v1/events", query = buildQuery("scope" to scope, "groupId" to groupId)),
        Event.serializer(),
    )

    // ── الاستفسارات ───────────────────────────────────────────────────────────

    suspend fun issues(
        groupId: String,
        status: String? = null,
        subjectId: Int? = null,
        contentId: String? = null,
        homeworkId: String? = null,
        query: String? = null,
    ): List<Issue> = decodeList(
        api.request(
            "GET",
            "/api/v1/issues",
            query = buildQuery(
                "groupId" to groupId,
                "status" to status,
                "subjectId" to subjectId,
                "contentId" to contentId,
                "homeworkId" to homeworkId,
                "q" to query,
            ),
        ),
        Issue.serializer(),
    )

    suspend fun createIssue(
        groupId: String,
        title: String,
        body: String?,
        subjectId: Int?,
        contentId: String? = null,
        homeworkId: String? = null,
        examId: String? = null,
    ) = api.request(
        "POST",
        "/api/v1/issues",
        buildJsonObject {
            put("groupId", groupId)
            put("title", title)
            body?.takeIf { it.isNotBlank() }?.let { put("body", it) }
            subjectId?.let { put("subjectId", it) }
            contentId?.let { put("contentId", it) }
            homeworkId?.let { put("homeworkId", it) }
            examId?.let { put("examId", it) }
        },
    )

    suspend fun issueDetail(id: String): IssueDetail =
        decode(api.request("GET", "/api/v1/issues/$id"), IssueDetail.serializer())

    suspend fun answerIssue(id: String, body: String) =
        api.request("POST", "/api/v1/issues/$id/comments", buildJsonObject { put("body", body) })

    suspend fun setIssueStatus(id: String, status: String) =
        api.request("PATCH", "/api/v1/issues/$id/status", buildJsonObject { put("status", status) })

    suspend fun setBestAnswer(issueId: String, commentId: String) =
        api.request("POST", "/api/v1/issues/$issueId/best-answer", buildJsonObject { put("commentId", commentId) })

    // ── الجدول والتصويت ───────────────────────────────────────────────────────

    suspend fun schedule(groupId: String? = null, date: String? = null): JsonElement =
        api.request("GET", "/api/v1/schedule", query = buildQuery("groupId" to groupId, "date" to date))

    suspend fun fillPeriod(groupId: String, weekday: Int, period: Int, subjectId: Int, room: String? = null) =
        api.request(
            "POST",
            "/api/v1/schedule/slots",
            buildJsonObject {
                put("groupId", groupId)
                put("weekday", weekday)
                put("period", period)
                put("subjectId", subjectId)
                room?.let { put("room", it) }
            },
        )

    suspend fun proposeScheduleChange(groupId: String, weekday: Int, period: Int, subjectId: Int?, reason: String) =
        api.request(
            "POST",
            "/api/v1/schedule/proposals",
            buildJsonObject {
                put("groupId", groupId)
                put("weekday", weekday)
                put("period", period)
                subjectId?.let { put("subjectId", it) }
                put("reason", reason)
            },
        )

    suspend fun proposals(groupId: String): JsonElement =
        api.request("GET", "/api/v1/schedule/proposals", query = buildQuery("groupId" to groupId))

    suspend fun vote(targetType: String, targetId: String, value: String, comment: String? = null): VoteResult =
        decode(
            api.request(
                "POST",
                "/api/v1/votes",
                buildJsonObject {
                    put("targetType", targetType)
                    put("targetId", targetId)
                    put("value", value)
                    comment?.let { put("comment", it) }
                },
            ),
            VoteResult.serializer(),
        )

    suspend fun communityRequests(groupId: String): CommunityRequests =
        decode(
            api.request("GET", "/api/v1/community/requests", query = buildQuery("groupId" to groupId)),
            CommunityRequests.serializer(),
        )

    suspend fun withdrawRequest(kind: String, requestId: String) = api.request(
        "POST",
        if (kind == "DELETION") "/api/v1/community/deletions/$requestId/withdraw" else "/api/v1/community/corrections/$requestId/withdraw",
        buildJsonObject { },
    )

    // ── المكتبة والملاحظات والمحفوظات ─────────────────────────────────────────

    suspend fun books(gradeId: Int? = null, subjectId: Int? = null): List<Book> = decodeList(
        api.request("GET", "/api/v1/books", query = buildQuery("gradeId" to gradeId, "subjectId" to subjectId)),
        Book.serializer(),
    )

    suspend fun createBook(title: String, subjectId: Int?, rights: String, fileId: String?, sourceUrl: String?, pages: Int?) =
        api.request(
            "POST",
            "/api/v1/books",
            buildJsonObject {
                put("title", title)
                subjectId?.let { put("subjectId", it) }
                put("rights", rights)
                fileId?.let { put("fileId", it) }
                sourceUrl?.let { put("sourceUrl", it) }
                pages?.let { put("pages", it) }
            },
        )

    suspend fun notes(): List<Note> = decodeList(api.request("GET", "/api/v1/notes"), Note.serializer())

    suspend fun createNote(body: String, title: String?, groupId: String?, subjectId: Int?, studyDate: String?) =
        api.request(
            "POST",
            "/api/v1/notes",
            buildJsonObject {
                put("body", body)
                title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
                groupId?.let { put("groupId", it) }
                subjectId?.let { put("subjectId", it) }
                studyDate?.let { put("studyDate", it) }
            },
        )

    suspend fun updateNote(id: String, body: String?, title: String?) = api.request(
        "PATCH",
        "/api/v1/notes/$id",
        buildJsonObject {
            body?.let { put("body", it) }
            title?.let { put("title", it) }
        },
    )

    suspend fun deleteNote(id: String) = api.request("DELETE", "/api/v1/notes/$id")

    suspend fun bookmarks(): List<BookmarkEntry> =
        decodeList(api.request("GET", "/api/v1/bookmarks"), BookmarkEntry.serializer())

    // ── حسابي ─────────────────────────────────────────────────────────────────

    suspend fun me(): User = decode(api.request("GET", "/api/v1/me"), User.serializer())

    suspend fun updateProfile(fullName: String?, bio: String?, email: String?) = api.request(
        "PATCH",
        "/api/v1/me",
        buildJsonObject {
            fullName?.let { put("fullName", it) }
            bio?.let { put("bio", it) }
            email?.let { put("email", it) }
        },
    )

    suspend fun devices(): List<DeviceInfo> = decodeList(api.request("GET", "/api/v1/me/devices"), DeviceInfo.serializer())

    suspend fun revokeDevice(id: String) = api.request("DELETE", "/api/v1/me/devices/$id")

    suspend fun pushToken(token: String) = api.request("POST", "/api/v1/me/push-token", buildJsonObject { put("token", token) })

    suspend fun contributions(): ContributionStats =
        decode(api.request("GET", "/api/v1/me/contributions"), ContributionStats.serializer())

    suspend fun missed(since: String? = null): MissedResult =
        decode(api.request("GET", "/api/v1/me/missed", query = buildQuery("since" to since)), MissedResult.serializer())

    suspend fun widgetSummary(groupId: String? = null): WidgetSummary =
        decode(
            api.request("GET", "/api/v1/me/widget", query = buildQuery("groupId" to groupId)),
            WidgetSummary.serializer(),
        )

    suspend fun notifications(limit: Int = 50): List<NotificationItem> = decodeList(
        api.request("GET", "/api/v1/notifications", query = buildQuery("limit" to limit)),
        NotificationItem.serializer(),
    )

    suspend fun markNotificationsRead(ids: List<String> = emptyList()) = api.request(
        "POST",
        "/api/v1/notifications/read",
        buildJsonObject { putJsonArray("ids") { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } },
    )

    suspend fun notificationPreferences(): NotificationPreferences =
        decode(api.request("GET", "/api/v1/notifications/preferences"), NotificationPreferences.serializer())

    suspend fun search(query: String, groupId: String? = null, type: String? = null): SearchResults = decode(
        api.request(
            "GET",
            "/api/v1/search",
            query = buildQuery("q" to query, "groupId" to groupId, "type" to type),
        ),
        SearchResults.serializer(),
    )

    suspend fun sync(since: String? = null): JsonElement =
        api.request("GET", "/api/v1/sync", query = buildQuery("since" to since))

    // ── الدردشة ───────────────────────────────────────────────────────────────

    suspend fun chatRooms(): List<ChatRoom> = decodeList(api.request("GET", "/api/v1/chat/rooms"), ChatRoom.serializer())

    suspend fun roomForGroup(groupId: String): ChatRoom =
        decode(api.request("GET", "/api/v1/chat/group/$groupId"), ChatRoom.serializer())

    suspend fun chatMessages(roomId: String, before: Long? = null, limit: Int = 40): ChatPage =
        decode(
            api.request(
                "GET",
                "/api/v1/chat/rooms/$roomId/messages",
                query = buildQuery("before" to before, "limit" to limit),
            ),
            ChatPage.serializer(),
        )

    suspend fun sendMessage(roomId: String, body: String, replyToId: String? = null): ChatMessage = decode(
        api.request(
            "POST",
            "/api/v1/chat/rooms/$roomId/messages",
            buildJsonObject {
                put("body", body)
                replyToId?.let { put("replyToId", it) }
            },
        ),
        ChatMessage.serializer(),
    )

    suspend fun markRoomRead(roomId: String, seq: Long) =
        api.request("POST", "/api/v1/chat/rooms/$roomId/read", buildJsonObject { put("seq", seq) })

    suspend fun typing(roomId: String) = api.request("POST", "/api/v1/chat/rooms/$roomId/typing", buildJsonObject { })

    suspend fun openDirect(userId: String): ChatRoom =
        decode(api.request("POST", "/api/v1/chat/direct/$userId", buildJsonObject { }), ChatRoom.serializer())

    // ── الملفات (رفع مباشر إلى R2 عبر رابط موقّع) ─────────────────────────────

    suspend fun uploadFile(
        bytes: ByteArray,
        mimeType: String,
        purpose: String = "CONTENT_MEDIA",
        groupId: String? = null,
        fileName: String? = null,
    ): FileCompletion {
        val checksum = PasswordCrypto.sha256Hex(bytes)
        val intent = decode(
            api.request(
                "POST",
                "/api/v1/files/upload-intent",
                buildJsonObject {
                    put("purpose", purpose)
                    put("mimeType", mimeType)
                    put("sizeBytes", bytes.size)
                    put("checksum", checksum)
                    groupId?.let { put("groupId", it) }
                    fileName?.let { put("fileName", it) }
                },
            ),
            UploadIntent.serializer(),
        )

        api.uploadToSignedUrl(intent.uploadUrl, bytes, mimeType, intent.method)

        val completion = decode(
            api.request(
                "POST",
                "/api/v1/files/complete",
                buildJsonObject {
                    put("fileId", intent.fileId)
                    put("sizeBytes", bytes.size)
                    put("checksum", checksum)
                },
            ),
            FileCompleteResult.serializer(),
        )
        return completion.file ?: FileCompletion(id = intent.fileId, mimeType = mimeType, sizeBytes = bytes.size.toLong(), checksum = checksum)
    }

    /** رابط صورة قابل للعرض (Coil) — يمرّ عبر بوابة تنوير الموقّعة بالجلسة. */
    fun mediaUrl(fileId: String): String = "${com.magd.tanweer.BuildConfig.API_BASE_URL}/api/v1/files/$fileId/content"

    // ── أدوات ─────────────────────────────────────────────────────────────────

    private fun pathOf(entityType: String): String = when (entityType) {
        "HOMEWORK" -> "homeworks"
        "EXAM" -> "exams"
        "EVENT" -> "events"
        "ISSUE" -> "issues"
        else -> "content"
    }

    private fun <T> decode(element: JsonElement, serializer: KSerializer<T>): T =
        json.decodeFromJsonElement(serializer, element)

    private fun <T> decodeList(element: JsonElement, serializer: KSerializer<T>): List<T> =
        (element as? JsonArray)?.map { json.decodeFromJsonElement(serializer, it) } ?: emptyList()
}
