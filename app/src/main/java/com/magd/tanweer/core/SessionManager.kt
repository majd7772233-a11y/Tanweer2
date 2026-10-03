package com.magd.tanweer.core

import android.content.Context
import android.os.Build
import com.magd.tanweer.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

sealed interface AuthState {
    /** قبل قراءة التخزين. */
    data object Unknown : AuthState

    /** لا يوجد حساب على هذا الجهاز. */
    data object SignedOut : AuthState

    /** حساب محفوظ لكن التحقق جارٍ. */
    data object Restoring : AuthState

    data class SignedIn(val user: User) : AuthState
}

/**
 * الجلسة: من يملك الرموز، ومن يحدّثها، ومتى نخرج.
 *
 * كل الرموز مشفّرة على الجهاز (Android Keystore)، وكلمة المرور لا تُخزَّن
 * إطلاقًا: عند الحاجة نشتق `authKey` من جديد من كلمة المرور التي يكتبها الطالب.
 */
class SessionManager(
    private val context: Context,
    private val store: SecureStore = SecureStore(context),
) {

    private val prefs = context.getSharedPreferences("tanweer_session", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow<AuthState>(AuthState.Unknown)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private val refreshMutex = Mutex()
    private var tokens: Tokens? = null
    private var user: User? = null

    val api: ApiClient = ApiClient(
        baseUrl = BuildConfig.API_BASE_URL,
        authToken = { tokens?.accessToken },
        onUnauthorized = { refreshTokens() != null },
    )

    val deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    val devicePayload: JsonObject
        get() = buildJsonObject {
            put("deviceId", deviceId)
            put("platform", "android")
            put("model", Build.MANUFACTURER + " " + Build.MODEL)
            put("appVersion", BuildConfig.VERSION_NAME)
            put("osVersion", "Android ${Build.VERSION.RELEASE}")
        }

    fun currentUser(): User? = user

    fun restore() {
        val stored = store.get(STORE_SESSION) ?: run {
            _state.value = AuthState.SignedOut
            return
        }
        _state.value = AuthState.Restoring
        val snapshot = runCatching { TanweerJson.decodeFromString(SessionSnapshot.serializer(), stored) }.getOrNull()
        if (snapshot == null) {
            _state.value = AuthState.SignedOut
            return
        }
        tokens = snapshot.tokens
        user = snapshot.user
        _state.value = AuthState.SignedIn(snapshot.user)
    }

    private fun persist() {
        val currentTokens = tokens ?: return
        val currentUser = user ?: return
        store.put(
            STORE_SESSION,
            TanweerJson.encodeToString(SessionSnapshot.serializer(), SessionSnapshot(currentTokens, currentUser)),
        )
    }

    // ── الدخول ────────────────────────────────────────────────────────────────

    suspend fun kdfParams(phone: String): KdfParams {
        val body = buildJsonObject { put("phone", Phone.normalize(phone)) }
        return decode(api.request("POST", "/api/v1/auth/kdf-params", body, authenticated = false), KdfParams.serializer())
    }

    suspend fun login(phone: String, password: String): User {
        val kdf = kdfParams(phone)
        val authKey = PasswordCrypto.deriveAuthKey(password, kdf.salt, kdf.iterations, kdf.keyLength)
        val body = buildJsonObject {
            put("phone", kdf.phone)
            put("authKey", authKey)
            put("device", devicePayload)
        }
        val result = decode(api.request("POST", "/api/v1/auth/login", body, authenticated = false), LoginResult.serializer())
        accept(result.user, result.tokens)
        return result.user
    }

    suspend fun register(
        phone: String,
        password: String,
        fullName: String,
        gradeId: Int,
        sectionCode: String,
        email: String?,
    ): RegisterResult {
        val kdf = kdfParams(phone)
        val authKey = PasswordCrypto.deriveAuthKey(password, kdf.salt, kdf.iterations, kdf.keyLength)
        val body = buildJsonObject {
            put("phone", kdf.phone)
            put("authKey", authKey)
            put("fullName", fullName)
            put("gradeId", gradeId)
            put("sectionCode", sectionCode)
            email?.takeIf { it.isNotBlank() }?.let { put("email", it) }
            put("device", devicePayload)
        }
        val result = decode(api.request("POST", "/api/v1/auth/register", body, authenticated = false), RegisterResult.serializer())
        accept(result.user, result.tokens)
        return result
    }

    suspend fun resetWithRecovery(phone: String, recoveryCode: String, newPassword: String): String {
        val kdf = kdfParams(phone)
        val authKey = PasswordCrypto.deriveAuthKey(newPassword, kdf.salt, kdf.iterations, kdf.keyLength)
        val body = buildJsonObject {
            put("phone", kdf.phone)
            put("recoveryCode", recoveryCode.trim().uppercase())
            put("newAuthKey", authKey)
            put("device", devicePayload)
        }
        val element = api.request("POST", "/api/v1/auth/recovery/reset", body, authenticated = false)
        return element.stringOrNull("recoveryCode") ?: ""
    }

    suspend fun changePassword(currentPassword: String, newPassword: String) {
        val phone = user?.let { storedPhone() } ?: return
        val current = kdfParams(phone).let { kdf ->
            PasswordCrypto.deriveAuthKey(currentPassword, kdf.salt, kdf.iterations, kdf.keyLength)
        }
        val next = kdfParams(phone).let { kdf ->
            PasswordCrypto.deriveAuthKey(newPassword, kdf.salt, kdf.iterations, kdf.keyLength)
        }
        val body = buildJsonObject {
            put("currentAuthKey", current)
            put("newAuthKey", next)
        }
        api.request("POST", "/api/v1/auth/password/change", body)
    }

    suspend fun logout() {
        runCatching { api.request("POST", "/api/v1/auth/logout", buildJsonObject { }) }
        tokens = null
        user = null
        store.clear()
        _state.value = AuthState.SignedOut
    }

    /** يُستدعى من `ApiClient` عند 401. يُرجع الرمز الجديد أو null. */
    suspend fun refreshTokens(): String? = refreshMutex.withLock {
        val current = tokens ?: return@withLock null
        val body = buildJsonObject { put("refreshToken", current.refreshToken) }
        val refreshed = runCatching {
            decode(api.request("POST", "/api/v1/auth/refresh", body, authenticated = false), RefreshResult.serializer())
        }.getOrNull()

        if (refreshed == null) {
            tokens = null
            user = null
            store.clear()
            _state.value = AuthState.SignedOut
            return@withLock null
        }
        accept(refreshed.user, refreshed.tokens)
        refreshed.tokens.accessToken
    }

    fun updateUser(transform: (User) -> User) {
        val current = user ?: return
        user = transform(current)
        persist()
        _state.value = AuthState.SignedIn(user!!)
    }

    private fun accept(newUser: User, newTokens: Tokens) {
        user = newUser
        tokens = newTokens
        persist()
        _state.value = AuthState.SignedIn(newUser)
    }

    private fun storedPhone(): String = store.get(STORE_PHONE) ?: ""

    /** يُستدعى بعد الدخول ليتذكر الطالب رقمه محليًا (لإعادة الاشتقاق فقط). */
    fun rememberPhone(phone: String) {
        store.put(STORE_PHONE, Phone.normalize(phone))
    }

    private fun <T> decode(element: JsonElement, serializer: kotlinx.serialization.KSerializer<T>): T =
        TanweerJson.decodeFromJsonElement(serializer, element)

    @kotlinx.serialization.Serializable
    private data class SessionSnapshot(val tokens: Tokens, val user: User)

    private companion object {
        const val STORE_SESSION = "session"
        const val STORE_PHONE = "phone"
        const val KEY_DEVICE_ID = "device_id"
    }
}

/** توحيد أرقام الهاتف (٩ أرقام تبدأ بـ7). */
object Phone {
    fun normalize(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return if (digits.length > 9) digits.takeLast(9) else digits
    }

    fun isValid(raw: String): Boolean {
        val phone = normalize(raw)
        return phone.length == 9 && phone.startsWith("7")
    }
}

/** قراءة حقل نصي من عنصر JSON بلا انفجار عند غيابه. */
fun JsonElement.field(name: String): String? = (this as? JsonObject)?.get(name)?.let {
    runCatching { it.jsonPrimitive.content }.getOrNull()
}
