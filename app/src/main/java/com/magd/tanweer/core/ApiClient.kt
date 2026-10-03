package com.magd.tanweer.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** خطأ صادر عن الخادم بصيغة `{success:false,error:{code,message,fields}}`. */
class ApiException(
    val code: String,
    override val message: String,
    val status: Int,
    val fields: Map<String, String> = emptyMap(),
) : Exception(message)

/** لا يوجد اتصال بالشبكة. */
class OfflineException : Exception("offline")

class NetworkException(cause: Throwable) : Exception(cause.message, cause)

/**
 * عميل HTTP واحد لكل التطبيق.
 *
 * - يضع `Authorization: Bearer` تلقائيًا.
 * - عند 401 يطلب تحديث الرمز مرة واحدة ثم يعيد المحاولة (بدون حلقة لا نهائية).
 * - يقرأ المغلّف الموحّد: `{success,data,meta}` أو `{success:false,error}`.
 */
class ApiClient(
    private val baseUrl: String,
    private val json: Json = TanweerJson,
    private val authToken: () -> String?,
    private val onUnauthorized: suspend () -> Boolean,
) {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private var refreshing: Boolean = false

    suspend fun request(
        method: String,
        path: String,
        body: JsonElement? = null,
        query: Map<String, String?> = emptyMap(),
        authenticated: Boolean = true,
        absoluteUrl: String? = null,
    ): JsonElement = withContext(Dispatchers.IO) {
        val first = execute(method, absoluteUrl ?: buildUrl(path, query), body, authenticated)
        if (first.first == 401 && authenticated && !refreshing) {
            refreshing = true
            val refreshed = try {
                onUnauthorized()
            } finally {
                refreshing = false
            }
            if (refreshed) {
                return@withContext execute(method, absoluteUrl ?: buildUrl(path, query), body, authenticated).second
            }
        }
        first.second
    }

    /** يرفع بايتات خام إلى رابط موقّع (R2 عبر بوابة تنوير). */
    suspend fun uploadToSignedUrl(url: String, bytes: ByteArray, mimeType: String, method: String = "PUT") = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .method(method, bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw ApiException("UPLOAD_FAILED", "تعذّر رفع الملف (${response.code})", response.code)
            }
        }
    }

    private fun buildUrl(path: String, query: Map<String, String?>): String {
        if (query.isEmpty()) return baseUrl + path
        val qs = query.entries
            .filter { it.value != null }
            .joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, "UTF-8")}" }
        return if (qs.isEmpty()) baseUrl + path else "${baseUrl + path}?$qs"
    }

    private fun execute(method: String, url: String, body: JsonElement?, authenticated: Boolean): Pair<Int, JsonElement> {
        val builder = Request.Builder().url(url)
        if (authenticated) {
            authToken()?.let { builder.header("Authorization", "Bearer $it") }
        }
        val payload: RequestBody? = body?.let { json.encodeToString(JsonElement.serializer(), it).toRequestBody(jsonMedia) }
        when (method.uppercase()) {
            "GET" -> builder.get()
            "POST" -> builder.post(payload ?: EMPTY_BODY)
            "PATCH" -> builder.patch(payload ?: EMPTY_BODY)
            "PUT" -> builder.put(payload ?: EMPTY_BODY)
            "DELETE" -> builder.delete(payload)
            else -> throw IllegalArgumentException("unsupported method $method")
        }

        val response = try {
            client.newCall(builder.build()).execute()
        } catch (io: IOException) {
            throw NetworkException(io)
        }

        response.use { res ->
            val text = res.body?.string().orEmpty()
            val element: JsonElement? = if (text.isBlank()) null else runCatching { json.parseToJsonElement(text) }.getOrNull()

            if (res.isSuccessful) {
                val obj = element?.jsonObject
                val data = obj?.get("data") ?: element ?: JsonObject(emptyMap())
                return res.code to data
            }

            val error = element?.jsonObject?.get("error")?.jsonObject
            throw ApiException(
                code = error?.get("code")?.jsonPrimitive?.content ?: codeForStatus(res.code),
                message = error?.get("message")?.jsonPrimitive?.content ?: "خطأ ${res.code}",
                status = res.code,
                fields = error?.get("fields")?.jsonObject?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap(),
            )
        }
    }

    private fun codeForStatus(status: Int): String = when (status) {
        401 -> "UNAUTHORIZED"
        403 -> "FORBIDDEN"
        404 -> "NOT_FOUND"
        409 -> "CONFLICT"
        413 -> "PAYLOAD_TOO_LARGE"
        422, 400 -> "VALIDATION_ERROR"
        429 -> "RATE_LIMITED"
        else -> "INTERNAL_ERROR"
    }

    private companion object {
        val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody("application/json".toMediaType())
    }
}

/** مساعد بناء أجسام الطلبات. */
fun jsonBody(block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(block)

fun JsonElement.stringOrNull(field: String): String? =
    (this as? JsonObject)?.get(field)?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }

fun buildQuery(vararg pairs: Pair<String, Any?>): Map<String, String?> =
    pairs.associate { (key, value) -> key to value?.toString() }
