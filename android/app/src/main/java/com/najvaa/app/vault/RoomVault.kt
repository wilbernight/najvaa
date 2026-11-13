package com.najvaa.app.vault

import com.najvaa.app.core.Bytes
import com.najvaa.app.crypto.Primitives
import com.najvaa.app.data.Delivery
import com.najvaa.app.data.Direction
import com.najvaa.app.data.Kind
import com.najvaa.app.data.Message
import com.najvaa.app.data.Reply
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * One room, one file. The key comes from the room's own password (HKDF of
 * the same PBKDF2 output the server token uses) mixed with a per-room random
 * salt, so two rooms never share a key and the app master key alone cannot
 * read a room: both passwords are needed.
 */
class RoomVault(private val file: File, roomVaultKey: ByteArray, saltB64: String) {

    private val key: ByteArray = Primitives.hkdf(roomVaultKey, Bytes.unb64u(saltB64) ?: ByteArray(16), "najvaa/room-file")
    private val aad = Bytes.utf8("najvaa/room/" + file.nameWithoutExtension)
    private val lock = Any()

    class Contents(
        var messages: MutableList<Message> = mutableListOf(),
        var cursor: Long = 0,
        var names: MutableMap<String, String> = mutableMapOf(),
        var seenByMe: MutableSet<String> = mutableSetOf(),
    )

    fun load(): Contents = synchronized(lock) {
        val blob = SecureFiles.read(file) ?: return Contents()
        val plain = Primitives.open(key, blob, aad) ?: return Contents()
        try {
            val o = JSONObject(Bytes.text(plain))
            val arr = o.optJSONArray("m") ?: JSONArray()
            val messages = ArrayList<Message>(arr.length())
            for (i in 0 until arr.length()) messages += fromJson(arr.getJSONObject(i))
            val names = mutableMapOf<String, String>()
            o.optJSONObject("n")?.let { n -> n.keys().forEach { k -> names[k] = n.optString(k) } }
            val seen = mutableSetOf<String>()
            o.optJSONArray("s")?.let { s -> for (i in 0 until s.length()) seen += s.getString(i) }
            Contents(messages, o.optLong("c"), names, seen)
        } catch (_: Exception) {
            Contents()
        } finally {
            Bytes.wipe(plain)
        }
    }

    fun save(c: Contents) = synchronized(lock) {
        val arr = JSONArray()
        c.messages.forEach { arr.put(toJson(it)) }
        val names = JSONObject()
        c.names.forEach { (k, v) -> names.put(k, v) }
        val seen = JSONArray()
        c.seenByMe.toList().takeLast(2000).forEach { seen.put(it) }
        val o = JSONObject().put("m", arr).put("c", c.cursor).put("n", names).put("s", seen)
        val plain = Bytes.utf8(o.toString())
        SecureFiles.writeAtomic(file, Primitives.seal(key, plain, aad))
        Bytes.wipe(plain)
    }

    fun destroy() = synchronized(lock) {
        SecureFiles.shred(file)
        Bytes.wipe(key)
    }

    fun close() = Bytes.wipe(key)

    private fun toJson(m: Message): JSONObject {
        val o = JSONObject()
            .put("id", m.id).put("d", m.dir.name).put("k", m.kind.name).put("a", m.author).put("an", m.authorName)
            .put("b", m.body).put("t", m.sentAt).put("st", m.serverTs).put("ttl", m.ttl)
            .put("dl", m.delivery.name).put("r", m.readByMe).put("ed", m.edited).put("x", m.deleted)
        m.expiresAt?.let { o.put("exp", it) }
        m.reply?.let { o.put("rp", JSONObject().put("id", it.id).put("a", it.author ?: "").put("s", it.snippet).put("k", it.kind)) }
        m.myReaction?.let { o.put("mr", it) }
        if (m.peerReactions.isNotEmpty()) {
            val pr = JSONObject()
            m.peerReactions.forEach { (k, v) -> pr.put(k, v) }
            o.put("pr", pr)
        }
        m.fileName?.let { o.put("fn", it) }
        m.mime?.let { o.put("mime", it) }
        if (m.size > 0) o.put("sz", m.size)
        if (m.chunks > 0) o.put("ch", m.chunks)
        m.fileKey?.let { o.put("fk", it) }
        m.caption?.let { o.put("cap", it) }
        if (m.voiceSeconds > 0) o.put("vd", m.voiceSeconds)
        m.voiceWave?.let { o.put("vw", it) }
        return o
    }

    private fun fromJson(o: JSONObject): Message {
        val pr = mutableMapOf<String, String>()
        o.optJSONObject("pr")?.let { p -> p.keys().forEach { k -> pr[k] = p.optString(k) } }
        return Message(
            id = o.getString("id"),
            dir = runCatching { Direction.valueOf(o.getString("d")) }.getOrDefault(Direction.IN),
            kind = runCatching { Kind.valueOf(o.getString("k")) }.getOrDefault(Kind.TEXT),
            author = o.optString("a"),
            authorName = o.optString("an"),
            body = o.optString("b"),
            sentAt = o.optLong("t"),
            serverTs = o.optLong("st"),
            ttl = o.optInt("ttl"),
            expiresAt = if (o.has("exp")) o.optLong("exp") else null,
            reply = o.optJSONObject("rp")?.let { Reply(it.optString("id"), it.optString("a").ifEmpty { null }, it.optString("s"), it.optString("k", "text")) },
            edited = o.optBoolean("ed"),
            delivery = runCatching { Delivery.valueOf(o.getString("dl")) }.getOrDefault(Delivery.STORED),
            readByMe = o.optBoolean("r"),
            myReaction = o.optString("mr").ifEmpty { null },
            peerReactions = pr,
            fileName = o.optString("fn").ifEmpty { null },
            mime = o.optString("mime").ifEmpty { null },
            size = o.optLong("sz"),
            chunks = o.optInt("ch"),
            fileKey = o.optString("fk").ifEmpty { null },
            caption = o.optString("cap").ifEmpty { null },
            voiceSeconds = o.optInt("vd"),
            voiceWave = o.optString("vw").ifEmpty { null },
            deleted = o.optBoolean("x"),
        )
    }
}
