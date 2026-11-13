package com.najvaa.app.live

import com.najvaa.app.core.Bytes
import com.najvaa.app.crypto.Ratchet
import com.najvaa.app.crypto.RoomKeys
import com.najvaa.app.data.PeerInfo
import com.najvaa.app.net.Relay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.WebSocket
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import kotlin.random.Random

/**
 * The live side of a room: one relay socket, one [Ratchet] per other device.
 * Everything that touches a session runs under [mutex], in order, exactly
 * like the web client's serial queue.
 */
class LiveRoom(
    private val scope: CoroutineScope,
    private val keys: RoomKeys,
    private val cid: String,
    private val myName: String,
    private val handler: Handler,
) {
    interface Handler {
        /** An authenticated inner object from a secure session. */
        suspend fun onInner(peer: String, o: JSONObject)
        /** A session became secure or ended: presence changed. */
        fun onPeersChanged(peers: List<PeerInfo>)
        /** The handshake with a device failed: that device's password differs. */
        fun onAuthFailed(peer: String)
        /** An encrypted file chunk from a peer: [1][from 12][file 12][index 4][ct]. */
        suspend fun onChunk(from: String, fileId: ByteArray, index: Int, ct: ByteArray)
        fun onSocketState(connected: Boolean, closeCode: Int?)
        fun onDue()
    }

    private val mutex = Mutex()
    private val sessions = HashMap<String, Ratchet>()
    private val hsTries = HashMap<String, Int>()
    private val hsTimers = HashMap<String, Job>()
    private var socket: WebSocket? = null
    private var connectJob: Job? = null
    private var pingJob: Job? = null
    /** Inner objects decrypted under [mutex], delivered to the handler once it is released. */
    private val inbox = ArrayList<Pair<String, JSONObject>>()
    private var reconnectDelay = 1_000L

    /**
     * Android 15+ cuts a background app's network unless it runs a foreground
     * service, so reconnects while backgrounded are spaced out; the app's
     * return to the foreground probes the socket right away.
     */
    @Volatile var background = false
    private var lastRx = 0L
    private var creating = false
    @Volatile
    var running = false
        private set

    private val _peers = MutableStateFlow<List<PeerInfo>>(emptyList())
    val peers: StateFlow<List<PeerInfo>> = _peers

    val anySecure: Boolean get() = sessions.values.any { it.secure }

    fun start(fresh: Boolean = false) {
        if (running) return
        running = true
        creating = fresh
        connect()
    }

    fun stop() {
        running = false
        connectJob?.cancel()
        pingJob?.cancel()
        socket?.close(1000, null)
        socket = null
        scope.launch { mutex.withLock { endAll() } }
    }

    /** Back in view or network changed: make sure the socket still answers. */
    fun probe() {
        val s = socket
        if (!running) return
        if (s == null) {
            connect()
            return
        }
        val sent = System.currentTimeMillis()
        if (!s.send("""{"t":"ping"}""")) {
            drop(s)
            return
        }
        scope.launch {
            delay(6_000)
            if (socket === s && lastRx < sent) drop(s)
        }
    }

    private fun connect() {
        if (!running) return
        connectJob?.cancel()
        if (com.najvaa.app.BuildConfig.DEBUG) android.util.Log.d("Najvaa/Live", "connect; previous=${socket != null}")
        socket?.close(1000, null)
        handler.onSocketState(false, null)
        val ws = Relay.socket(
            keys, cid, creating,
            object : Relay.SocketEvents {
                override fun onOpen() {
                    reconnectDelay = 1_000
                    lastRx = System.currentTimeMillis()
                    startPing()
                }

                override fun onText(text: String) {
                    lastRx = System.currentTimeMillis()
                    val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                    scope.launch {
                        // Inner objects are handed to the engine only after the
                        // mutex is released: the engine replies through post()/
                        // postTo(), which take the same (non-reentrant) mutex.
                        val delivered: List<Pair<String, JSONObject>>
                        mutex.withLock {
                            onWire(msg)
                            delivered = inbox.toList()
                            inbox.clear()
                        }
                        for ((peer, inner) in delivered) handler.onInner(peer, inner)
                    }
                }

                override fun onBinary(bytes: ByteArray) {
                    lastRx = System.currentTimeMillis()
                    if (bytes.size < 29 || bytes[0] != 1.toByte()) return
                    val from = Bytes.b64u(bytes.copyOfRange(1, 13))
                    val fileId = bytes.copyOfRange(13, 25)
                    val index = Bytes.u32At(bytes, 25)
                    val ct = bytes.copyOfRange(29, bytes.size)
                    scope.launch { handler.onChunk(from, fileId, index, ct) }
                }

                override fun onClosed(code: Int) {
                    pingJob?.cancel()
                    scope.launch {
                        mutex.withLock { endAll() }
                        handler.onSocketState(false, code)
                    }
                    if (!running) return
                    if (code == 4001 || code == 4003 || code == 4009 || code == 4010) return
                    if (code == 4002) return // code taken while creating: the engine picks a new one
                    connectJob = scope.launch {
                        delay(if (background) maxOf(reconnectDelay, 30_000L) else reconnectDelay)
                        reconnectDelay = minOf(reconnectDelay * 2, if (background) 120_000L else 15_000L)
                        connect()
                    }
                }
            },
        )
        socket = ws
    }

    private fun drop(s: WebSocket) {
        if (socket !== s) return
        if (com.najvaa.app.BuildConfig.DEBUG) android.util.Log.d("Najvaa/Live", "drop socket", Throwable())
        runCatching { s.cancel() }
        socket = null
        reconnectDelay = 1_000
        pingJob?.cancel()
        scope.launch { mutex.withLock { endAll() } }
        handler.onSocketState(false, 1006)
        if (running) connectJob = scope.launch { delay(600); connect() }
    }

    private fun startPing() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (running) {
                delay(15_000)
                val s = socket ?: break
                if (System.currentTimeMillis() - lastRx > 40_000) {
                    drop(s)
                    break
                }
                s.send("""{"t":"ping"}""")
            }
        }
    }

    fun send(obj: JSONObject): Boolean = socket?.send(obj.toString()) ?: false

    fun sendBinary(bytes: ByteArray): Boolean = socket?.send(bytes.toByteString()) ?: false

    // ── wire ───────────────────────────────────────────────────────────────
    private suspend fun onWire(msg: JSONObject) {
        when (msg.optString("t")) {
            "welcome" -> {
                creating = false
                handler.onSocketState(true, null)
                val peers = msg.optJSONArray("peers")
                if (peers != null) for (i in 0 until peers.length()) {
                    val pid = peers.optString(i)
                    if (PID.matches(pid)) startHandshake(pid)
                }
                publishPeers()
            }
            "peer-joined" -> {
                val pid = msg.optString("id")
                if (PID.matches(pid)) startHandshake(pid)
            }
            "peer-left" -> {
                val pid = msg.optString("id")
                hsTries.remove(pid)
                endSession(pid)
                publishPeers()
            }
            "hello" -> onHello(msg)
            "m" -> onCipher(msg)
            "due" -> handler.onDue()
            "full" -> handler.onSocketState(false, 4001)
            "taken" -> handler.onSocketState(false, 4002)
            "closed" -> handler.onSocketState(false, 4003)
        }
    }

    private suspend fun startHandshake(pid: String) {
        endSession(pid)
        val s = Ratchet(pid, keys.psk)
        sessions[pid] = s
        publishPeers()
        send(s.hello)
        armRetry(s)
    }

    private fun armRetry(s: Ratchet) {
        val n = (hsTries[s.peer] ?: 0) + 1
        hsTries[s.peer] = n
        hsTimers[s.peer]?.cancel()
        hsTimers[s.peer] = scope.launch {
            delay(8_000 + Random.nextLong(2_000))
            mutex.withLock {
                if (sessions[s.peer] !== s || s.secure || s.failed) return@withLock
                send(JSONObject(s.hello.toString()).put("r", 1))
            }
            delay((if (n <= 3) 6_000L else 25_000L) + Random.nextLong(2_000))
            mutex.withLock {
                if (sessions[s.peer] === s && !s.secure && !s.failed) startHandshake(s.peer)
            }
        }
    }

    private suspend fun onHello(h: JSONObject) {
        val from = h.optString("from")
        if (!PID.matches(from) || h.optInt("v") != 1) return
        var s = sessions[from]
        if (s != null && s.established && s.matchesHello(h.optString("p"))) {
            if (h.has("r") && !s.secure && !s.echoed) {
                s.echoed = true
                send(JSONObject(s.hello.toString()).put("r", 1))
            }
            return
        }
        if (s == null || s.established) {
            startHandshake(from)
            s = sessions[from] ?: return
        }
        if (!s.onHello(h)) {
            failAuth(s)
            return
        }
        sendInner(s, JSONObject().put("k", "confirm"))
    }

    private suspend fun onCipher(m: JSONObject) {
        val s = sessions[m.optString("from")] ?: return
        if (s.failed) return
        val inner = s.decrypt(m)
        if (inner == null) {
            if (!s.secure) {
                if ((hsTries[s.peer] ?: 0) < 3 && !s.mismatchRetry) {
                    s.mismatchRetry = true
                    scope.launch {
                        mutex.withLock { if (sessions[s.peer] === s && !s.secure) startHandshake(s.peer) }
                    }
                } else if (!s.mismatchRetry) {
                    failAuth(s)
                }
            }
            return
        }
        when (inner.optString("k")) {
            "confirm" -> {
                if (s.secure) return
                s.confirm()
                hsTimers[s.peer]?.cancel()
                hsTries.remove(s.peer)
                sendInner(s, JSONObject().put("k", "hi").put("name", myName).put("dv", cid).put("ty", "m"))
                publishPeers()
                inbox.add(s.peer to inner)
            }
            "hi" -> {
                val name = inner.optString("name").replace(Regex("\\s+"), " ").trim().take(30)
                s.mobile = inner.optString("ty") == "m"
                s.name = name.ifEmpty { if (s.mobile) "موبایل" else "کامپیوتر" }
                s.dev = inner.optString("dv").takeIf { PID.matches(it) } ?: s.peer
                publishPeers()
                inbox.add(s.peer to inner)
            }
            "rekey" -> s.onRekey(inner)?.let { ack -> sendInner(s, ack) }
            "rekey-ack" -> s.onRekeyAck(inner)
            else -> inbox.add(s.peer to inner)
        }
        if (sessions[s.peer] === s) maybeRekey(s)
    }

    private fun failAuth(s: Ratchet) {
        if (sessions[s.peer] !== s) return
        s.fail()
        publishPeers()
        handler.onAuthFailed(s.peer)
    }

    private fun sendInner(s: Ratchet, obj: JSONObject): Boolean {
        val frame = s.encrypt(obj) ?: return false
        return send(frame)
    }

    private fun maybeRekey(s: Ratchet) {
        val rekey = s.rekeyIfDue() ?: return
        sendInner(s, rekey)
    }

    /** Sends to every secure session; returns the peer ids reached. */
    suspend fun post(obj: JSONObject): List<String> = mutex.withLock {
        val reached = ArrayList<String>()
        for (s in sessions.values.filter { it.secure }) {
            if (sendInner(s, obj)) reached += s.peer
            maybeRekey(s)
        }
        reached
    }

    suspend fun postTo(peer: String, obj: JSONObject): Boolean = mutex.withLock {
        val s = sessions[peer] ?: return false
        if (!s.secure) return false
        val ok = sendInner(s, obj)
        maybeRekey(s)
        ok
    }

    suspend fun securePeers(): List<String> = mutex.withLock { sessions.values.filter { it.secure }.map { it.peer } }

    /** Maps a session's device id (what history entries carry) to its name. */
    fun devName(dev: String): String? = sessions.values.firstOrNull { it.dev == dev || it.peer == dev }?.name

    suspend fun safety(peer: String): Pair<String, String>? = mutex.withLock {
        val s = sessions[peer] ?: return null
        val sas = s.sas ?: return null
        val digits = StringBuilder()
        for (i in 0 until 6) {
            val v = ((sas[i * 2].toInt() and 0xFF) shl 8 or (sas[i * 2 + 1].toInt() and 0xFF)) % 100000
            digits.append(String.format(java.util.Locale.US, "%05d", v))
            if (i < 5) digits.append(' ')
        }
        digits.toString() to "${s.curveLabel} · AES-256-GCM · ${s.rekeys} چرخش کلید"
    }

    private fun endSession(pid: String) {
        hsTimers.remove(pid)?.cancel()
        sessions.remove(pid)?.destroy()
    }

    private fun endAll() {
        hsTimers.values.forEach { it.cancel() }
        hsTimers.clear()
        sessions.values.forEach { it.destroy() }
        sessions.clear()
        publishPeers()
    }

    private fun publishPeers() {
        val list = sessions.values.map { PeerInfo(it.peer, it.name, it.secure, it.mobile) }
        _peers.value = list
        handler.onPeersChanged(list)
    }

    companion object {
        val PID = Regex("^[A-Za-z0-9_-]{16}$")
    }
}
