package com.najvaa.app.ui.components

import android.graphics.Paint
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.random.Random

/**
 * Particles of one veil, struct-of-arrays so a frame allocates nothing.
 * Positions are in text-layout coordinates; dx/dy are the drift direction.
 */
private class Particles(n: Int) {
    val x = FloatArray(n)
    val y = FloatArray(n)
    val dx = FloatArray(n)
    val dy = FloatArray(n)
    val phase = FloatArray(n)
    val speed = FloatArray(n)
    val band = IntArray(n)
    val count = n
    /** Per band, the points to draw this frame (x0, y0, x1, y1, ...). */
    val out = Array(3) { FloatArray(n * 2) }
    val outLen = IntArray(3)
}

private val EmptyParticles = Particles(0)

/**
 * Text hidden under drifting particles, like Telegram's spoiler. While
 * [reveal] goes 0 -> 1 a circle grows from [origin] (where the finger rests)
 * and shows the real text inside it; the particles stay outside the circle.
 * Particles are spawned only over the laid-out lines, so the veil keeps the
 * shape of the message without giving away a single letter.
 *
 * Cheap on purpose: a chat shows many of these at once. The animation is read
 * only in the draw phase (no recomposition), particles are sparse, and points
 * go straight to the native canvas from preallocated arrays.
 */
@Composable
fun VeiledText(
    text: AnnotatedString,
    style: TextStyle,
    color: Color,
    veiled: Boolean,
    reveal: () -> Float,
    origin: Offset?,
    modifier: Modifier = Modifier,
    inline: Map<String, InlineTextContent> = emptyMap(),
) {
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val density = LocalDensity.current.density
    val parts = remember(layout, veiled) {
        val l = layout
        if (l == null || !veiled) return@remember EmptyParticles
        val rnd = Random(text.text.hashCode())
        val perLine = IntArray(l.lineCount) { line ->
            val w = abs(l.getLineRight(line) - l.getLineLeft(line))
            val h = l.getLineBottom(line) - l.getLineTop(line)
            (w * h / (density * density * 15f)).toInt().coerceIn(3, 420)
        }
        val p = Particles(perLine.sum().coerceAtMost(1400))
        var i = 0
        for (line in 0 until l.lineCount) {
            val left = minOf(l.getLineLeft(line), l.getLineRight(line))
            val w = abs(l.getLineRight(line) - l.getLineLeft(line))
            val top = l.getLineTop(line)
            val h = l.getLineBottom(line) - top
            repeat(perLine[line]) {
                if (i >= p.count) return@repeat
                val a = rnd.nextFloat() * 2f * PI.toFloat()
                p.x[i] = left + rnd.nextFloat() * w
                p.y[i] = top + h * (0.15f + 0.7f * rnd.nextFloat())
                p.dx[i] = cos(a)
                p.dy[i] = sin(a)
                p.phase[i] = rnd.nextFloat()
                p.speed[i] = 0.6f + rnd.nextFloat() * 0.9f
                p.band[i] = rnd.nextInt(3)
                i++
            }
        }
        p
    }
    val t = if (veiled) {
        rememberInfiniteTransition(label = "veil").animateFloat(0f, 1f, infiniteRepeatable(tween(6000, easing = LinearEasing), RepeatMode.Restart), label = "veilT")
    } else null
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND } }

    Text(
        text, style = style, color = color, inlineContent = inline,
        onTextLayout = { layout = it },
        modifier = modifier.drawWithContent {
            val rv = reveal()
            if (!veiled || rv >= 0.999f || parts.count == 0) {
                drawContent()
                return@drawWithContent
            }
            val time = t?.value ?: 0f
            val o = origin ?: Offset(size.width / 2f, size.height / 2f)
            val r = rv * hypot(size.width, size.height)
            if (r > 0.5f) {
                val circle = Path().apply { addOval(Rect(o, r)) }
                clipPath(circle) { this@drawWithContent.drawContent() }
            }
            val amp = 2.2f * density
            val tau = 2f * PI.toFloat()
            val r2 = r * r
            parts.outLen.fill(0)
            for (i in 0 until parts.count) {
                val s = sin((time * parts.speed[i] * 6f + parts.phase[i]) * tau) * amp
                val x = parts.x[i] + parts.dx[i] * s
                val y = parts.y[i] + parts.dy[i] * s
                if (r > 0f) { val ex = x - o.x; val ey = y - o.y; if (ex * ex + ey * ey < r2) continue }
                val b = parts.band[i]
                val arr = parts.out[b]
                var n = parts.outLen[b]
                arr[n++] = x; arr[n++] = y
                parts.outLen[b] = n
            }
            paint.strokeWidth = 1.6f * density
            drawIntoCanvas { canvas ->
                for (b in 0 until 3) {
                    val n = parts.outLen[b]
                    if (n == 0) continue
                    val alpha = when (b) { 0 -> 0.95f; 1 -> 0.6f; else -> 0.32f } * (0.75f + 0.25f * sin((time * 4f + b / 3f) * tau))
                    paint.color = color.copy(alpha = alpha.coerceIn(0.15f, 1f)).toArgb()
                    canvas.nativeCanvas.drawPoints(parts.out[b], 0, n, paint)
                }
            }
        },
    )
}
