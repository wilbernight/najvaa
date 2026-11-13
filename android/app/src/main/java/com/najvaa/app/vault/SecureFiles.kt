package com.najvaa.app.vault

import com.najvaa.app.core.Bytes
import java.io.File
import java.io.RandomAccessFile

/** Atomic writes and overwrite-before-delete for every file that holds ciphertext. */
object SecureFiles {

    fun writeAtomic(file: File, data: ByteArray) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + "." + Bytes.b64u(Bytes.random(4)) + ".tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) {
                file.writeBytes(data)
                tmp.delete()
            }
        }
    }

    fun read(file: File): ByteArray? = runCatching { if (file.isFile) file.readBytes() else null }.getOrNull()

    /** Overwrites the contents with random bytes before unlinking; best effort on flash storage. */
    fun shred(file: File) {
        if (!file.exists()) return
        if (file.isDirectory) {
            file.listFiles()?.forEach { shred(it) }
            file.delete()
            return
        }
        runCatching {
            RandomAccessFile(file, "rws").use { raf ->
                val len = raf.length()
                var left = len
                val buf = ByteArray(64 * 1024)
                raf.seek(0)
                while (left > 0) {
                    val n = minOf(left, buf.size.toLong()).toInt()
                    System.arraycopy(Bytes.random(n), 0, buf, 0, n)
                    raf.write(buf, 0, n)
                    left -= n
                }
                raf.fd.sync()
            }
        }
        file.delete()
    }
}
