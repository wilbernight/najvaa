package com.najvaa.app.crypto

import com.najvaa.app.core.Bytes
import org.json.JSONObject

/**
 * One end-to-end session with one other device in the room, speaking the web
 * client's protocol:
 *
 *  hello   fresh X25519 (and P-256) ephemeral keys + nonce, in the clear.
 *  root    HKDF(ECDH, salt = room psk, info = transcript hash). Without the
 *          password the relay cannot finish the handshake.
 *  chains  per direction an HMAC chain gives a new AES-256-GCM key per
 *          message (AAD "wn1|role|epoch|n"); skipped keys are kept briefly
 *          so out-of-order frames still open, replays never do.
 *  rekey   role A starts a DH ratchet every 20 messages or 60 s; old chain
 *          keys are wiped.
 *
 * All methods must be called under one lock per room (see LiveRoom).
 */
class Ratchet(val peer: String, private val psk: ByteArray) {

    private class Chain(var ck: ByteArray, var n: Int)

    private var x: X25519Pair? = X25519Pair.generate()
    private var p: P256Pair? = P256Pair.generate()
    private val nonce = Bytes.random(16)
    private var root: ByteArray? = null
    private var role = 'A'
    private var curve = "x25519"
    private var peerP: String? = null
    private var send: Chain? = null
    private var sendEpoch = 0
    private val recv = HashMap<Int, Chain>()
    private val skipped = LinkedHashMap<String, ByteArray>()
    private var epochMsgs = 0
    private var epochStart = System.currentTimeMillis()
    private var rekeyPending: Pair<Int, Any>? = null

    var secure = false
        private set
    var failed = false
        private set
    var rekeys = 0
        private set
    var sas: ByteArray? = null
        private set
    var name = ""
    var dev = peer
    var mobile = false
    var mismatchRetry = false
    var echoed = false

    val hello: JSONObject = JSONObject()
        .put("t", "hello")
        .put("to", peer)
        .put("v", 1)
        .put("p", Bytes.b64u(p!!.pub))
        .put("x", Bytes.b64u(x!!.pub))
        .put("n", Bytes.b64u(nonce))

    val established: Boolean get() = root != null
    val curveLabel: String get() = if (curve == "x25519") "X25519" else "P-256"

    fun matchesHello(peerPub: String) = peerP != null && peerP == peerPub

    /** Derives the shared root from the peer's hello. Returns false when it is malformed. */
    fun onHello(h: JSONObject): Boolean {
        val peerPBytes = Bytes.unb64u(h.optString("p")) ?: return false
        val peerX = h.optString("x").takeIf { it.isNotEmpty() && !h.isNull("x") }?.let { Bytes.unb64u(it) }
        val peerNonce = Bytes.unb64u(h.optString("n")) ?: return false
        if (peerPBytes.size != 65 || peerNonce.size != 16 || (peerX != null && peerX.size != 32)) return false
        val myX = x ?: return false
        val myP = p ?: return false
        return try {
            curve = if (peerX != null) "x25519" else "p256"
            role = if (Bytes.compare(myP.pub, peerPBytes) < 0) 'A' else 'B'
            val shared = if (curve == "x25519") myX.agree(peerX!!) else myP.agree(peerPBytes)
            val mine = Bytes.concat(Bytes.lp(myX.pub), Bytes.lp(myP.pub), Bytes.lp(nonce))
            val theirs = Bytes.concat(Bytes.lp(peerX ?: ByteArray(0)), Bytes.lp(peerPBytes), Bytes.lp(peerNonce))
            val (first, second) = if (role == 'A') mine to theirs else theirs to mine
            val transcript = Primitives.sha256(Bytes.utf8("wn1/handshake"), first, second)
            root = Primitives.hkdf(shared, psk, "wn1/root/" + Bytes.b64u(transcript))
            Bytes.wipe(shared)
            peerP = h.optString("p")
            sas = Primitives.sha256(root!!, Bytes.utf8("wn1/sas"))
            myX.wipe()
            x = null
            p = null
            recv.clear()
            skipped.clear()
            rekeys = 0
            installChains(0)
            true
        } catch (_: Exception) {
            failed = true
            false
        }
    }

    private fun installChains(epoch: Int) {
        val r = root ?: return
        val ab = Chain(Primitives.hkdf(r, Primitives.ZERO32, "wn1/ck/AB/$epoch"), 0)
        val ba = Chain(Primitives.hkdf(r, Primitives.ZERO32, "wn1/ck/BA/$epoch"), 0)
        send?.let { Bytes.wipe(it.ck) }
        send = if (role == 'A') ab else ba
        sendEpoch = epoch
        recv[epoch] = if (role == 'A') ba else ab
        recv.keys.filter { it < epoch - 1 }.forEach { e -> Bytes.wipe(recv[e]!!.ck); recv.remove(e) }
        skipped.keys.filter { it.substringBefore(':').toInt() < epoch - 1 }.forEach { k -> Bytes.wipe(skipped[k]); skipped.remove(k) }
        epochStart = System.currentTimeMillis()
        epochMsgs = 0
    }

    /** Encrypts one inner object into a relay frame {t:'m', to, e, n, iv, c}. */
    fun encrypt(inner: JSONObject): JSONObject? {
        val ch = send ?: return null
        if (failed) return null
        val e = sendEpoch
        val n = ch.n
        val mk = Primitives.hmac(ch.ck, byteArrayOf(1))
        val next = Primitives.hmac(ch.ck, byteArrayOf(2))
        Bytes.wipe(ch.ck)
        ch.ck = next
        ch.n++
        val iv = Bytes.random(12)
        val aad = Bytes.utf8("wn1|$role|$e|$n")
        val ct = Primitives.aesGcmEncrypt(mk, iv, Primitives.pad(Bytes.utf8(inner.toString())), aad)
        Bytes.wipe(mk)
        epochMsgs++
        return JSONObject().put("t", "m").put("to", peer).put("e", e).put("n", n).put("iv", Bytes.b64u(iv)).put("c", Bytes.b64u(ct))
    }

    /** Opens a relay frame from this peer; null when forged, replayed or for an unknown epoch. */
    fun decrypt(m: JSONObject): JSONObject? {
        if (failed) return null
        val e = m.optInt("e", -1)
        val n = m.optInt("n", -1)
        if (e < 0 || n < 0) return null
        val ch = recv[e] ?: return null
        val peerRole = if (role == 'A') 'B' else 'A'
        val key = "$e:$n"
        var mk: ByteArray
        var ck = ch.ck
        var cursor = ch.n
        val newSkipped = ArrayList<Pair<String, ByteArray>>()
        if (n < ch.n) {
            mk = skipped[key] ?: return null
        } else {
            if (n - cursor > MAX_SKIP) return null
            while (cursor < n) {
                newSkipped += "$e:$cursor" to Primitives.hmac(ck, byteArrayOf(1))
                ck = Primitives.hmac(ck, byteArrayOf(2))
                cursor++
            }
            mk = Primitives.hmac(ck, byteArrayOf(1))
            ck = Primitives.hmac(ck, byteArrayOf(2))
            cursor++
        }
        val iv = Bytes.unb64u(m.optString("iv")) ?: return null
        val ct = Bytes.unb64u(m.optString("c")) ?: return null
        val padded = Primitives.aesGcmDecrypt(mk, iv, ct, Bytes.utf8("wn1|$peerRole|$e|$n"))
        Bytes.wipe(mk)
        val plain = padded?.let { Primitives.unpad(it) } ?: run {
            newSkipped.forEach { Bytes.wipe(it.second) }
            return null
        }
        if (n < ch.n) {
            skipped.remove(key)
        } else {
            Bytes.wipe(ch.ck)
            ch.ck = ck
            ch.n = cursor
            newSkipped.forEach { skipped[it.first] = it.second }
            while (skipped.size > MAX_SKIP) {
                val first = skipped.keys.first()
                Bytes.wipe(skipped[first])
                skipped.remove(first)
            }
        }
        epochMsgs++
        return runCatching { JSONObject(Bytes.text(plain)) }.getOrNull().also { Bytes.wipe(plain) }
    }

    fun confirm() {
        secure = true
    }

    fun fail() {
        failed = true
    }

    /** Role A: a {k:'rekey'} inner object when this epoch is old enough, else null. */
    fun rekeyIfDue(): JSONObject? {
        if (!secure || role != 'A' || rekeyPending != null) return null
        if (epochMsgs < REKEY_MESSAGES && System.currentTimeMillis() - epochStart < REKEY_MS) return null
        val e = sendEpoch + 1
        return if (curve == "x25519") {
            val kp = X25519Pair.generate()
            rekeyPending = e to kp
            JSONObject().put("k", "rekey").put("e", e).put("pub", Bytes.b64u(kp.pub))
        } else {
            val kp = P256Pair.generate()
            rekeyPending = e to kp
            JSONObject().put("k", "rekey").put("e", e).put("pub", Bytes.b64u(kp.pub))
        }
    }

    /** Role B: answers a peer's rekey. Returns the ack to send (before ratcheting locally). */
    fun onRekey(o: JSONObject): JSONObject? {
        if (role != 'B' || o.optInt("e", -1) != sendEpoch + 1) return null
        val peerPub = Bytes.unb64u(o.optString("pub")) ?: return null
        return try {
            val (ack, shared) = if (curve == "x25519") {
                val kp = X25519Pair.generate()
                val s = kp.agree(peerPub)
                kp.wipe()
                JSONObject().put("k", "rekey-ack").put("e", o.getInt("e")).put("pub", Bytes.b64u(kp.pub)) to s
            } else {
                val kp = P256Pair.generate()
                JSONObject().put("k", "rekey-ack").put("e", o.getInt("e")).put("pub", Bytes.b64u(kp.pub)) to kp.agree(peerPub)
            }
            ratchet(shared, o.getInt("e"))
            ack
        } catch (_: Exception) {
            null
        }
    }

    fun onRekeyAck(o: JSONObject) {
        val pending = rekeyPending ?: return
        if (role != 'A' || o.optInt("e", -1) != pending.first) return
        rekeyPending = null
        val peerPub = Bytes.unb64u(o.optString("pub")) ?: return
        runCatching {
            val shared = when (val kp = pending.second) {
                is X25519Pair -> kp.agree(peerPub).also { kp.wipe() }
                is P256Pair -> kp.agree(peerPub)
                else -> return
            }
            ratchet(shared, pending.first)
        }
    }

    private fun ratchet(shared: ByteArray, epoch: Int) {
        val old = root ?: return
        root = Primitives.hkdf(shared, old, "wn1/ratchet/$epoch")
        Bytes.wipe(shared, old)
        rekeys++
        installChains(epoch)
    }

    fun destroy() {
        root?.let { Bytes.wipe(it) }
        root = null
        send?.let { Bytes.wipe(it.ck) }
        recv.values.forEach { Bytes.wipe(it.ck) }
        recv.clear()
        skipped.values.forEach { Bytes.wipe(it) }
        skipped.clear()
        x?.wipe()
        x = null
        p = null
        secure = false
        failed = true
    }

    companion object {
        const val REKEY_MESSAGES = 20
        const val REKEY_MS = 60_000L
        const val MAX_SKIP = 500
    }
}
