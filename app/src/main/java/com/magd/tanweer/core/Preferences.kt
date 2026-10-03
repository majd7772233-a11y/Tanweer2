package com.magd.tanweer.core

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ImageQuality { HIGH, MEDIUM, LOW }

/**
 * كل خيارات الطالب في مكان واحد. تُقرأ متزامنًا (SharedPreferences) وتُعرض
 * كـ StateFlow حتى يعيد Compose رسم الشاشة فورًا عند التغيير.
 *
 * قرار مهم: **الأجهزة الضعيفة لا تفقد الهوية** — تتوقف الحركة ويقل الضباب،
 * ويبقى الشكل نفسه (Midnight + زجاج + هالات هادئة).
 */
data class Preferences(
    val highContrast: Boolean = false,
    val reduceBlur: Boolean = false,
    val reduceMotion: Boolean = false,
    val fontScale: Float = 1f,
    val dataSaver: Boolean = false,
    val imageQuality: ImageQuality = ImageQuality.MEDIUM,
    val wifiOnlySync: Boolean = false,
    val wifiOnlyBooks: Boolean = false,
    val autoplayVideo: Boolean = false,
    val autoCompress: Boolean = true,
    val quietFrom: String = "22:00",
    val quietTo: String = "06:00",
    val language: String = "ar",
    val notifyLessons: Boolean = true,
    val notifyHomeworks: Boolean = true,
    val notifyExams: Boolean = true,
    val notifyEvents: Boolean = true,
    val notifyIssues: Boolean = true,
    val notifyMessages: Boolean = true,
    val notifyContributions: Boolean = true,
    val notifySchedule: Boolean = true,
)

class PreferencesStore(context: Context) {

    private val prefs = context.getSharedPreferences("tanweer_prefs", Context.MODE_PRIVATE)
    private val lowRam = (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isLowRamDevice ?: false

    private val _state = MutableStateFlow(read())
    val state: StateFlow<Preferences> = _state.asStateFlow()

    private fun read(): Preferences {
        val defaults = Preferences(
            // الجهاز الضعيف يبدأ بتقليل الضباب والحركة، ويمكن للطالب تغيير ذلك.
            reduceBlur = lowRam || Build.VERSION.SDK_INT < Build.VERSION_CODES.S,
            reduceMotion = lowRam,
        )
        return Preferences(
            highContrast = prefs.getBoolean("high_contrast", defaults.highContrast),
            reduceBlur = prefs.getBoolean("reduce_blur", defaults.reduceBlur),
            reduceMotion = prefs.getBoolean("reduce_motion", defaults.reduceMotion),
            fontScale = prefs.getFloat("font_scale", defaults.fontScale),
            dataSaver = prefs.getBoolean("data_saver", defaults.dataSaver),
            imageQuality = runCatching { ImageQuality.valueOf(prefs.getString("image_quality", "MEDIUM")!!) }.getOrDefault(ImageQuality.MEDIUM),
            wifiOnlySync = prefs.getBoolean("wifi_only_sync", defaults.wifiOnlySync),
            wifiOnlyBooks = prefs.getBoolean("wifi_only_books", defaults.wifiOnlyBooks),
            autoplayVideo = prefs.getBoolean("autoplay_video", defaults.autoplayVideo),
            autoCompress = prefs.getBoolean("auto_compress", defaults.autoCompress),
            quietFrom = prefs.getString("quiet_from", defaults.quietFrom)!!,
            quietTo = prefs.getString("quiet_to", defaults.quietTo)!!,
            language = prefs.getString("language", defaults.language)!!,
            notifyLessons = prefs.getBoolean("notify_lessons", true),
            notifyHomeworks = prefs.getBoolean("notify_homeworks", true),
            notifyExams = prefs.getBoolean("notify_exams", true),
            notifyEvents = prefs.getBoolean("notify_events", true),
            notifyIssues = prefs.getBoolean("notify_issues", true),
            notifyMessages = prefs.getBoolean("notify_messages", true),
            notifyContributions = prefs.getBoolean("notify_contributions", true),
            notifySchedule = prefs.getBoolean("notify_schedule", true),
        )
    }

    fun update(transform: (Preferences) -> Preferences) {
        val next = transform(_state.value)
        prefs.edit()
            .putBoolean("high_contrast", next.highContrast)
            .putBoolean("reduce_blur", next.reduceBlur)
            .putBoolean("reduce_motion", next.reduceMotion)
            .putFloat("font_scale", next.fontScale)
            .putBoolean("data_saver", next.dataSaver)
            .putString("image_quality", next.imageQuality.name)
            .putBoolean("wifi_only_sync", next.wifiOnlySync)
            .putBoolean("wifi_only_books", next.wifiOnlyBooks)
            .putBoolean("autoplay_video", next.autoplayVideo)
            .putBoolean("auto_compress", next.autoCompress)
            .putString("quiet_from", next.quietFrom)
            .putString("quiet_to", next.quietTo)
            .putString("language", next.language)
            .putBoolean("notify_lessons", next.notifyLessons)
            .putBoolean("notify_homeworks", next.notifyHomeworks)
            .putBoolean("notify_exams", next.notifyExams)
            .putBoolean("notify_events", next.notifyEvents)
            .putBoolean("notify_issues", next.notifyIssues)
            .putBoolean("notify_messages", next.notifyMessages)
            .putBoolean("notify_contributions", next.notifyContributions)
            .putBoolean("notify_schedule", next.notifySchedule)
            .apply()
        _state.value = next
    }
}
