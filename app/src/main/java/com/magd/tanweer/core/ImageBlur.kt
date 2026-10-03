package com.magd.tanweer.core

import android.graphics.Bitmap
import android.os.Build
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * الضباب في تنوير له محرّكان (Liquid Glass):
 *
 *   • أندرويد 12+ : `RenderEffect` — ضباب حقيقي على الـGPU.
 *   • أندرويد 6–11: ضباب بتمثيل منخفض الدقة ثم تكبير، على الـCPU (Box blur) — لذا
 *     نقلّل نصف القطر تلقائيًا في الأجهزة الضعيفة.
 *
 * في الحالتين الشكل واحد؛ ما يتغير هو الكلفة فقط، ولا تتغير هوية التطبيق.
 */
object BlurEngine {

    /** ضباب حقيقي متاح؟ */
    val supportsRenderEffect: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    /** نصف القطر المناسب لهذا الجهاز. */
    fun radiusFor(deviceReduceBlur: Boolean, requested: Float): Float =
        when {
            deviceReduceBlur -> 0f
            !supportsRenderEffect -> requested * 0.6f
            else -> requested
        }

    /**
     * ضباب تمثيل منخفض الدقة (Stack/Box) — يُستخدم على أندرويد 6–11 وللصور المصغّرة.
     * يعمل على نسخة مصغّرة ثم يكبّرها، فتبقى الكلفة صغيرة حتى على أجهزة ضعيفة.
     */
    fun blur(bitmap: Bitmap, radius: Int, downscale: Int = 4): Bitmap {
        if (radius <= 0) return bitmap
        val targetWidth = max(1, bitmap.width / downscale)
        val targetHeight = max(1, bitmap.height / downscale)
        val small = Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
        boxBlurInPlace(small, radius)
        val result = Bitmap.createScaledBitmap(small, bitmap.width, bitmap.height, true)
        if (small !== result) small.recycle()
        return result
    }

    /** Box blur أفقي ثم عمودي (قابل للفصل)، بتكلفة خطية. */
    fun boxBlurInPlace(bitmap: Bitmap, radius: Int) {
        if (radius <= 0) return
        val width = bitmap.width
        val height = bitmap.height
        if (width <= 1 || height <= 1) return

        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        val horizontal = IntArray(pixels.size)
        val window = radius * 2 + 1

        // أفقي
        for (y in 0 until height) {
            var r = 0; var g = 0; var b = 0
            val rowStart = y * width
            for (x in -radius..radius) {
                val sample = pixels[rowStart + clamp(x, 0, width - 1)]
                r += (sample shr 16) and 0xFF; g += (sample shr 8) and 0xFF; b += sample and 0xFF
            }
            for (x in 0 until width) {
                horizontal[rowStart + x] = (0xFF shl 24) or ((r / window) shl 16) or ((g / window) shl 8) or (b / window)
                val outIndex = clamp(x - radius, 0, width - 1)
                val inIndex = clamp(x + radius + 1, 0, width - 1)
                val outSample = pixels[rowStart + outIndex]
                val inSample = pixels[rowStart + inIndex]
                r += ((inSample shr 16) and 0xFF) - ((outSample shr 16) and 0xFF)
                g += ((inSample shr 8) and 0xFF) - ((outSample shr 8) and 0xFF)
                b += (inSample and 0xFF) - (outSample and 0xFF)
            }
        }

        // عمودي
        for (x in 0 until width) {
            var r = 0; var g = 0; var b = 0
            for (y in -radius..radius) {
                val sample = horizontal[clamp(y, 0, height - 1) * width + x]
                r += (sample shr 16) and 0xFF; g += (sample shr 8) and 0xFF; b += sample and 0xFF
            }
            for (y in 0 until height) {
                pixels[y * width + x] = (0xFF shl 24) or ((r / window) shl 16) or ((g / window) shl 8) or (b / window)
                val outSample = horizontal[clamp(y - radius, 0, height - 1) * width + x]
                val inSample = horizontal[clamp(y + radius + 1, 0, height - 1) * width + x]
                r += ((inSample shr 16) and 0xFF) - ((outSample shr 16) and 0xFF)
                g += ((inSample shr 8) and 0xFF) - ((outSample shr 8) and 0xFF)
                b += (inSample and 0xFF) - (outSample and 0xFF)
            }
        }

        bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
    }

    /** قوة الضباب بحسب ذاكرة الجهاز: الأجهزة الضعيفة تُظهر زجاجًا أنظف وأخف. */
    fun effectiveRadius(isLowRam: Boolean, reduceBlur: Boolean, requested: Float): Float =
        if (reduceBlur || isLowRam) 0f else radiusFor(false, requested)

    private fun clamp(value: Int, low: Int, high: Int): Int = min(max(value, low), high)

    /** استخدمه عند الحاجة لإخبار النظام أن العرض يهتم بالضباب. */
    fun attachRenderEffect(view: View, radius: Float) {
        if (!supportsRenderEffect) return
        val effect = android.graphics.RenderEffect.createBlurEffect(radius, radius, android.graphics.Shader.TileMode.CLAMP)
        view.setRenderEffect(effect)
    }
}
