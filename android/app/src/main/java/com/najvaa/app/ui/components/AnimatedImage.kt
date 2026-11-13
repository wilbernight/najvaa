package com.najvaa.app.ui.components

import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.widget.ImageView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer

/** Decodes a GIF/WebP (animated on Android 9+, first frame below) off the main thread. */
private suspend fun decode(file: File?, bytes: ByteArray?): Drawable? = withContext(Dispatchers.IO) {
    runCatching {
        if (Build.VERSION.SDK_INT >= 28) {
            val src = when {
                file != null -> ImageDecoder.createSource(file)
                bytes != null -> ImageDecoder.createSource(ByteBuffer.wrap(bytes))
                else -> return@runCatching null
            }
            ImageDecoder.decodeDrawable(src) { decoder, _, _ -> decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
        } else {
            val bmp = when {
                file != null -> BitmapFactory.decodeFile(file.absolutePath)
                bytes != null -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                else -> null
            } ?: return@runCatching null
            BitmapDrawable(null, bmp)
        }
    }.getOrNull()
}

/**
 * Shows an animated image scaled up to the given modifier's width, keeping its
 * aspect ratio. [placeholder] is shown while decoding or when it fails.
 */
@Composable
fun AnimatedImage(
    file: File? = null,
    bytes: ByteArray? = null,
    modifier: Modifier = Modifier,
    crop: Boolean = false,
    placeholder: @Composable () -> Unit = {},
) {
    val key = file?.absolutePath ?: bytes?.let { System.identityHashCode(it) }
    val drawable by produceState<Drawable?>(null, key) { value = decode(file, bytes) }
    val d = drawable
    if (d == null) {
        Box(modifier, contentAlignment = Alignment.Center) { placeholder() }
        return
    }
    DisposableEffect(d) {
        if (Build.VERSION.SDK_INT >= 28 && d is AnimatedImageDrawable) d.start()
        onDispose { if (Build.VERSION.SDK_INT >= 28 && d is AnimatedImageDrawable) d.stop() }
    }
    val ratio = if (d.intrinsicWidth > 0 && d.intrinsicHeight > 0) d.intrinsicWidth.toFloat() / d.intrinsicHeight else 1f
    AndroidView(
        factory = { ctx ->
            ImageView(ctx).apply {
                scaleType = if (crop) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.FIT_CENTER
                adjustViewBounds = false
            }
        },
        update = { it.setImageDrawable(d) },
        modifier = if (crop) modifier else modifier.aspectRatio(ratio.coerceIn(0.4f, 2.5f)),
    )
}

/** Fills its box; used where the box already has a fixed size. */
@Composable
fun AnimatedImageFill(file: File? = null, bytes: ByteArray? = null, modifier: Modifier = Modifier, placeholder: @Composable () -> Unit = {}) =
    AnimatedImage(file, bytes, modifier.then(Modifier.fillMaxSize()), crop = true, placeholder = placeholder)
