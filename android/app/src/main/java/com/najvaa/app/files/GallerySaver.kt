package com.najvaa.app.files

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Copies a decrypted file into the phone's shared storage (gallery, music or
 * downloads) under a "Najva" folder. On Android 10+ MediaStore needs no
 * permission for files the app itself creates; Android 8-9 needs
 * WRITE_EXTERNAL_STORAGE, which the caller requests first.
 */
object GallerySaver {
    private const val FOLDER = "Najva"

    enum class Target { PICTURES, MOVIES, MUSIC, DOWNLOADS }

    fun targetFor(mime: String?): Target = when {
        mime == null -> Target.DOWNLOADS
        mime.startsWith("image/") -> Target.PICTURES
        mime.startsWith("video/") -> Target.MOVIES
        mime.startsWith("audio/") -> Target.MUSIC
        else -> Target.DOWNLOADS
    }

    val needsPermission: Boolean get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q

    /** Returns true when the copy landed in shared storage. */
    fun save(context: Context, source: File, mime: String?, displayName: String): Boolean = runCatching {
        val type = mime ?: "application/octet-stream"
        val name = safeName(displayName)
        val target = targetFor(mime)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val (collection, dir) = when (target) {
                Target.PICTURES -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to Environment.DIRECTORY_PICTURES
                Target.MOVIES -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to Environment.DIRECTORY_MOVIES
                Target.MUSIC -> MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to Environment.DIRECTORY_MUSIC
                Target.DOWNLOADS -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to Environment.DIRECTORY_DOWNLOADS
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, type)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "$dir/$FOLDER")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(collection, values) ?: return false
            try {
                resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } } ?: error("no stream")
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                true
            } catch (t: Throwable) {
                resolver.delete(uri, null, null)
                false
            }
        } else {
            @Suppress("DEPRECATION")
            val base = Environment.getExternalStoragePublicDirectory(
                when (target) {
                    Target.PICTURES -> Environment.DIRECTORY_PICTURES
                    Target.MOVIES -> Environment.DIRECTORY_MOVIES
                    Target.MUSIC -> Environment.DIRECTORY_MUSIC
                    Target.DOWNLOADS -> Environment.DIRECTORY_DOWNLOADS
                },
            )
            val dir = File(base, FOLDER).apply { mkdirs() }
            var out = File(dir, name)
            var n = 1
            while (out.exists()) out = File(dir, name.substringBeforeLast('.') + " ($n)." + name.substringAfterLast('.', "bin")).also { n++ }
            source.copyTo(out)
            MediaScannerConnection.scanFile(context, arrayOf(out.absolutePath), arrayOf(type), null)
            true
        }
    }.getOrDefault(false)

    private fun safeName(name: String): String {
        val clean = name.replace(Regex("""[\\/:*?"<>|\p{Cntrl}]"""), "_").trim().ifEmpty { "najva" }
        return clean.take(120)
    }
}
