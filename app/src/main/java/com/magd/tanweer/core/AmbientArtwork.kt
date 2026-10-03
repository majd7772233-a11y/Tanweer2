package com.magd.tanweer.core

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader

/**
 * "ضوء محيط هادئ يتحرك ببطء" — جزء من هوية Liquid Glass.
 *
 * الرسم هنا هو المصدر الوحيد للخلفية: يستخدمه العرض الحيّ، وتستخدمه النسخة
 * المصغّرة التي تُضبَّب مرة واحدة لتظهر **خلف** البطاقات الزجاجية، فيبدو الزجاج
 * حقيقيًا على كل إصدارات أندرويد (12+ بضباب GPU، وما قبله بضباب تمثيل منخفض الدقة).
 */
object AmbientArtwork {

    private const val BASE = 0xFF070B14.toInt()
    private const val DEEP = 0xFF04070D.toInt()
    private const val CYAN = 0xFF7FE3E8.toInt()
    private const val BLUE = 0xFF6FA8FF.toInt()
    private const val AMBER = 0xFFFFC46B.toInt()

    /** يرسم الخلفية على أي Canvas (شاشة أو صورة مصغّرة). */
    fun draw(canvas: Canvas, width: Float, height: Float, phase: Float = 0f) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        paint.shader = LinearGradient(
            0f, 0f, 0f, height,
            intArrayOf(BASE, DEEP),
            floatArrayOf(0f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, width, height, paint)

        // هالة سماوية علوية تتحرك قليلًا
        val cyanX = width * (0.28f + 0.06f * kotlin.math.sin(phase))
        val cyanY = height * (0.12f + 0.04f * kotlin.math.cos(phase * 0.8f))
        paint.shader = RadialGradient(
            cyanX, cyanY, width * 0.75f,
            withAlpha(CYAN, 0.20f), Color.TRANSPARENT,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, width, height, paint)

        // هالة زرقاء باردة في الوسط
        val blueX = width * (0.75f + 0.05f * kotlin.math.cos(phase * 1.2f))
        val blueY = height * (0.45f + 0.06f * kotlin.math.sin(phase))
        paint.shader = RadialGradient(
            blueX, blueY, width * 0.7f,
            withAlpha(BLUE, 0.16f), Color.TRANSPARENT,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, width, height, paint)

        // لمسة كهرمانية دافئة قرب الأسفل
        val amberX = width * (0.4f + 0.08f * kotlin.math.sin(phase * 0.6f))
        val amberY = height * 0.92f
        paint.shader = RadialGradient(
            amberX, amberY, width * 0.6f,
            withAlpha(AMBER, 0.10f), Color.TRANSPARENT,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, width, height, paint)
    }

    /**
     * نسخة مصغّرة من الخلفية — هذه هي الصورة الواحدة التي تعرضها الشاشة
     * **وتُعرض خلف كل سطح زجاجي**، فلا يرسم التطبيق الخلفية مرتين بصورتين مختلفتين.
     */
    fun renderBitmap(width: Int, height: Int, downscale: Int = 5, phase: Float = 0f): Bitmap {
        val smallWidth = (width / downscale).coerceAtLeast(1)
        val smallHeight = (height / downscale).coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(smallWidth, smallHeight, Bitmap.Config.ARGB_8888)
        draw(Canvas(bitmap), smallWidth.toFloat(), smallHeight.toFloat(), phase)
        return bitmap
    }

    /** الصورة الجاهزة للعرض (مضبَّبة إن طُلب ذلك). */
    fun renderBlurredBitmap(width: Int, height: Int, radius: Int, downscale: Int = 5, phase: Float = 0f): Bitmap {
        val bitmap = renderBitmap(width, height, downscale, phase)
        return if (radius > 0) BlurEngine.blur(bitmap, radius, downscale = 2) else bitmap
    }

    private fun withAlpha(color: Int, alpha: Float): Int {
        val a = (alpha * 255).toInt().coerceIn(0, 255)
        return Color.argb(a, Color.red(color), Color.green(color), Color.blue(color))
    }
}
