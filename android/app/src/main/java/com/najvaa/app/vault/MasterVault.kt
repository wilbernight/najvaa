package com.najvaa.app.vault

import android.content.Context
import com.najvaa.app.core.Bytes
import com.najvaa.app.crypto.Primitives
import org.json.JSONObject
import java.io.File

/**
 * The app vault. One master password protects an index of rooms; every room
 * then has its own file encrypted with a key derived from that room's own
 * password (see [RoomVault]). Losing the app password or a room password
 * loses that data: there is no recovery and no copy anywhere else.
 *
 *  master.njv   { salt, iters, verifier, duress?, wrapped? }   plain JSON
 *  index.njv    AES-GCM(masterKey, { rooms:[...], device, settings... })
 *  rooms/<id>.njv   AES-GCM(roomVaultKey, { messages, cursor, names })
 */
class MasterVault(private val context: Context) {

    private val dir = File(context.filesDir, "vault")
    private val masterFile = File(dir, "master.njv")
    private val indexFile = File(dir, "index.njv")
    val roomsDir = File(dir, "rooms")

    @Volatile
    private var masterKey: ByteArray? = null

    val isSetUp: Boolean get() = masterFile.isFile
    val isOpen: Boolean get() = masterKey != null
    val hasBiometricWrap: Boolean get() = masterJson()?.has("wrapped") == true

    private fun masterJson(): JSONObject? = SecureFiles.read(masterFile)?.let { runCatching { JSONObject(Bytes.text(it)) }.getOrNull() }

    private fun deriveMaster(password: String, saltB64: String, iterations: Int): ByteArray =
        Primitives.pbkdf2(password, Bytes.unb64u(saltB64) ?: ByteArray(16), iterations)

    private fun verifierFor(key: ByteArray) = Bytes.b64u(Primitives.seal(key, Bytes.utf8(MAGIC), Bytes.utf8("najvaa/master")))

    private fun verifies(key: ByteArray, verifier: String): Boolean {
        val blob = Bytes.unb64u(verifier) ?: return false
        val plain = Primitives.open(key, blob, Bytes.utf8("najvaa/master")) ?: return false
        return Bytes.constantTimeEquals(plain, Bytes.utf8(MAGIC))
    }

    /** Creates the vault. Slow: call off the main thread. */
    fun setUp(password: String) {
        dir.mkdirs()
        roomsDir.mkdirs()
        val salt = Bytes.b64u(Bytes.random(16))
        val key = deriveMaster(password, salt, ITERATIONS)
        val json = JSONObject()
            .put("v", 2)
            .put("salt", salt)
            .put("iters", ITERATIONS)
            .put("verifier", verifierFor(key))
        SecureFiles.writeAtomic(masterFile, Bytes.utf8(json.toString()))
        masterKey = key
        saveIndex(Index())
    }

    /** True on success. Slow (PBKDF2): call off the main thread. */
    fun open(password: String): Boolean {
        val m = masterJson() ?: return false
        val key = deriveMaster(password, m.optString("salt"), m.optInt("iters", ITERATIONS))
        if (!verifies(key, m.optString("verifier"))) {
            Bytes.wipe(key)
            return false
        }
        masterKey = key
        return true
    }

    fun openWithKey(key: ByteArray): Boolean {
        val m = masterJson() ?: return false
        if (!verifies(key, m.optString("verifier"))) return false
        masterKey = key.copyOf()
        return true
    }

    fun masterKeyCopy(): ByteArray? = masterKey?.copyOf()

    /** True when [password] is the duress password: the caller wipes everything. */
    fun isDuress(password: String): Boolean {
        val m = masterJson() ?: return false
        val d = m.optJSONObject("duress") ?: return false
        val probe = Primitives.pbkdf2(password, Bytes.unb64u(d.optString("salt")) ?: return false, DURESS_ITERATIONS)
        val hash = Primitives.sha256(probe)
        Bytes.wipe(probe)
        return Bytes.constantTimeEquals(hash, Bytes.unb64u(d.optString("hash")) ?: return false)
    }

    fun setDuress(password: String?) {
        val m = masterJson() ?: return
        if (password == null) {
            m.remove("duress")
        } else {
            val salt = Bytes.random(16)
            val probe = Primitives.pbkdf2(password, salt, DURESS_ITERATIONS)
            m.put("duress", JSONObject().put("salt", Bytes.b64u(salt)).put("hash", Bytes.b64u(Primitives.sha256(probe))))
            Bytes.wipe(probe)
        }
        SecureFiles.writeAtomic(masterFile, Bytes.utf8(m.toString()))
    }

    fun changePassword(current: String, next: String): Boolean {
        if (!open(current)) return false
        val index = loadIndex() ?: return false
        val m = masterJson() ?: return false
        val salt = Bytes.b64u(Bytes.random(16))
        val key = deriveMaster(next, salt, ITERATIONS)
        m.put("salt", salt).put("iters", ITERATIONS).put("verifier", verifierFor(key)).remove("wrapped")
        masterKey?.let { Bytes.wipe(it) }
        masterKey = key
        SecureFiles.writeAtomic(masterFile, Bytes.utf8(m.toString()))
        saveIndex(index)
        return true
    }

    // ── biometric wrap ─────────────────────────────────────────────────────
    fun wrappedBlob(): ByteArray? = masterJson()?.optString("wrapped")?.takeIf { it.isNotEmpty() }?.let { Bytes.unb64u(it) }

    fun storeWrapped(blob: ByteArray?) {
        val m = masterJson() ?: return
        if (blob == null) m.remove("wrapped") else m.put("wrapped", Bytes.b64u(blob))
        SecureFiles.writeAtomic(masterFile, Bytes.utf8(m.toString()))
    }

    // ── index ──────────────────────────────────────────────────────────────
    class Index(
        var rooms: MutableList<IndexRoom> = mutableListOf(),
        var deviceId: String = "",
        var lastRoom: String? = null,
    )

    class IndexRoom(
        val id: String,
        val code: String,
        var title: String,
        val createdAt: Long,
        var lastAt: Long,
        var preview: String,
        var unread: Int,
        var pinned: Boolean,
        var muted: Boolean,
        var ttl: Int,
        var myName: String,
        var waiting: Boolean,
        /** AES-GCM(masterKey, room password), so a room opens again after one app unlock. */
        var sealedPassword: String,
        val vaultSalt: String,
        /** AES-GCM(masterKey, RoomKeys.export()): skips the 800k-round PBKDF2 on every unlock. */
        var sealedKeys: String = "",
    )

    fun loadIndex(): Index? {
        val key = masterKey ?: return null
        val blob = SecureFiles.read(indexFile) ?: return Index()
        val plain = Primitives.open(key, blob, Bytes.utf8("najvaa/index")) ?: return null
        return runCatching {
            val o = JSONObject(Bytes.text(plain))
            val arr = o.optJSONArray("rooms")
            val rooms = mutableListOf<IndexRoom>()
            if (arr != null) for (i in 0 until arr.length()) {
                val r = arr.getJSONObject(i)
                rooms += IndexRoom(
                    id = r.getString("id"),
                    code = r.getString("code"),
                    title = r.optString("title"),
                    createdAt = r.optLong("createdAt"),
                    lastAt = r.optLong("lastAt"),
                    preview = r.optString("preview"),
                    unread = r.optInt("unread"),
                    pinned = r.optBoolean("pinned"),
                    muted = r.optBoolean("muted"),
                    ttl = r.optInt("ttl"),
                    myName = r.optString("myName"),
                    waiting = r.optBoolean("waiting"),
                    sealedPassword = r.optString("pw"),
                    vaultSalt = r.optString("vs"),
                    sealedKeys = r.optString("kc"),
                )
            }
            Index(rooms, o.optString("device"), o.optString("last").ifEmpty { null })
        }.getOrNull().also { Bytes.wipe(plain) }
    }

    fun saveIndex(index: Index) {
        val key = masterKey ?: return
        val arr = org.json.JSONArray()
        index.rooms.forEach { r ->
            arr.put(
                JSONObject()
                    .put("id", r.id).put("code", r.code).put("title", r.title)
                    .put("createdAt", r.createdAt).put("lastAt", r.lastAt).put("preview", r.preview)
                    .put("unread", r.unread).put("pinned", r.pinned).put("muted", r.muted)
                    .put("ttl", r.ttl).put("myName", r.myName).put("waiting", r.waiting)
                    .put("pw", r.sealedPassword).put("vs", r.vaultSalt).put("kc", r.sealedKeys),
            )
        }
        val o = JSONObject().put("rooms", arr).put("device", index.deviceId).put("last", index.lastRoom ?: "")
        val plain = Bytes.utf8(o.toString())
        SecureFiles.writeAtomic(indexFile, Primitives.seal(key, plain, Bytes.utf8("najvaa/index")))
        Bytes.wipe(plain)
    }

    fun sealPassword(password: String): String {
        val key = masterKey ?: return ""
        return Bytes.b64u(Primitives.seal(key, Bytes.utf8(password), Bytes.utf8("najvaa/room-password")))
    }

    fun sealBytes(plain: ByteArray, label: String): String {
        val key = masterKey ?: return ""
        return Bytes.b64u(Primitives.seal(key, plain, Bytes.utf8("najvaa/$label")))
    }

    fun openBytes(sealed: String, label: String): ByteArray? {
        val key = masterKey ?: return null
        val blob = Bytes.unb64u(sealed) ?: return null
        return Primitives.open(key, blob, Bytes.utf8("najvaa/$label"))
    }

    fun openPassword(sealed: String): String? {
        val key = masterKey ?: return null
        val blob = Bytes.unb64u(sealed) ?: return null
        val plain = Primitives.open(key, blob, Bytes.utf8("najvaa/room-password")) ?: return null
        return Bytes.text(plain).also { Bytes.wipe(plain) }
    }

    // ── lifecycle ──────────────────────────────────────────────────────────
    fun close() {
        masterKey?.let { Bytes.wipe(it) }
        masterKey = null
    }

    /** Destroys every file of the vault and the keystore key. Irreversible. */
    fun wipe() {
        close()
        SecureFiles.shred(dir)
        DeviceKey.delete()
        File(context.cacheDir, "open").let { SecureFiles.shred(it) }
    }

    companion object {
        private const val MAGIC = "najvaa.vault.v2"
        const val ITERATIONS = 310_000
        private const val DURESS_ITERATIONS = 120_000
    }
}
