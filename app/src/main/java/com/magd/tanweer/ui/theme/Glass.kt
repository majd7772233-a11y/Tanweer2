package com.magd.tanweer.ui.theme

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.magd.tanweer.core.AmbientArtwork
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** الصورة المضبَّبة للخلفية المحيطة، تتقاسمها كل البطاقات في الشاشة. */
val LocalAmbientBackdrop = staticCompositionLocalOf<ImageBitmap?> { null }

/** موضع الخلفية المحيطة داخل الجذر، حتى تتحاذى البطاقات معها. */
val LocalAmbientOrigin = staticCompositionLocalOf { Offset.Zero }

/**
 * الخلفية الحيّة: ليل + ضوء محيط يتحرك ببطء (ويثبت في الأجهزة الضعيفة أو عند
 * تقليل الحركة) — ومعها نجّهز نسخة مضبَّبة مصغّرة تُعرض داخل كل سطح زجاجي.
 *
 * بهذا يبدو الزجاج حقيقيًا على أندرويد 6 أيضًا (ضباب تمثيل منخفض الدقة)،
 * بينما يستخدم أندرويد 12+ `RenderEffect` عند الحاجة.
 */
@Composable
fun AmbientBackground(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val glass = LocalGlassConfig.current
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val widthPx = with(density) { configuration.screenWidthDp.dp.roundToPx() }
    val heightPx = with(density) { configuration.screenHeightDp.dp.roundToPx() }

    val transition = rememberInfiniteTransition(label = "ambient")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = (2 * Math.PI).toFloat(),
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 90_000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "ambientPhase",
    )
    // حين يوقف الطالب الحركة، يبقى الضوء في مكانه لكن الهوية كما هي.
    val drawPhase = if (glass.animationsEnabled) phase else 0.5f

    var origin by remember { mutableStateOf(Offset.Zero) }
    var backdrop by remember { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(widthPx, heightPx, glass.blurRadius) {
        backdrop = withContext(Dispatchers.Default) {
            val radius = if (glass.blurRadius <= 0f) 0 else (glass.blurRadius / 3f).toInt().coerceAtLeast(1)
            AmbientArtwork.renderBlurredBitmap(widthPx, heightPx, radius).asImageBitmap()
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .onGloballyPositioned { origin = it.positionInRoot() },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            AmbientArtwork.draw(drawContext.canvas, size.width, size.height, drawPhase)
        }
        CompositionLocalProvider(
            LocalAmbientBackdrop provides backdrop,
            LocalAmbientOrigin provides origin,
        ) {
            content()
        }
    }
}

/**
 * السطح الزجاجي: تعبئة شبه شفافة + حد رقيق، ومن خلفه الضوء المحيط — مضبَّبًا
 * عند توفّر الضباب، ونظيفًا (خفيفًا) عند إيقافه. الشكل لا يتغير.
 */
@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(24.dp),
    strong: Boolean = false,
    padding: PaddingValues = PaddingValues(16.dp),
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val glass = LocalGlassConfig.current
    val backdrop = LocalAmbientBackdrop.current
    val ambientOrigin = LocalAmbientOrigin.current
    var ownOrigin by remember { mutableStateOf(Offset.Zero) }

    val fill = if (strong) TanweerColors.GlassFillStrong else TanweerColors.GlassFill
    val borderColor = TanweerColors.GlassBorder.copy(
        alpha = if (glass.highContrast) (glass.borderAlpha + 0.3f).coerceAtMost(0.85f) else glass.borderAlpha,
    )
    val sliceAlpha = if (glass.highContrast) 0.9f else 0.72f

    val sliceModifier = if (backdrop != null && glass.blurRadius > 0f) {
        Modifier.ambientSlice(backdrop, ambientOrigin, ownOrigin, sliceAlpha)
    } else {
        Modifier
    }

    Column(
        modifier = modifier
            .onGloballyPositioned { ownOrigin = it.positionInRoot() }
            .clip(shape)
            .background(
                Brush.verticalGradient(
                    listOf(
                        fill.copy(alpha = fill.alpha + 0.05f),
                        fill,
                    ),
                ),
            )
            .then(sliceModifier)
            .border(1.dp, borderColor, shape)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
            .padding(padding),
        content = content,
    )
}

private fun Modifier.ambientSlice(
    backdrop: ImageBitmap,
    ambientOrigin: Offset,
    ownOrigin: Offset,
    alpha: Float,
): Modifier = this.drawBehind {
    val dx = (ambientOrigin.x - ownOrigin.x).toInt()
    val dy = (ambientOrigin.y - ownOrigin.y).toInt()
    if (dx < 0 || dy < 0 || dx >= backdrop.width || dy >= backdrop.height) return@drawBehind

    val width = minOf(size.width.toInt(), backdrop.width - dx)
    val height = minOf(size.height.toInt(), backdrop.height - dy)
    if (width <= 0 || height <= 0) return@drawBehind

    drawImage(
        image = backdrop,
        srcOffset = IntOffset(dx, dy),
        srcSize = IntSize(width, height),
        dstOffset = IntOffset.Zero,
        dstSize = IntSize(size.width.toInt(), size.height.toInt()),
        alpha = alpha,
        filterQuality = FilterQuality.Low,
    )
}

/** شريط علوي زجاجي موحّد. */
@Composable
fun GlassTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    GlassSurface(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        shape = RoundedCornerShape(22.dp),
        padding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleLarge, color = TanweerColors.TextPrimary)
                subtitle?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = TanweerColors.TextMuted)
                }
            }
            trailing?.invoke()
        }
    }
}

/** ورقة سفلية زجاجية — نفس لغة الزجاج في كل مكان. */
@Composable
fun GlassSheet(
    shape: Shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    GlassSurface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        strong = true,
        padding = PaddingValues(20.dp),
        content = content,
    )
}
