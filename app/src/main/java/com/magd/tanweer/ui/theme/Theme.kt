package com.magd.tanweer.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp

/**
 * الهوية اللونية: **ليل دائم** (Midnight) + زجاج + ثلاث نبرات هادئة
 * (سماوي ناعم / أزرق بارد / كهرماني دافئ)، والأحمر محفوظ للاختبارات والتنبيهات.
 */
object TanweerColors {
    val Midnight = Color(0xFF070B14)
    val MidnightDeep = Color(0xFF04070D)
    val MidnightSoft = Color(0xFF0C1220)

    val GlassFill = Color(0x14FFFFFF)
    val GlassFillStrong = Color(0x22FFFFFF)
    val GlassBorder = Color(0x2EFFFFFF)
    val GlassHighlight = Color(0x38FFFFFF)

    val CyanSoft = Color(0xFF7FE3E8)
    val BlueCool = Color(0xFF6FA8FF)
    val AmberWarm = Color(0xFFFFC46B)
    val VioletSoft = Color(0xFFB39BFF)

    /** الأحمر لا يُستخدم إلا للاختبارات والتنبيهات. */
    val RedAlert = Color(0xFFFF5D6C)
    val GreenOk = Color(0xFF63E6A8)

    val TextPrimary = Color(0xFFEDF3FA)
    val TextSecondary = Color(0xFFA7B4C7)
    val TextMuted = Color(0xFF7183A0)

    /** لون المادة القادم من الخادم (اسم لون لا قيمة). */
    fun subjectColor(name: String?): Color = when (name) {
        "cyan" -> CyanSoft
        "blue" -> BlueCool
        "amber" -> AmberWarm
        "violet" -> VioletSoft
        "green" -> GreenOk
        "rose" -> RedAlert
        else -> TextSecondary
    }

    /** لون حالة التوثيق — ويُعرض دائمًا مع رمز ونص، لا لونًا فقط. */
    fun statusColor(status: String): Color = when (status) {
        "DOCUMENTED" -> GreenOk
        "NEEDS_CONTRIBUTION" -> AmberWarm
        "NOT_SCHOOL_DAY" -> TextMuted
        else -> TextSecondary
    }
}

/**
 * إعداد الزجاج كما يراه التطبيق في كل الشاشات. يقلّ الضباب في الأجهزة الضعيفة
 * أو حين يختار الطالب ذلك، **ويبقى الشكل والهوية كما هما**.
 */
data class GlassConfig(
    val blurRadius: Float = 18f,
    val surfaceAlpha: Float = 0.09f,
    val borderAlpha: Float = 0.18f,
    val animationsEnabled: Boolean = true,
    val highContrast: Boolean = false,
    val fontScale: Float = 1f,
)

val LocalGlassConfig = staticCompositionLocalOf { GlassConfig() }

private val TanweerTypography = Typography(
    displaySmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 38.sp),
    headlineSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 30.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 23.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 21.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 17.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 15.sp),
)

private val DarkScheme = darkColorScheme(
    primary = TanweerColors.CyanSoft,
    onPrimary = TanweerColors.MidnightDeep,
    secondary = TanweerColors.BlueCool,
    onSecondary = TanweerColors.MidnightDeep,
    tertiary = TanweerColors.AmberWarm,
    background = TanweerColors.Midnight,
    onBackground = TanweerColors.TextPrimary,
    surface = TanweerColors.MidnightSoft,
    onSurface = TanweerColors.TextPrimary,
    surfaceVariant = TanweerColors.MidnightSoft,
    onSurfaceVariant = TanweerColors.TextSecondary,
    error = TanweerColors.RedAlert,
    onError = TanweerColors.MidnightDeep,
    outline = TanweerColors.GlassBorder,
)

/**
 * تنوير داكن أولًا دائمًا، مهما كان إعداد النظام، والخط يكبر مع إعداد الطالب
 * دون أن تتغير النِسب (كل شيء بوحدات sp).
 */
@Composable
fun TanweerTheme(
    glass: GlassConfig = GlassConfig(),
    content: @Composable () -> Unit,
) {
    val systemDensity = LocalDensity.current
    val configuration = LocalConfiguration.current
    val scaledDensity = remember(systemDensity, configuration.densityDpi, glass.fontScale) {
        Density(configuration.densityDpi / 160f, systemDensity.fontScale * glass.fontScale)
    }

    CompositionLocalProvider(
        LocalGlassConfig provides glass,
        LocalDensity provides scaledDensity,
    ) {
        MaterialTheme(
            colorScheme = DarkScheme,
            typography = TanweerTypography,
            content = content,
        )
    }
}
