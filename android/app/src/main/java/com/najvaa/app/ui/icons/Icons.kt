package com.najvaa.app.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * A rounded 24dp stroke icon set drawn for this app (2dp strokes, round
 * caps), so the chrome does not look like stock Material. Everything is a
 * vector: no bitmaps, no icon font.
 */
object NajvaaIcons {

    private fun stroke(name: String, fill: Boolean = false, builder: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            path(
                fill = if (fill) SolidColor(Color.Black) else null,
                stroke = if (fill) null else SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathFillType = PathFillType.NonZero,
                pathBuilder = builder,
            )
        }.build()

    private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
        moveTo(cx + r, cy)
        arcTo(r, r, 0f, true, true, cx - r, cy)
        arcTo(r, r, 0f, true, true, cx + r, cy)
        close()
    }

    val Back: ImageVector by lazy { stroke("back") { moveTo(9f, 5f); lineTo(16f, 12f); lineTo(9f, 19f) } }
    val Forward: ImageVector by lazy { stroke("forward") { moveTo(15f, 5f); lineTo(8f, 12f); lineTo(15f, 19f) } }
    val Close: ImageVector by lazy { stroke("close") { moveTo(6f, 6f); lineTo(18f, 18f); moveTo(18f, 6f); lineTo(6f, 18f) } }
    val Plus: ImageVector by lazy { stroke("plus") { moveTo(12f, 5f); lineTo(12f, 19f); moveTo(5f, 12f); lineTo(19f, 12f) } }
    val Check: ImageVector by lazy { stroke("check") { moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 7f) } }
    val DoubleCheck: ImageVector by lazy { stroke("dcheck") { moveTo(2f, 12.5f); lineTo(6.5f, 17f); lineTo(14f, 8f); moveTo(9f, 15f); lineTo(11f, 17f); lineTo(21f, 7f) } }
    val Clock: ImageVector by lazy { stroke("clock") { circle(12f, 12f, 8.5f); moveTo(12f, 7.5f); lineTo(12f, 12f); lineTo(15f, 14f) } }
    val Timer: ImageVector by lazy { stroke("timer") { circle(12f, 13f, 7.5f); moveTo(12f, 9.5f); lineTo(12f, 13f); lineTo(14.5f, 14.5f); moveTo(9.5f, 3f); lineTo(14.5f, 3f) } }
    val Lock: ImageVector by lazy {
        stroke("lock") { moveTo(7f, 11f); lineTo(17f, 11f); arcTo(2f, 2f, 0f, false, true, 19f, 13f); lineTo(19f, 19f); arcTo(2f, 2f, 0f, false, true, 17f, 21f); lineTo(7f, 21f); arcTo(2f, 2f, 0f, false, true, 5f, 19f); lineTo(5f, 13f); arcTo(2f, 2f, 0f, false, true, 7f, 11f); close(); moveTo(8f, 11f); lineTo(8f, 7.5f); arcTo(4f, 4f, 0f, false, true, 16f, 7.5f); lineTo(16f, 11f) }
    }
    val LockOpen: ImageVector by lazy {
        stroke("lockopen") { moveTo(7f, 11f); lineTo(17f, 11f); arcTo(2f, 2f, 0f, false, true, 19f, 13f); lineTo(19f, 19f); arcTo(2f, 2f, 0f, false, true, 17f, 21f); lineTo(7f, 21f); arcTo(2f, 2f, 0f, false, true, 5f, 19f); lineTo(5f, 13f); arcTo(2f, 2f, 0f, false, true, 7f, 11f); close(); moveTo(8f, 11f); lineTo(8f, 7.5f); arcTo(4f, 4f, 0f, false, true, 15.5f, 5.5f) }
    }
    val Fingerprint: ImageVector by lazy {
        stroke("finger") {
            moveTo(6f, 9f); arcTo(7f, 7f, 0f, false, true, 18f, 9f)
            moveTo(4.5f, 13f); arcTo(8f, 8f, 0f, false, true, 19.5f, 13f)
            moveTo(8f, 12.5f); arcTo(4f, 4f, 0f, false, true, 16f, 12.5f); lineTo(16f, 15f); arcTo(4f, 4f, 0f, false, true, 12f, 19f)
            moveTo(12f, 12.5f); lineTo(12f, 15f); arcTo(2f, 2f, 0f, false, false, 15f, 17f)
            moveTo(8f, 16f); arcTo(5f, 5f, 0f, false, false, 10f, 20f)
        }
    }
    val Shield: ImageVector by lazy { stroke("shield") { moveTo(12f, 3f); lineTo(19f, 6f); lineTo(19f, 11f); curveTo(19f, 16f, 15.5f, 19.5f, 12f, 21f); curveTo(8.5f, 19.5f, 5f, 16f, 5f, 11f); lineTo(5f, 6f); close(); moveTo(9f, 12f); lineTo(11f, 14f); lineTo(15f, 10f) } }
    val Eye: ImageVector by lazy { stroke("eye") { moveTo(2.5f, 12f); curveTo(5f, 7f, 8.5f, 5f, 12f, 5f); curveTo(15.5f, 5f, 19f, 7f, 21.5f, 12f); curveTo(19f, 17f, 15.5f, 19f, 12f, 19f); curveTo(8.5f, 19f, 5f, 17f, 2.5f, 12f); close(); circle(12f, 12f, 3f) } }
    val EyeOff: ImageVector by lazy { stroke("eyeoff") { moveTo(3f, 3f); lineTo(21f, 21f); moveTo(10f, 10.2f); arcTo(3f, 3f, 0f, false, false, 13.8f, 14f); moveTo(6.6f, 6.8f); curveTo(5f, 8f, 3.6f, 9.7f, 2.5f, 12f); curveTo(5f, 17f, 8.5f, 19f, 12f, 19f); curveTo(13.6f, 19f, 15.2f, 18.6f, 16.7f, 17.8f); moveTo(9.5f, 5.4f); curveTo(10.3f, 5.1f, 11.1f, 5f, 12f, 5f); curveTo(15.5f, 5f, 19f, 7f, 21.5f, 12f); curveTo(20.8f, 13.4f, 20f, 14.5f, 19.1f, 15.4f) } }
    val Copy: ImageVector by lazy { stroke("copy") { moveTo(9f, 9f); lineTo(18f, 9f); arcTo(2f, 2f, 0f, false, true, 20f, 11f); lineTo(20f, 19f); arcTo(2f, 2f, 0f, false, true, 18f, 21f); lineTo(11f, 21f); arcTo(2f, 2f, 0f, false, true, 9f, 19f); close(); moveTo(6f, 15f); lineTo(5f, 15f); arcTo(2f, 2f, 0f, false, true, 3f, 13f); lineTo(3f, 5f); arcTo(2f, 2f, 0f, false, true, 5f, 3f); lineTo(13f, 3f); arcTo(2f, 2f, 0f, false, true, 15f, 5f); lineTo(15f, 6f) } }
    val Share: ImageVector by lazy { stroke("share") { circle(18f, 5f, 2.5f); circle(6f, 12f, 2.5f); circle(18f, 19f, 2.5f); moveTo(8.2f, 10.8f); lineTo(15.8f, 6.3f); moveTo(8.2f, 13.2f); lineTo(15.8f, 17.7f) } }
    val Send: ImageVector by lazy { stroke("send", fill = true) { moveTo(3f, 11.5f); lineTo(20.5f, 3.5f); lineTo(14f, 21f); lineTo(11f, 13.5f); close() } }
    val Mic: ImageVector by lazy { stroke("mic") { moveTo(12f, 3f); arcTo(3f, 3f, 0f, false, true, 15f, 6f); lineTo(15f, 12f); arcTo(3f, 3f, 0f, false, true, 9f, 12f); lineTo(9f, 6f); arcTo(3f, 3f, 0f, false, true, 12f, 3f); close(); moveTo(5.5f, 11f); arcTo(6.5f, 6.5f, 0f, false, false, 18.5f, 11f); moveTo(12f, 17.5f); lineTo(12f, 21f); moveTo(9f, 21f); lineTo(15f, 21f) } }
    val Attach: ImageVector by lazy { stroke("attach") { moveTo(20f, 11.5f); lineTo(12.5f, 19f); arcTo(5f, 5f, 0f, false, true, 5.5f, 12f); lineTo(13f, 4.5f); arcTo(3.3f, 3.3f, 0f, false, true, 17.7f, 9.2f); lineTo(10.2f, 16.7f); arcTo(1.6f, 1.6f, 0f, false, true, 7.9f, 14.4f); lineTo(14.5f, 7.8f) } }
    val Image: ImageVector by lazy { stroke("image") { moveTo(5f, 3.5f); lineTo(19f, 3.5f); arcTo(2f, 2f, 0f, false, true, 21f, 5.5f); lineTo(21f, 18.5f); arcTo(2f, 2f, 0f, false, true, 19f, 20.5f); lineTo(5f, 20.5f); arcTo(2f, 2f, 0f, false, true, 3f, 18.5f); lineTo(3f, 5.5f); arcTo(2f, 2f, 0f, false, true, 5f, 3.5f); close(); circle(8.5f, 8.5f, 1.8f); moveTo(21f, 15f); lineTo(16f, 10f); lineTo(6f, 20f) } }
    val Video: ImageVector by lazy { stroke("video") { moveTo(4f, 6f); lineTo(14f, 6f); arcTo(2f, 2f, 0f, false, true, 16f, 8f); lineTo(16f, 16f); arcTo(2f, 2f, 0f, false, true, 14f, 18f); lineTo(4f, 18f); arcTo(2f, 2f, 0f, false, true, 2f, 16f); lineTo(2f, 8f); arcTo(2f, 2f, 0f, false, true, 4f, 6f); close(); moveTo(16f, 10.5f); lineTo(22f, 7.5f); lineTo(22f, 16.5f); lineTo(16f, 13.5f) } }
    val File: ImageVector by lazy { stroke("file") { moveTo(7f, 3f); lineTo(14f, 3f); lineTo(19f, 8f); lineTo(19f, 19f); arcTo(2f, 2f, 0f, false, true, 17f, 21f); lineTo(7f, 21f); arcTo(2f, 2f, 0f, false, true, 5f, 19f); lineTo(5f, 5f); arcTo(2f, 2f, 0f, false, true, 7f, 3f); close(); moveTo(14f, 3f); lineTo(14f, 8f); lineTo(19f, 8f); moveTo(9f, 13f); lineTo(15f, 13f); moveTo(9f, 17f); lineTo(13f, 17f) } }
    val Music: ImageVector by lazy { stroke("music") { moveTo(9f, 18f); lineTo(9f, 5f); lineTo(20f, 3f); lineTo(20f, 16f); circle(6.5f, 18f, 2.5f); circle(17.5f, 16f, 2.5f) } }
    val Play: ImageVector by lazy { stroke("play", fill = true) { moveTo(7f, 4.5f); lineTo(19.5f, 12f); lineTo(7f, 19.5f); close() } }
    val Pause: ImageVector by lazy { stroke("pause", fill = true) { moveTo(6f, 4.5f); lineTo(10f, 4.5f); lineTo(10f, 19.5f); lineTo(6f, 19.5f); close(); moveTo(14f, 4.5f); lineTo(18f, 4.5f); lineTo(18f, 19.5f); lineTo(14f, 19.5f); close() } }
    val Download: ImageVector by lazy { stroke("download") { moveTo(12f, 3.5f); lineTo(12f, 15f); moveTo(7.5f, 10.5f); lineTo(12f, 15f); lineTo(16.5f, 10.5f); moveTo(4f, 17f); lineTo(4f, 19f); arcTo(1.5f, 1.5f, 0f, false, false, 5.5f, 20.5f); lineTo(18.5f, 20.5f); arcTo(1.5f, 1.5f, 0f, false, false, 20f, 19f); lineTo(20f, 17f) } }
    val Settings: ImageVector by lazy { stroke("settings") { circle(12f, 12f, 3f); moveTo(12f, 2.5f); lineTo(13.8f, 4.6f); lineTo(16.5f, 3.7f); lineTo(17.3f, 6.4f); lineTo(20.1f, 7f); lineTo(19.4f, 9.7f); lineTo(21.5f, 12f); lineTo(19.4f, 14.3f); lineTo(20.1f, 17f); lineTo(17.3f, 17.6f); lineTo(16.5f, 20.3f); lineTo(13.8f, 19.4f); lineTo(12f, 21.5f); lineTo(10.2f, 19.4f); lineTo(7.5f, 20.3f); lineTo(6.7f, 17.6f); lineTo(3.9f, 17f); lineTo(4.6f, 14.3f); lineTo(2.5f, 12f); lineTo(4.6f, 9.7f); lineTo(3.9f, 7f); lineTo(6.7f, 6.4f); lineTo(7.5f, 3.7f); lineTo(10.2f, 4.6f); close() } }
    val Bell: ImageVector by lazy { stroke("bell") { moveTo(6f, 16.5f); lineTo(6f, 10.5f); arcTo(6f, 6f, 0f, false, true, 18f, 10.5f); lineTo(18f, 16.5f); lineTo(20f, 18.5f); lineTo(4f, 18.5f); close(); moveTo(10f, 21f); arcTo(2f, 2f, 0f, false, false, 14f, 21f); moveTo(12f, 2.5f); lineTo(12f, 4.5f) } }
    val BellOff: ImageVector by lazy { stroke("belloff") { moveTo(3f, 3f); lineTo(21f, 21f); moveTo(6f, 16.5f); lineTo(6f, 10.5f); curveTo(6f, 9.4f, 6.3f, 8.4f, 6.8f, 7.5f); moveTo(9.5f, 5.1f); curveTo(10.3f, 4.7f, 11.1f, 4.5f, 12f, 4.5f); arcTo(6f, 6f, 0f, false, true, 18f, 10.5f); lineTo(18f, 14.5f); moveTo(20f, 18.5f); lineTo(4f, 18.5f); lineTo(6f, 16.5f); moveTo(10f, 21f); arcTo(2f, 2f, 0f, false, false, 14f, 21f) } }
    val Trash: ImageVector by lazy { stroke("trash") { moveTo(4f, 7f); lineTo(20f, 7f); moveTo(9f, 7f); lineTo(9f, 4.5f); lineTo(15f, 4.5f); lineTo(15f, 7f); moveTo(6f, 7f); lineTo(7f, 20f); lineTo(17f, 20f); lineTo(18f, 7f); moveTo(10f, 11f); lineTo(10f, 16.5f); moveTo(14f, 11f); lineTo(14f, 16.5f) } }
    val Pin: ImageVector by lazy { stroke("pin") { moveTo(9f, 3.5f); lineTo(15f, 3.5f); lineTo(15f, 9f); lineTo(18f, 13f); lineTo(6f, 13f); lineTo(9f, 9f); close(); moveTo(12f, 13f); lineTo(12f, 21f) } }
    val Search: ImageVector by lazy { stroke("search") { circle(10.5f, 10.5f, 6.5f); moveTo(15.5f, 15.5f); lineTo(21f, 21f) } }
    val More: ImageVector by lazy { stroke("more", fill = true) { circle(12f, 5f, 1.8f); circle(12f, 12f, 1.8f); circle(12f, 19f, 1.8f) } }
    val Reply: ImageVector by lazy { stroke("reply") { moveTo(9f, 7f); lineTo(4f, 12f); lineTo(9f, 17f); moveTo(4f, 12f); lineTo(14f, 12f); arcTo(6f, 6f, 0f, false, true, 20f, 18f); lineTo(20f, 19f) } }
    val Edit: ImageVector by lazy { stroke("edit") { moveTo(4f, 20f); lineTo(8f, 19f); lineTo(19f, 8f); lineTo(16f, 5f); lineTo(5f, 16f); close(); moveTo(14f, 7f); lineTo(17f, 10f) } }
    val Key: ImageVector by lazy { stroke("key") { circle(8f, 15f, 4f); moveTo(10.8f, 12.2f); lineTo(19.5f, 3.5f); moveTo(16f, 7f); lineTo(19f, 10f); moveTo(13.5f, 9.5f); lineTo(15.5f, 11.5f) } }
    val Refresh: ImageVector by lazy { stroke("refresh") { moveTo(20f, 12f); arcTo(8f, 8f, 0f, true, true, 17.6f, 6.3f); moveTo(20f, 3.5f); lineTo(20f, 8f); lineTo(15.5f, 8f) } }
    val Link: ImageVector by lazy { stroke("link") { moveTo(10f, 14f); arcTo(4f, 4f, 0f, false, false, 15.5f, 14.2f); lineTo(18.5f, 11.2f); arcTo(4f, 4f, 0f, false, false, 12.8f, 5.5f); lineTo(11.5f, 6.8f); moveTo(14f, 10f); arcTo(4f, 4f, 0f, false, false, 8.5f, 9.8f); lineTo(5.5f, 12.8f); arcTo(4f, 4f, 0f, false, false, 11.2f, 18.5f); lineTo(12.5f, 17.2f) } }
    val WifiOff: ImageVector by lazy { stroke("wifioff") { moveTo(3f, 3f); lineTo(21f, 21f); moveTo(2f, 9f); curveTo(4f, 7.3f, 6.2f, 6.1f, 8.6f, 5.5f); moveTo(13f, 5.2f); curveTo(16.4f, 5.6f, 19.5f, 7f, 22f, 9f); moveTo(5.5f, 12.5f); curveTo(6.8f, 11.4f, 8.3f, 10.6f, 9.9f, 10.2f); moveTo(15f, 10.5f); curveTo(16.3f, 11f, 17.5f, 11.7f, 18.5f, 12.5f); moveTo(9f, 16f); curveTo(10.8f, 14.7f, 13.2f, 14.7f, 15f, 16f); circle(12f, 19f, 1f) } }
    val Phone: ImageVector by lazy { stroke("phone") { moveTo(8f, 2.5f); lineTo(16f, 2.5f); arcTo(2f, 2f, 0f, false, true, 18f, 4.5f); lineTo(18f, 19.5f); arcTo(2f, 2f, 0f, false, true, 16f, 21.5f); lineTo(8f, 21.5f); arcTo(2f, 2f, 0f, false, true, 6f, 19.5f); lineTo(6f, 4.5f); arcTo(2f, 2f, 0f, false, true, 8f, 2.5f); close(); moveTo(10.5f, 18.5f); lineTo(13.5f, 18.5f) } }
    val Laptop: ImageVector by lazy { stroke("laptop") { moveTo(5f, 5f); lineTo(19f, 5f); arcTo(1.5f, 1.5f, 0f, false, true, 20.5f, 6.5f); lineTo(20.5f, 16f); lineTo(3.5f, 16f); lineTo(3.5f, 6.5f); arcTo(1.5f, 1.5f, 0f, false, true, 5f, 5f); close(); moveTo(2f, 19f); lineTo(22f, 19f) } }
    val Info: ImageVector by lazy { stroke("info") { circle(12f, 12f, 9f); moveTo(12f, 11f); lineTo(12f, 16.5f); moveTo(12f, 7.8f); lineTo(12f, 8f) } }
    val Warning: ImageVector by lazy { stroke("warn") { moveTo(12f, 3.5f); lineTo(21.5f, 20f); lineTo(2.5f, 20f); close(); moveTo(12f, 9.5f); lineTo(12f, 14f); moveTo(12f, 17f); lineTo(12f, 17.2f) } }
    val Sound: ImageVector by lazy { stroke("sound") { moveTo(4f, 9.5f); lineTo(7.5f, 9.5f); lineTo(12f, 5.5f); lineTo(12f, 18.5f); lineTo(7.5f, 14.5f); lineTo(4f, 14.5f); close(); moveTo(15.5f, 9f); curveTo(17f, 10.5f, 17f, 13.5f, 15.5f, 15f); moveTo(18.2f, 6.3f); curveTo(21.3f, 9.5f, 21.3f, 14.5f, 18.2f, 17.7f) } }
    val Vibrate: ImageVector by lazy { stroke("vibrate") { moveTo(9f, 4f); lineTo(15f, 4f); arcTo(1.5f, 1.5f, 0f, false, true, 16.5f, 5.5f); lineTo(16.5f, 18.5f); arcTo(1.5f, 1.5f, 0f, false, true, 15f, 20f); lineTo(9f, 20f); arcTo(1.5f, 1.5f, 0f, false, true, 7.5f, 18.5f); lineTo(7.5f, 5.5f); arcTo(1.5f, 1.5f, 0f, false, true, 9f, 4f); close(); moveTo(3.5f, 8f); lineTo(3.5f, 16f); moveTo(20.5f, 8f); lineTo(20.5f, 16f); moveTo(1f, 10f); lineTo(1f, 14f); moveTo(23f, 10f); lineTo(23f, 14f) } }
    val Palette: ImageVector by lazy { stroke("palette") { moveTo(12f, 3f); curveTo(7f, 3f, 3f, 7f, 3f, 12f); curveTo(3f, 17f, 7f, 21f, 12f, 21f); curveTo(13.5f, 21f, 14.5f, 20f, 14f, 18.5f); curveTo(13.5f, 17f, 14.5f, 16f, 16f, 16f); lineTo(18f, 16f); curveTo(19.7f, 16f, 21f, 14.7f, 21f, 13f); curveTo(21f, 7.5f, 17f, 3f, 12f, 3f); close(); circle(7.5f, 12f, 1.3f); circle(10f, 7.8f, 1.3f); circle(15f, 7.8f, 1.3f); circle(17.5f, 11.5f, 1.3f) } }
    val Heart: ImageVector by lazy { stroke("heart") { moveTo(12f, 20f); curveTo(7f, 16f, 3f, 12.5f, 3f, 8.5f); arcTo(4.5f, 4.5f, 0f, false, true, 12f, 7f); arcTo(4.5f, 4.5f, 0f, false, true, 21f, 8.5f); curveTo(21f, 12.5f, 17f, 16f, 12f, 20f); close() } }
    val Emoji: ImageVector by lazy { stroke("emoji") { circle(12f, 12f, 9f); moveTo(8f, 14f); curveTo(9f, 16f, 15f, 16f, 16f, 14f); moveTo(9f, 9.5f); lineTo(9f, 9.7f); moveTo(15f, 9.5f); lineTo(15f, 9.7f) } }
    val Logout: ImageVector by lazy { stroke("logout") { moveTo(10f, 4f); lineTo(5.5f, 4f); arcTo(1.5f, 1.5f, 0f, false, false, 4f, 5.5f); lineTo(4f, 18.5f); arcTo(1.5f, 1.5f, 0f, false, false, 5.5f, 20f); lineTo(10f, 20f); moveTo(9f, 12f); lineTo(20f, 12f); moveTo(16.5f, 8f); lineTo(20.5f, 12f); lineTo(16.5f, 16f) } }
    val Keyboard: ImageVector by lazy { stroke("keyboard") { moveTo(4f, 6f); lineTo(20f, 6f); arcTo(1.5f, 1.5f, 0f, false, true, 21.5f, 7.5f); lineTo(21.5f, 16.5f); arcTo(1.5f, 1.5f, 0f, false, true, 20f, 18f); lineTo(4f, 18f); arcTo(1.5f, 1.5f, 0f, false, true, 2.5f, 16.5f); lineTo(2.5f, 7.5f); arcTo(1.5f, 1.5f, 0f, false, true, 4f, 6f); close(); moveTo(7f, 10f); lineTo(7.2f, 10f); moveTo(11f, 10f); lineTo(11.2f, 10f); moveTo(15f, 10f); lineTo(15.2f, 10f); moveTo(8f, 14.5f); lineTo(16f, 14.5f) } }
    val Chat: ImageVector by lazy { stroke("chat") { moveTo(12f, 4f); curveTo(7f, 4f, 3.5f, 7.2f, 3.5f, 11.2f); curveTo(3.5f, 13.3f, 4.5f, 15.2f, 6.1f, 16.5f); lineTo(5.2f, 20f); lineTo(9.1f, 18f); curveTo(10f, 18.3f, 11f, 18.4f, 12f, 18.4f); curveTo(17f, 18.4f, 20.5f, 15.2f, 20.5f, 11.2f); curveTo(20.5f, 7.2f, 17f, 4f, 12f, 4f); close() } }
    val Users: ImageVector by lazy { stroke("users") { circle(9f, 8f, 3.5f); moveTo(3f, 20f); curveTo(3f, 16f, 5.5f, 14f, 9f, 14f); curveTo(12.5f, 14f, 15f, 16f, 15f, 20f); moveTo(16f, 4.8f); arcTo(3.5f, 3.5f, 0f, false, true, 16f, 11.2f); moveTo(17.5f, 14.3f); curveTo(20f, 15f, 21f, 17f, 21f, 20f) } }
    val Sparkle: ImageVector by lazy { stroke("sparkle") { moveTo(12f, 3f); curveTo(12.5f, 8f, 16f, 11.5f, 21f, 12f); curveTo(16f, 12.5f, 12.5f, 16f, 12f, 21f); curveTo(11.5f, 16f, 8f, 12.5f, 3f, 12f); curveTo(8f, 11.5f, 11.5f, 8f, 12f, 3f); close() } }
    val Camera: ImageVector by lazy { stroke("camera") { moveTo(4f, 8f); lineTo(8f, 8f); lineTo(9.5f, 5.5f); lineTo(14.5f, 5.5f); lineTo(16f, 8f); lineTo(20f, 8f); arcTo(1.5f, 1.5f, 0f, false, true, 21.5f, 9.5f); lineTo(21.5f, 18f); arcTo(1.5f, 1.5f, 0f, false, true, 20f, 19.5f); lineTo(4f, 19.5f); arcTo(1.5f, 1.5f, 0f, false, true, 2.5f, 18f); lineTo(2.5f, 9.5f); arcTo(1.5f, 1.5f, 0f, false, true, 4f, 8f); close(); circle(12f, 13.5f, 3.5f) } }
    val Stop: ImageVector by lazy { stroke("stop", fill = true) { moveTo(6f, 6f); lineTo(18f, 6f); lineTo(18f, 18f); lineTo(6f, 18f); close() } }
    val Text: ImageVector by lazy { stroke("text") { moveTo(4f, 6f); lineTo(20f, 6f); moveTo(4f, 12f); lineTo(16f, 12f); moveTo(4f, 18f); lineTo(12f, 18f) } }
    val Bolt: ImageVector by lazy { stroke("bolt") { moveTo(13f, 2.5f); lineTo(5f, 13.5f); lineTo(11f, 13.5f); lineTo(10f, 21.5f); lineTo(19f, 10f); lineTo(13f, 10f); close() } }
    val Globe: ImageVector by lazy { stroke("globe") { circle(12f, 12f, 9f); moveTo(3f, 12f); lineTo(21f, 12f); moveTo(12f, 3f); curveTo(15f, 6f, 15f, 18f, 12f, 21f); moveTo(12f, 3f); curveTo(9f, 6f, 9f, 18f, 12f, 21f) } }
}
