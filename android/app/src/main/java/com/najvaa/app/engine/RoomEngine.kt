package com.najvaa.app.engine

import android.content.Context
import com.najvaa.app.core.Bytes
import com.najvaa.app.core.TTL_OPTIONS
import com.najvaa.app.crypto.RoomKeys
import com.najvaa.app.data.Delivery
import com.najvaa.app.data.Direction
import com.najvaa.app.data.Kind
import com.najvaa.app.data.LinkState
import com.najvaa.app.data.Message
import com.najvaa.app.data.PeerInfo
import com.najvaa.app.data.Reply
import com.najvaa.app.files.FileCodec
import com.najvaa.app.live.LiveRoom
import com.najvaa.app.net.LogPage
import com.najvaa.app.net.Relay
import com.najvaa.app.net.StoreEntry
import com.najvaa.app.net.StoreResult
import com.najvaa.app.vault.RoomVault
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Everything that happens inside one open room: the encrypted history on the
 * relay (polled), the live sessions (pushed), the outbox, read receipts,
 * self-destruct timers, reactions, edits and files. State is published as
 * flows; the UI never touches the vault or the network.
 */
class RoomEngine(
    private val context: Context,
    parentScope: CoroutineScope,
    val roomId: String,
    val code: String,
    private val keys: RoomKeys,
    private val vault: RoomVault,
    private val deviceId: String,
    private val myName: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onActivity(roomId: String, lastAt: Long, preview: String, unread: Int)
        fun onIncoming(roomId: String, message: Message)
        fun onPasswordMismatch(roomId: String)
        fun onNotice(roomId: String, text: String, warn: Boolean = false)
        fun onCodeTaken(roomId: String)
        fun onRoomClaimed(roomId: String)
    }

    private val scope = CoroutineScope(SupervisorJob(parentScope.coroutineContext[Job]) + Dispatchers.Default)
    private val state = Mutex()
    private var contents = RoomVault.Contents()
    private val seenIds = HashSet<String>()
    private var saveJob: Job? = null
    private var pollJob: Job? = null
    private var sweepJob: Job? = null
    private var seenFlushJob: Job? = null
    private val seenQueue = LinkedHashSet<String>()
    private var typingJob: Job? = null
    private var lastTypingSent = 0L
    private val pendingReacts = HashMap<String, MutableList<JSONObject>>()
    private val pendingEdits = HashMap<String, MutableList<JSONObject>>()
    private val claimedNotified = java.util.concurrent.atomic.AtomicBoolean(false)
    private var started = false
    @Volatile
    var foreground = false
        private set
    @Volatile
    var ttl = 0
        private set
    private var creating = false

    private val _messages = MutableStateFlow<List<Message>>(emptyList())
    val messages: StateFlow<List<Message>> = _messages
    private val _link = MutableStateFlow(LinkState.CONNECTING)
    val link: StateFlow<LinkState> = _link
    private val _peers = MutableStateFlow<List<PeerInfo>>(emptyList())
    val peers: StateFlow<List<PeerInfo>> = _peers
    private val _typing = MutableStateFlow(false)
    val typing: StateFlow<Boolean> = _typing
    private val _progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: StateFlow<Map<String, Float>> = _progress
    private val _files = MutableStateFlow<Map<String, File>>(emptyMap())
    val files: StateFlow<Map<String, File>> = _files
    private val _unread = MutableStateFlow(0)
    val unread: StateFlow<Int> = _unread
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices
    val names: Map<String, String> get() = contents.names
    private var socketConnected = false

    private val live = LiveRoom(
        scope, keys, deviceId, myName,
        object : LiveRoom.Handler {
            override suspend fun onInner(peer: String, o: JSONObject) = handleInner(peer, o)
            override fun onPeersChanged(peers: List<PeerInfo>) {
                _peers.value = peers
                refreshLink()
            }
            override fun onAuthFailed(peer: String) {
                listener.onNotice(roomId, "رمز یکی از دستگاه‌ها با شما یکی نیست؛ با آن دستگاه پیامی رد و بدل نشد", true)
            }
            override suspend fun onChunk(from: String, fileId: ByteArray, index: Int, ct: ByteArray) = Unit
            override fun onSocketState(connected: Boolean, closeCode: Int?) {
                socketConnected = connected
                when (closeCode) {
                    4001 -> _link.value = LinkState.FULL
                    4002 -> if (creating) listener.onCodeTaken(roomId)
                    else -> refreshLink()
                }
            }
            override fun onDue() {
                scope.launch { syncOnce() }
            }
        },
    )

    private fun refreshLink() {
        if (_link.value == LinkState.MISMATCH) return
        _link.value = when {
            _peers.value.any { it.secure } -> LinkState.LIVE
            socketConnected -> LinkState.CONNECTED
            else -> if (_link.value == LinkState.OFFLINE) LinkState.OFFLINE else LinkState.CONNECTING
        }
    }

    // ── lifecycle ──────────────────────────────────────────────────────────
    fun start(fresh: Boolean = false, initialTtl: Int = 0) {
        if (started) return
        started = true
        creating = fresh
        ttl = initialTtl
        scope.launch {
            val loaded = withContext(Dispatchers.IO) { vault.load() }
            state.withLock {
                contents = loaded
                contents.messages.forEach { seenIds += it.id }
                publish()
            }
            live.start(fresh)
            pollJob = launch { pollLoop() }
            sweepJob = launch { sweepLoop() }
        }
    }

    fun stop() {
        started = false
        live.stop()
        scope.cancel()
        vault.close()
        keys.wipe()
    }

    fun setForeground(value: Boolean) {
        foreground = value
        live.background = !value
        if (value) {
            live.probe()
            scope.launch { syncOnce() }
            scope.launch { state.withLock { _unread.value = 0; contents.messages.lastOrNull()?.let { listener.onActivity(roomId, it.orderTs, it.preview(), 0) } } }
        }
    }

    fun onNetworkBack() {
        live.probe()
        scope.launch { syncOnce() }
    }

    suspend fun safetyFor(peer: String) = live.safety(peer)

    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(350)
            val snapshot = state.withLock { RoomVault.Contents(contents.messages.toMutableList(), contents.cursor, contents.names.toMutableMap(), contents.seenByMe.toMutableSet()) }
            withContext(Dispatchers.IO) { vault.save(snapshot) }
        }
    }

    /** Under [state]. */
    private fun publish() {
        contents.messages.sortBy { it.orderTs }
        val next = contents.messages.filterNot { it.deleted }
        // Equal lists would still recompose every bubble and regroup thousands of rows.
        if (next != _messages.value) _messages.value = next
    }

    private fun emitNotice(text: String) {
        _notices.tryEmit(text)
    }

    // ── polling the store ──────────────────────────────────────────────────
    private suspend fun pollLoop() {
        while (scope.isActive) {
            syncOnce()
            val wait = when {
                _link.value == LinkState.MISMATCH -> 30_000L
                foreground && _link.value == LinkState.LIVE -> 30_000L
                foreground -> 10_000L
                else -> 60_000L
            }
            delay(wait)
        }
    }

    private val syncMutex = Mutex()

    /** [wait] = true (the scheduled job) queues behind a running sync instead of skipping. */
    suspend fun syncOnce(wait: Boolean = false) {
        if (wait) syncMutex.lock() else if (!syncMutex.tryLock()) return
        try {
            val cursor = state.withLock { contents.cursor }
            val initial = cursor <= 0L
            val result = if (initial) fetchAll() else fetchSince(cursor)
            when (result) {
                is StoreResult.Ok -> {
                    val page = result.value
                    if (page.items.isNotEmpty()) {
                        applyEntries(page.items, initial)
                        val newest = page.items.maxOf { it.ts }
                        state.withLock { contents.cursor = maxOf(contents.cursor, newest) }
                    } else if (initial) {
                        state.withLock { contents.cursor = (page.serverTime - 5_000).coerceAtLeast(1) }
                    }
                    scheduleSave()
                    if (_link.value == LinkState.OFFLINE || _link.value == LinkState.MISMATCH) _link.value = LinkState.CONNECTING
                    refreshLink()
                    flushOutbox()
                }
                StoreResult.Claimed -> {
                    _link.value = LinkState.MISMATCH
                    if (claimedNotified.compareAndSet(false, true)) listener.onPasswordMismatch(roomId)
                }
                StoreResult.Offline -> if (!socketConnected) _link.value = LinkState.OFFLINE
                is StoreResult.Http -> if (!socketConnected) _link.value = LinkState.OFFLINE
            }
        } finally {
            syncMutex.unlock()
        }
    }

    private suspend fun fetchAll(): StoreResult<LogPage> {
        val all = ArrayList<StoreEntry>()
        var before: Long? = null
        var serverTime = System.currentTimeMillis()
        repeat(20) {
            val page = Relay.log(keys, before = before, limit = 500)
            if (page !is StoreResult.Ok) return page
            serverTime = page.value.serverTime
            all += page.value.items
            if (!page.value.more || page.value.items.isEmpty()) return StoreResult.Ok(LogPage(all, false, serverTime))
            val next = page.value.items.last().ts
            if (before != null && next >= before!!) return StoreResult.Ok(LogPage(all, false, serverTime))
            before = next
        }
        return StoreResult.Ok(LogPage(all, false, serverTime))
    }

    private suspend fun fetchSince(cursor: Long): StoreResult<LogPage> {
        val all = ArrayList<StoreEntry>()
        val after = (cursor - 2_000L).coerceAtLeast(0L)
        var before: Long? = null
        var serverTime = System.currentTimeMillis()
        repeat(4) {
            val page = Relay.log(keys, after = after, before = before, limit = 500)
            if (page !is StoreResult.Ok) return page
            serverTime = page.value.serverTime
            all += page.value.items
            if (!page.value.more || page.value.items.isEmpty()) return StoreResult.Ok(LogPage(all, false, serverTime))
            val next = page.value.items.last().ts
            if (before != null && next >= before!!) return StoreResult.Ok(LogPage(all, false, serverTime))
            before = next
        }
        return StoreResult.Ok(LogPage(all, false, serverTime))
    }

    // Store entries already applied. The sync window overlaps the last one by a
    // couple of seconds (clock skew), so the newest entries come back on every poll;
    // skipping them saves a decrypt and, above all, a pointless republish.
    private val appliedIds = LinkedHashSet<String>()

    private suspend fun applyEntries(entriesIn: List<StoreEntry>, initial: Boolean) {
        val now = System.currentTimeMillis()
        val entries = synchronized(appliedIds) {
            val out = entriesIn.filter { appliedIds.add(it.id) }
            while (appliedIds.size > 4000) appliedIds.remove(appliedIds.first())
            out
        }
        if (entries.isEmpty()) return
        val events = withContext(Dispatchers.Default) {
            entries.sortedBy { it.ts }.mapNotNull { e ->
                if (e.exp > 0 && e.exp <= now) return@mapNotNull null
                val plain = keys.openHistory(e.id, e.iv, e.ct) ?: return@mapNotNull null
                val o = runCatching { JSONObject(Bytes.text(plain)) }.getOrNull() ?: return@mapNotNull null
                if (o.optString("id") != e.id) return@mapNotNull null
                o.put("_ts", e.ts).put("_exp", e.exp)
            }
        }
        val later = setOf("react", "seen", "edit", "note", "dl")
        val fresh = ArrayList<Message>()
        state.withLock {
            for (o in events) if (o.optString("k") !in later) applyHistoryEvent(o, initial)?.let { fresh += it }
            for (o in events) if (o.optString("k") in later) applyHistoryEvent(o, initial)
            publish()
        }
        if (com.najvaa.app.BuildConfig.DEBUG) android.util.Log.d("Najvaa/Sync", "applied ${entries.size} entries, fresh=${fresh.size}, initial=$initial, foreground=$foreground")
        if (!initial) {
            val incoming = fresh.filter { it.dir == Direction.IN }
            if (incoming.isNotEmpty()) {
                if (!foreground) {
                    state.withLock { _unread.value += incoming.size }
                    listener.onIncoming(roomId, incoming.last())
                }
                listener.onActivity(roomId, incoming.last().orderTs, incoming.last().preview(), _unread.value)
            } else fresh.lastOrNull()?.let { listener.onActivity(roomId, it.orderTs, it.preview(), _unread.value) }
        } else {
            contents.messages.lastOrNull()?.let { listener.onActivity(roomId, it.orderTs, it.preview(), _unread.value) }
        }
    }

    /** Under [state]. Returns a new message when one was added. */
    private fun applyHistoryEvent(o: JSONObject, initial: Boolean): Message? {
        val ts = o.optLong("_ts")
        val exp = o.optLong("_exp").takeIf { it > 0 }
        when (o.optString("k")) {
            "text" -> {
                val id = o.optString("id")
                if (id.isEmpty() || seenIds.contains(id)) {
                    index(id)?.let { i ->
                        val m = contents.messages[i]
                        var next = m
                        if (m.delivery == Delivery.QUEUED) next = next.copy(delivery = Delivery.STORED)
                        if (next.serverTs != ts) next = next.copy(serverTs = ts)
                        if (exp != null && next.expiresAt == null) next = next.copy(expiresAt = exp)
                        if (next !== m) contents.messages[i] = next
                    }
                    return null
                }
                val body = o.optString("body")
                if (body.isEmpty()) return null
                val author = o.optString("a")
                rememberName(author, o.optString("an"))
                val mine = author == deviceId
                val m = Message(
                    id = id,
                    dir = if (mine) Direction.OUT else Direction.IN,
                    kind = Kind.TEXT,
                    author = author,
                    authorName = o.optString("an"),
                    body = body.take(4000),
                    sentAt = o.optLong("ts").takeIf { it > 0 } ?: ts,
                    serverTs = ts,
                    ttl = clampTtl(o.optInt("ttl")),
                    expiresAt = exp,
                    reply = replyOf(o.optJSONObject("reply")),
                    delivery = Delivery.STORED,
                    readByMe = mine || initial || exp != null || contents.seenByMe.contains(id),
                )
                add(m)
                return m
            }
            "file" -> {
                val id = o.optString("id")
                if (!FILE_ID.matches(id) || seenIds.contains(id)) {
                    index(id)?.let { i ->
                        val m = contents.messages[i]
                        if (m.delivery == Delivery.QUEUED || m.serverTs != ts) contents.messages[i] = m.copy(delivery = if (m.delivery == Delivery.QUEUED) Delivery.STORED else m.delivery, serverTs = ts)
                    }
                    return null
                }
                val size = o.optLong("size", -1)
                val total = o.optInt("total")
                if (size < 0 || size > FileCodec.MAX_FILE || total != FileCodec.totalChunks(size) || !o.has("key")) return null
                val author = o.optString("a")
                rememberName(author, o.optString("an"))
                val mine = author == deviceId
                val m = fileMessage(o, if (mine) Direction.OUT else Direction.IN, o.optLong("ts").takeIf { it > 0 } ?: ts, ts, exp)
                    .copy(readByMe = mine || initial || exp != null || contents.seenByMe.contains(id))
                add(m)
                return m
            }
            "react" -> applyReaction(o.optString("target"), o.optString("a"), o.optString("an"), o.optString("e").ifEmpty { null }, o.optLong("ts").takeIf { it > 0 } ?: ts)
            "seen" -> {
                val ids = o.optJSONArray("ids") ?: return null
                val author = o.optString("a")
                for (i in 0 until minOf(ids.length(), 200)) {
                    val id = ids.optString(i)
                    if (author == deviceId) {
                        contents.seenByMe += id
                        index(id)?.let { k -> if (contents.messages[k].dir == Direction.IN) contents.messages[k] = contents.messages[k].copy(readByMe = true) }
                    } else {
                        markReadByPeer(id)
                    }
                }
            }
            "edit" -> applyEdit(o.optString("target"), o.optString("body"), o.optString("caption").ifEmpty { null }, o.optLong("ts").takeIf { it > 0 } ?: ts)
        }
        return null
    }

    private fun fileMessage(o: JSONObject, dir: Direction, sentAt: Long, serverTs: Long, exp: Long?): Message {
        val mime = o.optString("mime").take(100)
        val size = o.optLong("size")
        val isGif = o.optString("kind") == "gif" && Regex("^image/(gif|webp)$").matches(mime) && size <= 2L * 1024 * 1024
        val voice = o.optString("kind") == "voice" && FileCodec.AUDIO.matches(mime) && size <= FileCodec.VOICE_MAX_BYTES
        val kind = when {
            isGif -> Kind.GIF
            voice -> Kind.VOICE
            else -> when (FileCodec.kindOf(mime)) {
                "image" -> Kind.IMAGE
                "video" -> Kind.VIDEO
                "audio" -> Kind.AUDIO
                else -> Kind.FILE
            }
        }
        return Message(
            id = o.optString("id"),
            dir = dir,
            kind = kind,
            author = o.optString("a"),
            authorName = o.optString("an"),
            sentAt = sentAt,
            serverTs = serverTs,
            ttl = clampTtl(o.optInt("ttl")),
            expiresAt = exp,
            reply = replyOf(o.optJSONObject("reply")),
            delivery = Delivery.STORED,
            fileName = o.optString("name").ifEmpty { "file" }.take(200),
            mime = mime,
            size = size,
            chunks = o.optInt("total"),
            fileKey = o.optString("key"),
            caption = o.optString("caption").takeIf { it.isNotEmpty() }?.take(1000),
            voiceSeconds = if (voice) o.optInt("dur").coerceIn(0, 600) else 0,
            voiceWave = if (voice) o.optString("wave").takeIf { it.isNotEmpty() && it.length <= 120 } else null,
        )
    }

    private fun replyOf(r: JSONObject?): Reply? {
        if (r == null) return null
        val id = r.optString("id")
        if (id.isEmpty() || id.length > 32) return null
        return Reply(id, r.optString("a").takeIf { LiveRoom.PID.matches(it) }, r.optString("s").take(120), r.optString("k", "text").take(10))
    }

    private fun clampTtl(v: Int) = if (v in TTL_OPTIONS) v else 0

    private fun index(id: String): Int? = contents.messages.indexOfFirst { it.id == id }.takeIf { it >= 0 }

    /** Under [state]. */
    private fun add(m: Message) {
        seenIds += m.id
        contents.messages += m
        pendingReacts.remove(m.id)?.forEach { r ->
            applyReaction(m.id, r.optString("a"), r.optString("an"), r.optString("e").ifEmpty { null }, r.optLong("ts"))
        }
        pendingEdits.remove(m.id)?.forEach { e -> applyEdit(m.id, e.optString("body"), e.optString("caption").ifEmpty { null }, e.optLong("ts")) }
    }

    private fun rememberName(dev: String, name: String) {
        if (dev.isEmpty() || dev == deviceId) return
        val clean = name.replace(Regex("\\s+"), " ").trim().take(30)
        if (clean.isNotEmpty()) contents.names[dev] = clean
    }

    fun nameOf(dev: String): String = contents.names[dev] ?: live.devName(dev) ?: "طرف مقابل"

    /** Under [state]. */
    private fun applyReaction(target: String, author: String, authorName: String, emoji: String?, ts: Long): Message? {
        if (!LiveRoom.PID.matches(author)) return null
        val i = index(target) ?: run {
            val list = pendingReacts.getOrPut(target) { mutableListOf() }
            if (list.size < 20) list += JSONObject().put("a", author).put("an", authorName).put("e", emoji ?: "").put("ts", ts)
            return null
        }
        rememberName(author, authorName)
        val m = contents.messages[i]
        contents.messages[i] = if (author == deviceId) m.copy(myReaction = emoji) else {
            val next = m.peerReactions.toMutableMap()
            if (emoji == null) next.remove(author) else next[author] = emoji
            m.copy(peerReactions = next)
        }
        return null
    }

    /** Under [state]. */
    private fun applyEdit(target: String, body: String, caption: String?, ts: Long): Message? {
        val i = index(target) ?: run {
            val list = pendingEdits.getOrPut(target) { mutableListOf() }
            if (list.size < 20) list += JSONObject().put("body", body).put("caption", caption ?: "").put("ts", ts)
            return null
        }
        val m = contents.messages[i]
        contents.messages[i] = when {
            m.kind == Kind.TEXT && body.isNotBlank() -> m.copy(body = body.take(4000), edited = true)
            m.kind != Kind.TEXT && caption != null -> m.copy(caption = caption.take(1000), edited = true)
            else -> m
        }
        return null
    }

    /** Under [state]. A peer read my message: receipt, and the self-destruct clock starts. */
    private fun markReadByPeer(id: String) {
        val i = index(id) ?: return
        val m = contents.messages[i]
        if (m.dir != Direction.OUT) return
        val exp = m.expiresAt ?: if (m.ttl > 0) System.currentTimeMillis() + lifeOf(m) * 1000L else null
        contents.messages[i] = m.copy(delivery = Delivery.READ, expiresAt = exp)
    }

    private fun lifeOf(m: Message): Int = if (m.kind == Kind.VOICE) maxOf(m.ttl, m.voiceSeconds + 5) else m.ttl

    private fun serverLifeOf(m: Message): Int {
        val s = lifeOf(m)
        return TTL_OPTIONS.firstOrNull { it >= s && it > 0 } ?: s
    }

    // ── live inner messages ────────────────────────────────────────────────
    private suspend fun handleInner(peer: String, o: JSONObject) {
        when (o.optString("k")) {
            "confirm", "hi" -> {
                refreshLink()
                flushLiveOutbox()
            }
            "text" -> {
                val id = o.optString("id")
                if (id.isEmpty() || !o.has("body")) return
                live.postTo(peer, JSONObject().put("k", "ack").put("id", id))
                val m = state.withLock {
                    if (seenIds.contains(id)) return@withLock null
                    val author = o.optString("a").takeIf { LiveRoom.PID.matches(it) } ?: peer
                    rememberName(author, o.optString("an"))
                    val m = Message(
                        id = id, dir = Direction.IN, kind = Kind.TEXT, author = author, authorName = o.optString("an"),
                        body = o.optString("body").take(4000), sentAt = o.optLong("ts").takeIf { it > 0 } ?: System.currentTimeMillis(),
                        serverTs = System.currentTimeMillis(), ttl = clampTtl(o.optInt("ttl")), reply = replyOf(o.optJSONObject("reply")),
                        delivery = Delivery.DELIVERED,
                    )
                    add(m)
                    _typing.value = false
                    if (!foreground) _unread.value += 1
                    publish()
                    m
                }
                if (m != null) afterIncoming(m)
                scheduleSave()
            }
            "file" -> {
                val id = o.optString("id")
                if (!FILE_ID.matches(id)) return
                val size = o.optLong("size", -1)
                if (size < 0 || size > FileCodec.MAX_FILE || o.optInt("total") != FileCodec.totalChunks(size)) return
                if ((Bytes.unb64u(o.optString("key"))?.size ?: 0) != 32) return
                live.postTo(peer, JSONObject().put("k", "ack").put("id", id))
                val m = state.withLock {
                    if (seenIds.contains(id)) return@withLock null
                    val author = o.optString("a").takeIf { LiveRoom.PID.matches(it) } ?: peer
                    rememberName(author, o.optString("an"))
                    val m = fileMessage(o, Direction.IN, o.optLong("ts").takeIf { it > 0 } ?: System.currentTimeMillis(), System.currentTimeMillis(), null)
                        .copy(author = author, delivery = Delivery.DELIVERED)
                    add(m)
                    if (!foreground) _unread.value += 1
                    publish()
                    m
                }
                if (m != null) afterIncoming(m)
                scheduleSave()
            }
            "ack" -> state.withLock {
                index(o.optString("id"))?.let { i ->
                    val m = contents.messages[i]
                    if (m.dir == Direction.OUT && m.delivery != Delivery.READ) contents.messages[i] = m.copy(delivery = Delivery.DELIVERED)
                }
                publish()
            }
            "read" -> {
                state.withLock { markReadByPeer(o.optString("id")); publish() }
                scheduleSave()
            }
            "react" -> {
                state.withLock {
                    val author = o.optString("a").takeIf { LiveRoom.PID.matches(it) } ?: peer
                    applyReaction(o.optString("id"), author, o.optString("an"), o.optString("e").ifEmpty { null }, System.currentTimeMillis())
                    publish()
                }
                scheduleSave()
            }
            "typing" -> {
                _typing.value = true
                typingJob?.cancel()
                typingJob = scope.launch { delay(4_000); _typing.value = false }
            }
            "ttl" -> {
                ttl = clampTtl(o.optInt("v"))
                listener.onActivity(roomId, 0, "", -1)
                emitNotice(if (ttl > 0) "${nameOf(peer)} حذف خودکار را روی «${com.najvaa.app.core.ttlLabel(ttl)} پس از خواندن» گذاشت" else "${nameOf(peer)} حذف خودکار را خاموش کرد")
            }
            "edit" -> {
                state.withLock { applyEdit(o.optString("id"), o.optString("body"), o.optString("caption").ifEmpty { null }, o.optLong("ts")); publish() }
                scheduleSave()
            }
            "del" -> {
                val ids = o.optJSONArray("ids") ?: return
                val set = HashSet<String>()
                for (i in 0 until minOf(ids.length(), 2000)) set += ids.optString(i)
                removeLocal(set)
            }
            "clear" -> {
                state.withLock { contents.messages.clear(); publish() }
                _files.value = emptyMap()
                scheduleSave()
                emitNotice("${nameOf(peer)} گفتگو را برای همه پاک کرد")
            }
            "shot" -> {
                emitNotice("⚠ ${nameOf(peer)} احتمالاً از صفحه عکس گرفت")
                listener.onNotice(roomId, "${nameOf(peer)} احتمالاً از صفحه عکس گرفت", true)
            }
            "saved" -> emitNotice("${nameOf(peer)} یک مورد را در دستگاه خود ماندگار کرد")
        }
    }

    private fun afterIncoming(m: Message) {
        listener.onActivity(roomId, m.orderTs, m.preview(), _unread.value)
        if (!foreground) listener.onIncoming(roomId, m)
    }

    private suspend fun removeLocal(ids: Set<String>) {
        state.withLock {
            contents.messages.removeAll { it.id in ids }
            publish()
        }
        _files.value = _files.value.filterKeys { it !in ids }
        ids.forEach { id -> _files.value[id]?.let { com.najvaa.app.vault.SecureFiles.shred(it) } }
        scheduleSave()
    }

    // ── sending ────────────────────────────────────────────────────────────
    fun sendText(raw: String, reply: Reply? = null) {
        val body = raw.trim().take(4000)
        if (body.isEmpty()) return
        val now = System.currentTimeMillis()
        val m = Message(
            id = Bytes.b64u(Bytes.random(9)), dir = Direction.OUT, kind = Kind.TEXT, author = deviceId, authorName = myName,
            body = body, sentAt = now, serverTs = now, ttl = ttl, reply = reply, delivery = Delivery.QUEUED, readByMe = true,
        )
        scope.launch {
            state.withLock { add(m); publish() }
            listener.onActivity(roomId, now, body, 0)
            scheduleSave()
            flushOutbox()
        }
    }

    private fun textEvent(m: Message): JSONObject {
        val o = JSONObject().put("k", "text").put("id", m.id).put("body", m.body).put("ttl", m.ttl).put("ts", m.sentAt).put("a", deviceId).put("an", myName)
        m.reply?.let { o.put("reply", JSONObject().put("id", it.id).put("a", it.author ?: JSONObject.NULL).put("s", it.snippet).put("k", it.kind)) }
        return o
    }

    private fun fileEvent(m: Message): JSONObject {
        val kind = when (m.kind) {
            Kind.IMAGE -> "image"; Kind.VIDEO -> "video"; Kind.AUDIO -> "audio"; Kind.VOICE -> "voice"; Kind.GIF -> "gif"; else -> "file"
        }
        val o = JSONObject().put("k", "file").put("id", m.id).put("name", m.fileName ?: "file").put("mime", m.mime ?: "application/octet-stream")
            .put("size", m.size).put("total", m.chunks).put("key", m.fileKey).put("ttl", m.ttl).put("kind", kind).put("ts", m.sentAt)
            .put("a", deviceId).put("an", myName)
        if (m.kind == Kind.VOICE) {
            o.put("dur", m.voiceSeconds)
            m.voiceWave?.let { o.put("wave", it) }
        }
        m.caption?.let { o.put("caption", it) }
        m.reply?.let { o.put("reply", JSONObject().put("id", it.id).put("a", it.author ?: JSONObject.NULL).put("s", it.snippet).put("k", it.kind)) }
        return o
    }

    private val liveSent = HashSet<String>()
    private val flushMutex = Mutex()

    /** Posts queued messages to the live sessions (instant) and the store (durable). */
    private suspend fun flushOutbox() {
        if (!flushMutex.tryLock()) return
        try {
            flushLiveOutbox()
            val queued = state.withLock { contents.messages.filter { it.dir == Direction.OUT && it.delivery == Delivery.QUEUED && (it.kind == Kind.TEXT || it.chunks > 0 && uploaded.contains(it.id)) } }
            for (m in queued.take(30)) {
                val event = if (m.kind == Kind.TEXT) textEvent(m) else fileEvent(m)
                val (iv, ct) = withContext(Dispatchers.Default) { keys.sealHistory(m.id, Bytes.utf8(event.toString())) }
                when (val r = Relay.post(keys, m.id, iv, ct, blob = m.kind != Kind.TEXT)) {
                    is StoreResult.Ok -> {
                        state.withLock {
                            index(m.id)?.let { i ->
                                val cur = contents.messages[i]
                                contents.messages[i] = cur.copy(delivery = if (cur.delivery == Delivery.QUEUED) Delivery.STORED else cur.delivery, serverTs = r.value)
                            }
                            contents.cursor = maxOf(contents.cursor, r.value)
                            publish()
                        }
                        scheduleSave()
                    }
                    StoreResult.Claimed -> {
                        _link.value = LinkState.MISMATCH
                        if (claimedNotified.compareAndSet(false, true)) listener.onPasswordMismatch(roomId)
                        return
                    }
                    else -> return
                }
            }
        } finally {
            flushMutex.unlock()
        }
    }

    private suspend fun flushLiveOutbox() {
        if (live.securePeers().isEmpty()) return
        val pending = state.withLock {
            contents.messages.filter { it.dir == Direction.OUT && it.delivery != Delivery.READ && it.delivery != Delivery.DELIVERED && it.id !in liveSent && (it.kind == Kind.TEXT || uploaded.contains(it.id)) }
        }
        for (m in pending) {
            val reached = live.post(if (m.kind == Kind.TEXT) textEvent(m) else fileEvent(m))
            if (reached.isNotEmpty()) liveSent += m.id
        }
    }

    fun sendTyping() {
        val now = System.currentTimeMillis()
        if (now - lastTypingSent < 2_500) return
        lastTypingSent = now
        scope.launch { live.post(JSONObject().put("k", "typing")) }
    }

    // ── reading, timers ────────────────────────────────────────────────────
    /** Called by the chat screen for incoming messages that are on screen. */
    fun markRead(ids: Collection<String>) {
        if (ids.isEmpty() || !foreground) return
        scope.launch {
            val toExpire = ArrayList<Pair<String, Long>>()
            val toTell = ArrayList<Message>()
            state.withLock {
                for (id in ids) {
                    val i = index(id) ?: continue
                    val m = contents.messages[i]
                    if (m.dir != Direction.IN || m.readByMe) continue
                    val exp = if (m.ttl > 0 && m.expiresAt == null) System.currentTimeMillis() + lifeOf(m) * 1000L else m.expiresAt
                    contents.messages[i] = m.copy(readByMe = true, expiresAt = exp)
                    contents.seenByMe += id
                    toTell += m
                    if (m.ttl > 0 && m.expiresAt == null) toExpire += id to (System.currentTimeMillis() + serverLifeOf(m) * 1000L)
                    seenQueue += id
                }
                publish()
            }
            for (m in toTell) live.post(JSONObject().put("k", "read").put("id", m.id))
            toExpire.forEach { (id, exp) -> Relay.expire(keys, listOf(id), exp) }
            if (toTell.isNotEmpty()) {
                scheduleSave()
                queueSeenFlush()
            }
        }
    }

    private fun queueSeenFlush() {
        seenFlushJob?.cancel()
        seenFlushJob = scope.launch {
            delay(1_500)
            val ids = state.withLock { seenQueue.toList().take(200).also { seenQueue.removeAll(it.toSet()) } }
            if (ids.isEmpty()) return@launch
            val event = JSONObject().put("k", "seen").put("id", Bytes.b64u(Bytes.random(12))).put("ids", JSONArray(ids)).put("a", deviceId).put("an", myName)
            val (iv, ct) = withContext(Dispatchers.Default) { keys.sealHistory(event.getString("id"), Bytes.utf8(event.toString())) }
            Relay.post(keys, event.getString("id"), iv, ct)
            if (seenQueue.isNotEmpty()) queueSeenFlush()
        }
    }

    private suspend fun sweepLoop() {
        while (scope.isActive) {
            delay(1_000)
            val now = System.currentTimeMillis()
            val gone = state.withLock {
                val expired = contents.messages.filter { it.expiresAt != null && it.expiresAt!! <= now }
                if (expired.isNotEmpty()) {
                    contents.messages.removeAll { it.expiresAt != null && it.expiresAt!! <= now }
                    publish()
                }
                expired
            }
            if (gone.isNotEmpty()) {
                gone.forEach { m -> _files.value[m.id]?.let { com.najvaa.app.vault.SecureFiles.shred(it) } }
                _files.value = _files.value.filterKeys { k -> gone.none { it.id == k } }
                scheduleSave()
            }
        }
    }

    // ── actions ────────────────────────────────────────────────────────────
    fun react(id: String, emoji: String?) {
        scope.launch {
            state.withLock { applyReaction(id, deviceId, myName, emoji, System.currentTimeMillis()); publish() }
            scheduleSave()
            live.post(JSONObject().put("k", "react").put("id", id).put("e", emoji ?: JSONObject.NULL).put("t", "").put("a", deviceId).put("an", myName))
            val eid = Bytes.b64u(Bytes.random(12))
            val event = JSONObject().put("k", "react").put("id", eid).put("target", id).put("a", deviceId).put("an", myName).put("e", emoji ?: JSONObject.NULL).put("t", "")
            val (iv, ct) = withContext(Dispatchers.Default) { keys.sealHistory(eid, Bytes.utf8(event.toString())) }
            Relay.post(keys, eid, iv, ct)
        }
    }

    fun edit(id: String, body: String) {
        val clean = body.trim().take(4000)
        if (clean.isEmpty()) return
        scope.launch {
            val ok = state.withLock {
                val i = index(id) ?: return@withLock false
                val m = contents.messages[i]
                if (m.dir != Direction.OUT || m.kind != Kind.TEXT || m.body == clean) return@withLock false
                contents.messages[i] = m.copy(body = clean, edited = true)
                publish()
                true
            }
            if (!ok) return@launch
            scheduleSave()
            val eid = Bytes.b64u(Bytes.random(12))
            val ts = System.currentTimeMillis()
            live.post(JSONObject().put("k", "edit").put("id", id).put("eid", eid).put("body", clean).put("ts", ts).put("a", deviceId))
            val event = JSONObject().put("k", "edit").put("id", eid).put("target", id).put("a", deviceId).put("body", clean).put("ts", ts)
            val (iv, ct) = withContext(Dispatchers.Default) { keys.sealHistory(eid, Bytes.utf8(event.toString())) }
            Relay.post(keys, eid, iv, ct)
        }
    }

    fun delete(ids: List<String>, everyone: Boolean) {
        scope.launch {
            removeLocal(ids.toSet())
            if (everyone) {
                live.post(JSONObject().put("k", "del").put("ids", JSONArray(ids)))
                Relay.delete(keys, ids)
            }
        }
    }

    fun clearAll() {
        scope.launch {
            state.withLock { contents.messages.clear(); publish() }
            _files.value.values.forEach { com.najvaa.app.vault.SecureFiles.shred(it) }
            _files.value = emptyMap()
            scheduleSave()
            live.post(JSONObject().put("k", "clear"))
            Relay.clear(keys)
        }
    }

    fun setTtl(value: Int) {
        ttl = clampTtl(value)
        scope.launch { live.post(JSONObject().put("k", "ttl").put("v", ttl)) }
    }

    fun reportScreenshot() {
        scope.launch { live.post(JSONObject().put("k", "shot")) }
    }

    suspend fun usage() = Relay.usage(keys)

    // ── files ──────────────────────────────────────────────────────────────
    private val uploaded = HashSet<String>()

    fun sendFile(picked: FileCodec.Picked, caption: String? = null, voiceSeconds: Int = 0, wave: String? = null, reply: Reply? = null, gif: Boolean = false) {
        scope.launch {
            val idBytes = Bytes.random(12)
            val id = Bytes.b64u(idBytes)
            val key = Bytes.random(32)
            val size = picked.bytes.size.toLong()
            val total = FileCodec.totalChunks(size)
            val voice = voiceSeconds > 0 && FileCodec.AUDIO.matches(picked.mime) && size <= FileCodec.VOICE_MAX_BYTES
            val isGif = gif && Regex("^image/(gif|webp)$").matches(picked.mime) && size <= 2L * 1024 * 1024
            val kind = when {
                isGif -> Kind.GIF
                voice -> Kind.VOICE
                else -> when (FileCodec.kindOf(picked.mime)) {
                    "image" -> Kind.IMAGE; "video" -> Kind.VIDEO; "audio" -> Kind.AUDIO; else -> Kind.FILE
                }
            }
            val now = System.currentTimeMillis()
            val m = Message(
                id = id, dir = Direction.OUT, kind = kind, author = deviceId, authorName = myName, sentAt = now, serverTs = now, ttl = ttl,
                reply = reply, delivery = Delivery.QUEUED, readByMe = true, fileName = picked.name.take(200), mime = picked.mime, size = size,
                chunks = total, fileKey = Bytes.b64u(key), caption = caption?.trim()?.take(1000)?.takeIf { it.isNotEmpty() },
                voiceSeconds = if (voice) voiceSeconds.coerceIn(0, 600) else 0, voiceWave = if (voice) wave else null,
            )
            // Keep the plaintext for this device under cache/open (wiped on lock).
            val local = File(FileCodec.openDir(context.cacheDir), "$id.${FileCodec.extensionFor(picked.mime, picked.name)}")
            withContext(Dispatchers.IO) { local.writeBytes(picked.bytes) }
            _files.value = _files.value + (id to local)
            state.withLock { add(m); publish() }
            listener.onActivity(roomId, now, m.preview(), 0)
            scheduleSave()

            val targets = live.securePeers().toMutableList()
            if (targets.isNotEmpty()) live.post(fileEvent(m))
            var failed = false
            val jobs = ArrayList<kotlinx.coroutines.Deferred<Boolean>>()
            for (i in 0 until total) {
                val start = i * FileCodec.CHUNK
                val end = minOf(picked.bytes.size, start + FileCodec.CHUNK)
                val ct = withContext(Dispatchers.Default) { FileCodec.encryptChunk(key, idBytes, i, total, picked.bytes.copyOfRange(start, end), voice) }
                for (pid in targets) {
                    Bytes.unb64u(pid)?.let { to -> live.sendBinary(Bytes.concat(byteArrayOf(1), to, idBytes, Bytes.u32(i), ct)) }
                }
                jobs += async {
                    repeat(3) { attempt ->
                        if (Relay.putChunk(keys, id, i, ct) is StoreResult.Ok) return@async true
                        delay(1_000L * (attempt + 1))
                    }
                    false
                }
                _progress.value = _progress.value + (id to (i + 1).toFloat() / total)
                if (jobs.size >= 3) {
                    if (!jobs.awaitAll().all { it }) { failed = true; break }
                    jobs.clear()
                }
            }
            if (!failed && !jobs.awaitAll().all { it }) failed = true
            _progress.value = _progress.value - id
            Bytes.wipe(key)
            if (failed) {
                listener.onNotice(roomId, "ذخیره‌ی فایل روی سرور انجام نشد", true)
                return@launch
            }
            uploaded += id
            liveSent += id
            flushOutbox()
        }
    }

    /** Fetches and decrypts a file from the store into cache/open; waits for chunks still uploading. */
    fun download(id: String) {
        if (_files.value.containsKey(id) || _progress.value.containsKey(id)) return
        scope.launch { fetchFile(id) }
    }

    /**
     * Returns the decrypted local copy of [id], fetching it when needed. A fetch
     * already running for the same file is waited on instead of started twice.
     */
    suspend fun fetchFile(id: String, quiet: Boolean = false): File? {
        _files.value[id]?.let { return it }
        if (_progress.value.containsKey(id)) {
            while (_progress.value.containsKey(id)) delay(200)
            return _files.value[id]
        }
        val m = state.withLock { index(id)?.let { contents.messages[it] } } ?: return null
        val key = m.fileKey?.let { Bytes.unb64u(it) } ?: return null
        val idBytes = Bytes.unb64u(id) ?: return null
        val out = File(FileCodec.openDir(context.cacheDir), "$id.${FileCodec.extensionFor(m.mime, m.fileName)}")
        val tmp = File(out.parentFile, "$id.part")
        _progress.value = _progress.value + (id to 0f)
        var ok = true
        var lastNew = System.currentTimeMillis()
        try {
            withContext(Dispatchers.IO) {
                tmp.outputStream().use { os ->
                    var i = 0
                    while (i < m.chunks) {
                        when (val r = Relay.getChunk(keys, id, i)) {
                            is StoreResult.Ok -> {
                                val pt = FileCodec.decryptChunk(key, idBytes, i, m.chunks, m.size, r.value)
                                if (pt == null) { ok = false; break }
                                os.write(pt)
                                lastNew = System.currentTimeMillis()
                                i++
                                _progress.value = _progress.value + (id to i.toFloat() / m.chunks)
                            }
                            is StoreResult.Http -> {
                                if (r.code != 404 || System.currentTimeMillis() - lastNew > 180_000) { ok = false; break }
                                delay(3_000)
                            }
                            else -> { ok = false; break }
                        }
                    }
                }
            }
        } catch (e: CancellationException) {
            ok = false
            throw e
        } finally {
            Bytes.wipe(key)
            _progress.value = _progress.value - id
            if (!ok) com.najvaa.app.vault.SecureFiles.shred(tmp)
        }
        if (ok && tmp.renameTo(out)) {
            _files.value = _files.value + (id to out)
            return out
        }
        com.najvaa.app.vault.SecureFiles.shred(tmp)
        if (!quiet) listener.onNotice(roomId, "دریافت فایل از سرور انجام نشد", true)
        return null
    }

    // ── export to the phone's gallery ──────────────────────────────────────
    data class ExportState(val total: Int, val done: Int, val saved: Int, val failed: Int, val finished: Boolean = false)

    private val _export = MutableStateFlow<ExportState?>(null)
    val export: StateFlow<ExportState?> = _export
    private var exportJob: Job? = null

    /**
     * Decrypts each file and copies it into shared storage. Files that were not
     * already open on this device are shredded again right after the copy, so
     * the export leaves no extra plaintext inside the app.
     */
    fun exportToGallery(ids: List<String>) {
        if (exportJob?.isActive == true || ids.isEmpty()) return
        exportJob = scope.launch {
            var st = ExportState(ids.size, 0, 0, 0)
            _export.value = st
            for (id in ids) {
                val m = state.withLock { index(id)?.let { contents.messages[it] } }
                val hadLocal = _files.value.containsKey(id)
                val f = if (m == null || !m.isFile) null else fetchFile(id, quiet = true)
                val ok = f != null && m != null && withContext(Dispatchers.IO) {
                    com.najvaa.app.files.GallerySaver.save(context, f, m.mime, m.fileName ?: "najva-$id.${FileCodec.extensionFor(m.mime, null)}")
                }
                if (f != null && !hadLocal) {
                    _files.value = _files.value - id
                    withContext(Dispatchers.IO) { com.najvaa.app.vault.SecureFiles.shred(f) }
                }
                st = st.copy(done = st.done + 1, saved = st.saved + if (ok) 1 else 0, failed = st.failed + if (ok) 0 else 1)
                _export.value = st
            }
            _export.value = st.copy(finished = true)
        }
    }

    fun cancelExport() {
        exportJob?.cancel()
        exportJob = null
        _export.value = _export.value?.copy(finished = true)
    }

    fun dismissExport() {
        if (exportJob?.isActive != true) _export.value = null
    }

    fun forgetLocalFiles() {
        exportJob?.cancel()
        _export.value = null
        _files.value.values.forEach { com.najvaa.app.vault.SecureFiles.shred(it) }
        _files.value = emptyMap()
    }

    companion object {
        val FILE_ID = Regex("^[A-Za-z0-9_-]{16}$")
    }
}
