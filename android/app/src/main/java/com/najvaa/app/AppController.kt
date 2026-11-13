package com.najvaa.app

import android.app.Application
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import androidx.core.content.ContextCompat
import com.najvaa.app.core.Bytes
import com.najvaa.app.core.roomTitle
import com.najvaa.app.core.spacedCode
import com.najvaa.app.crypto.RoomKeys
import com.najvaa.app.data.Message
import com.najvaa.app.data.Room
import com.najvaa.app.data.Settings
import com.najvaa.app.data.SettingsStore
import com.najvaa.app.engine.RoomEngine
import com.najvaa.app.net.Relay
import com.najvaa.app.net.StoreResult
import com.najvaa.app.notify.Notifier
import com.najvaa.app.service.ConnectionService
import com.najvaa.app.vault.DeviceKey
import com.najvaa.app.vault.MasterVault
import com.najvaa.app.vault.RoomVault
import com.najvaa.app.vault.SecureFiles
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher

data class Toast(val text: String, val warn: Boolean = false)

sealed interface UnlockResult {
    data object Ok : UnlockResult
    data class Wrong(val attemptsLeft: Int, val waitMillis: Long) : UnlockResult
    data object Wiped : UnlockResult
}

sealed interface JoinResult {
    data class Ok(val room: Room) : JoinResult
    data object WrongPassword : JoinResult
    data object Offline : JoinResult
    data object AlreadyHere : JoinResult
}

/**
 * The one object the UI talks to. It owns the vault, the open room engines,
 * the lock state and the settings. Keys live only inside engines and only
 * while the vault is open; a hard lock drops all of them.
 */
class AppController(private val app: Application) : RoomEngine.Listener {

    val vault = MasterVault(app)
    val notifier = Notifier(app)
    private val settingsStore = SettingsStore(app)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val engines = LinkedHashMap<String, RoomEngine>()
    private val engineMutex = Mutex()
    private var index: MasterVault.Index? = null
    private var lockJob: Job? = null
    private var clipJob: Job? = null

    private val _settings = MutableStateFlow(settingsStore.load())
    val settings: StateFlow<Settings> = _settings
    private val _rooms = MutableStateFlow<List<Room>>(emptyList())
    val rooms: StateFlow<List<Room>> = _rooms
    private val _locked = MutableStateFlow(true)
    val locked: StateFlow<Boolean> = _locked
    private val _toasts = MutableSharedFlow<Toast>(extraBufferCapacity = 8)
    val toasts: SharedFlow<Toast> = _toasts
    private val _activeRoom = MutableStateFlow<String?>(null)
    val activeRoom: StateFlow<String?> = _activeRoom
    private val _pendingOpen = MutableStateFlow<String?>(null)
    val pendingOpen: StateFlow<String?> = _pendingOpen

    val isSetUp: Boolean get() = vault.isSetUp
    val onboarded: Boolean get() = settingsStore.onboarded
    val deviceId: String get() = index?.deviceId ?: ""
    var suppressLockUntil = 0L

    init {
        notifier.ensureChannels(_settings.value)
    }

    fun toast(text: String, warn: Boolean = false) {
        _toasts.tryEmit(Toast(text, warn))
    }

    fun finishOnboarding() {
        settingsStore.onboarded = true
    }

    // ── vault lifecycle ────────────────────────────────────────────────────
    suspend fun setUp(password: String) {
        withContext(Dispatchers.Default) { vault.setUp(password) }
        settingsStore.failedAttempts = 0
        afterOpen()
    }

    val lockoutRemaining: Long get() = (settingsStore.lockoutUntil - System.currentTimeMillis()).coerceAtLeast(0)
    val attemptsUsed: Int get() = settingsStore.failedAttempts

    suspend fun unlock(password: String): UnlockResult {
        if (lockoutRemaining > 0) return UnlockResult.Wrong(attemptsLeft(), lockoutRemaining)
        val duress = _settings.value.duressEnabled && withContext(Dispatchers.Default) { vault.isDuress(password) }
        if (duress) {
            wipe()
            return UnlockResult.Wiped
        }
        val ok = withContext(Dispatchers.Default) { vault.open(password) }
        if (!ok) return wrongAttempt()
        settingsStore.failedAttempts = 0
        settingsStore.lockoutUntil = 0
        afterOpen()
        return UnlockResult.Ok
    }

    private fun attemptsLeft() = (_settings.value.wipeAfterFailures - settingsStore.failedAttempts).coerceAtLeast(0)

    private fun wrongAttempt(): UnlockResult {
        val n = settingsStore.failedAttempts + 1
        settingsStore.failedAttempts = n
        val max = _settings.value.wipeAfterFailures
        if (max > 0 && n >= max) {
            wipe()
            return UnlockResult.Wiped
        }
        val wait = when {
            n >= 4 -> 120_000L
            n >= 3 -> 30_000L
            else -> 0L
        }
        if (wait > 0) settingsStore.lockoutUntil = System.currentTimeMillis() + wait
        return UnlockResult.Wrong((max - n).coerceAtLeast(0), wait)
    }

    /** Biometric path: the prompt authenticated [cipher] for the wrapped master key. */
    suspend fun unlockWithDevice(cipher: Cipher): Boolean {
        val blob = vault.wrappedBlob() ?: return false
        val key = DeviceKey.unwrap(cipher, blob) ?: return false
        val ok = vault.openWithKey(key)
        Bytes.wipe(key)
        if (!ok) return false
        settingsStore.failedAttempts = 0
        afterOpen()
        return true
    }

    fun wrappedBlob(): ByteArray? = vault.wrappedBlob()

    fun canUseBiometric(): Boolean = _settings.value.biometric && vault.hasBiometricWrap

    /** After a successful prompt with an encrypt cipher: stores the wrapped master key. */
    fun completeBiometricEnrol(cipher: Cipher): Boolean {
        val key = vault.masterKeyCopy() ?: return false
        val blob = DeviceKey.wrap(cipher, key)
        Bytes.wipe(key)
        if (blob == null) return false
        vault.storeWrapped(blob)
        return true
    }

    fun disableBiometric() {
        vault.storeWrapped(null)
        DeviceKey.delete()
    }

    private suspend fun afterOpen() {
        val idx = withContext(Dispatchers.Default) { vault.loadIndex() } ?: MasterVault.Index()
        if (idx.deviceId.isEmpty()) {
            idx.deviceId = Bytes.b64u(Bytes.random(12))
            vault.saveIndex(idx)
        }
        index = idx
        _locked.value = false
        publishRooms()
        notifier.clearAll()
        engineMutex.withLock { idx.rooms.forEach { startEngine(it) } }
        if (_settings.value.backgroundLink) ConnectionService.start(app)
    }

    private fun publishRooms() {
        val idx = index ?: return
        _rooms.value = idx.rooms.map { r ->
            Room(r.id, r.code, r.title, r.createdAt, r.lastAt, r.preview, r.unread, r.pinned, r.muted, r.ttl, r.myName, r.waiting)
        }.sortedWith(compareByDescending<Room> { it.pinned }.thenByDescending { it.lastAt })
    }

    private fun persistIndex() {
        val idx = index ?: return
        scope.launch(Dispatchers.IO) { vault.saveIndex(idx) }
    }

    /** Requires engineMutex. */
    private suspend fun startEngine(r: MasterVault.IndexRoom, fresh: Boolean = false) {
        if (engines.containsKey(r.id)) return
        val keys = withContext(Dispatchers.Default) {
            vault.openBytes(r.sealedKeys, "room-keys")?.let { RoomKeys.restore(r.code, it) }
                ?: vault.openPassword(r.sealedPassword)?.let { pw -> RoomKeys.derive(r.code, pw).also { k -> r.sealedKeys = vault.sealBytes(k.export(), "room-keys"); persistIndex() } }
        } ?: return
        val roomVault = RoomVault(File(vault.roomsDir, "${r.id}.njv"), keys.vaultKey, r.vaultSalt)
        val engine = RoomEngine(app, scope, r.id, r.code, keys, roomVault, index?.deviceId ?: "", r.myName.ifEmpty { "موبایل نجوا" }, this)
        engines[r.id] = engine
        engine.start(fresh, r.ttl)
    }

    fun engine(roomId: String): RoomEngine? = engines[roomId]

    fun room(roomId: String): Room? = _rooms.value.firstOrNull { it.id == roomId }

    fun openRoom(roomId: String) {
        _activeRoom.value?.let { engines[it]?.setForeground(false) }
        _activeRoom.value = roomId
        _pendingOpen.value = null
        engines[roomId]?.setForeground(true)
        notifier.clear(roomId)
        index?.rooms?.firstOrNull { it.id == roomId }?.let { it.unread = 0; it.waiting = false }
        index?.lastRoom = roomId
        publishRooms()
        persistIndex()
    }

    fun closeRoom() {
        _activeRoom.value?.let { engines[it]?.setForeground(false) }
        _activeRoom.value = null
    }

    fun requestOpen(roomId: String) {
        _pendingOpen.value = roomId
    }

    // ── rooms ──────────────────────────────────────────────────────────────
    fun newCode(): String = (1_000_000 + SecureRandom().nextInt(9_000_000)).toString()

    fun newPassword(): String {
        val alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        val r = SecureRandom()
        return buildString(14) { repeat(14) { append(alphabet[r.nextInt(alphabet.length)]) } }
    }

    suspend fun createRoom(code: String, password: String, title: String?): Room? {
        val idx = index ?: return null
        if (idx.rooms.any { it.code == code }) return null
        val keys = withContext(Dispatchers.Default) { RoomKeys.derive(code, password) }
        // A code that already has stored history belongs to someone else.
        if (Relay.log(keys, limit = 1) is StoreResult.Claimed) {
            keys.wipe()
            return null
        }
        val r = indexRoom(code, password, title, keys)
        idx.rooms += r
        vault.saveIndex(idx)
        publishRooms()
        engineMutex.withLock { startEngine(r, fresh = true) }
        return room(r.id)
    }

    private fun indexRoom(code: String, password: String, title: String?, keys: RoomKeys): MasterVault.IndexRoom {
        val now = System.currentTimeMillis()
        return MasterVault.IndexRoom(
            id = Bytes.b64u(Bytes.random(9)), code = code, title = title?.trim()?.takeIf { it.isNotEmpty() } ?: roomTitle(code),
            createdAt = now, lastAt = now, preview = "", unread = 0, pinned = false, muted = false, ttl = 0, myName = "",
            waiting = true, sealedPassword = vault.sealPassword(password), vaultSalt = Bytes.b64u(Bytes.random(16)),
            sealedKeys = vault.sealBytes(keys.export(), "room-keys"),
        )
    }

    suspend fun joinRoom(code: String, password: String, title: String?): JoinResult {
        val idx = index ?: return JoinResult.Offline
        if (idx.rooms.any { it.code == code }) return JoinResult.AlreadyHere
        val keys = withContext(Dispatchers.Default) { RoomKeys.derive(code, password) }
        when (val probe = Relay.log(keys, limit = 1)) {
            StoreResult.Claimed -> { keys.wipe(); return JoinResult.WrongPassword }
            StoreResult.Offline -> { keys.wipe(); return JoinResult.Offline }
            is StoreResult.Http -> { keys.wipe(); return JoinResult.Offline }
            is StoreResult.Ok -> Unit
        }
        val r = indexRoom(code, password, title, keys).also { it.waiting = false }
        idx.rooms += r
        vault.saveIndex(idx)
        publishRooms()
        engineMutex.withLock { startEngine(r) }
        return JoinResult.Ok(room(r.id)!!)
    }

    fun deleteRoom(roomId: String) {
        val idx = index ?: return
        scope.launch {
            engineMutex.withLock { engines.remove(roomId)?.let { it.forgetLocalFiles(); it.stop() } }
            idx.rooms.removeAll { it.id == roomId }
            if (idx.lastRoom == roomId) idx.lastRoom = null
            withContext(Dispatchers.IO) {
                vault.saveIndex(idx)
                SecureFiles.shred(File(vault.roomsDir, "$roomId.njv"))
            }
            if (_activeRoom.value == roomId) _activeRoom.value = null
            publishRooms()
            toast("اتاق از این گوشی پاک شد")
        }
    }

    fun updateRoom(roomId: String, transform: (MasterVault.IndexRoom) -> Unit) {
        val r = index?.rooms?.firstOrNull { it.id == roomId } ?: return
        transform(r)
        publishRooms()
        persistIndex()
    }

    fun roomPassword(roomId: String): String? =
        index?.rooms?.firstOrNull { it.id == roomId }?.let { vault.openPassword(it.sealedPassword) }

    // ── engine events ──────────────────────────────────────────────────────
    override fun onActivity(roomId: String, lastAt: Long, preview: String, unread: Int) {
        scope.launch {
            val r = index?.rooms?.firstOrNull { it.id == roomId } ?: return@launch
            if (lastAt > 0) r.lastAt = maxOf(r.lastAt, lastAt)
            if (preview.isNotEmpty()) r.preview = preview.take(80)
            if (unread >= 0) r.unread = unread
            if (lastAt > 0) r.waiting = false
            engines[roomId]?.let { r.ttl = it.ttl }
            publishRooms()
            persistIndex()
        }
    }

    override fun onIncoming(roomId: String, message: Message) {
        if (BuildConfig.DEBUG) android.util.Log.d("Najvaa/Notify", "incoming for $roomId muted=${index?.rooms?.firstOrNull { it.id == roomId }?.muted}")
        val r = index?.rooms?.firstOrNull { it.id == roomId } ?: return
        if (r.muted) return
        scope.launch {
            val count = engines[roomId]?.unread?.value ?: 1
            notifier.showMessage(_settings.value, roomId, r.title, count)
        }
    }

    override fun onPasswordMismatch(roomId: String) {
        val r = index?.rooms?.firstOrNull { it.id == roomId } ?: return
        scope.launch { toast("رمز اتاق «${r.title}» با تاریخچه‌ی سرور نمی‌خواند", warn = true) }
    }

    override fun onNotice(roomId: String, text: String, warn: Boolean) {
        scope.launch { toast(text, warn) }
    }

    override fun onCodeTaken(roomId: String) {
        scope.launch {
            val r = index?.rooms?.firstOrNull { it.id == roomId } ?: return@launch
            val pw = vault.openPassword(r.sealedPassword) ?: return@launch
            deleteRoom(roomId)
            delay(200)
            toast("این کد در حال استفاده بود؛ کد تازه ساخته شد")
            createRoom(newCode(), pw, null)
        }
    }

    override fun onRoomClaimed(roomId: String) = onPasswordMismatch(roomId)

    fun onNetworkBack() {
        engines.values.forEach { it.onNetworkBack() }
    }

    /** Scheduled catch-up: waits for any running sync rather than skipping it. */
    suspend fun syncAll() {
        engines.values.toList().forEach { runCatching { it.syncOnce(wait = true) } }
    }

    // ── lock ───────────────────────────────────────────────────────────────
    fun scheduleLock() {
        if (_locked.value) return
        if (System.currentTimeMillis() < suppressLockUntil) return
        val seconds = _settings.value.autoLockSeconds
        lockJob?.cancel()
        if (seconds <= 0) {
            lock()
            return
        }
        lockJob = scope.launch {
            delay(seconds * 1_000L)
            lock()
        }
    }

    fun cancelScheduledLock() {
        lockJob?.cancel()
        lockJob = null
    }

    /**
     * Soft lock: the screen needs the password again and decrypted files are
     * shredded, but room keys stay in memory while the process lives, so
     * messages keep arriving and notifications keep firing. Keys leave memory
     * only on [lockHard]: the lock button, swiping the app away, a wipe.
     */
    fun lock() {
        lockJob?.cancel()
        if (_locked.value) return
        _locked.value = true
        closeRoom()
        scope.launch { engineMutex.withLock { engines.values.forEach { it.forgetLocalFiles() } } }
        SecureFiles.shred(File(app.cacheDir, "open"))
    }

    /** Drops every key from memory and every decrypted file from the cache. */
    fun lockHard() {
        _locked.value = true
        closeRoom()
        scope.launch {
            engineMutex.withLock {
                engines.values.forEach { it.forgetLocalFiles(); it.stop() }
                engines.clear()
            }
        }
        index = null
        _rooms.value = emptyList()
        vault.close()
        SecureFiles.shred(File(app.cacheDir, "open"))
        ConnectionService.stop(app)
    }

    /** Resumes after a soft lock when engines are still alive. */
    suspend fun resumeFromSoftLock(password: String): UnlockResult {
        if (engines.isEmpty()) return unlock(password)
        if (lockoutRemaining > 0) return UnlockResult.Wrong(attemptsLeft(), lockoutRemaining)
        val ok = withContext(Dispatchers.Default) { vault.open(password) }
        if (!ok) return wrongAttempt()
        settingsStore.failedAttempts = 0
        _locked.value = false
        notifier.clearAll()
        return UnlockResult.Ok
    }

    val hasLiveEngines: Boolean get() = engines.isNotEmpty()

    fun wipe() {
        scope.launch {
            engineMutex.withLock {
                engines.values.forEach { it.forgetLocalFiles(); it.stop() }
                engines.clear()
            }
        }
        index = null
        _rooms.value = emptyList()
        _activeRoom.value = null
        vault.wipe()
        settingsStore.failedAttempts = 0
        settingsStore.lockoutUntil = 0
        notifier.clearAll()
        ConnectionService.stop(app)
        _locked.value = true
    }

    // ── settings ───────────────────────────────────────────────────────────
    fun updateSettings(transform: (Settings) -> Settings) {
        val before = _settings.value
        var next = transform(before)
        if (next.notificationSound != before.notificationSound || next.systemSoundUri != before.systemSoundUri || next.vibration != before.vibration) {
            next = next.copy(soundVersion = before.soundVersion + 1)
        }
        _settings.value = next
        settingsStore.save(next)
        if (next.soundVersion != before.soundVersion) notifier.ensureChannels(next)
        if (before.biometric && !next.biometric) disableBiometric()
        if (!before.backgroundLink && next.backgroundLink && !_locked.value) ConnectionService.start(app)
        if (before.backgroundLink && !next.backgroundLink) ConnectionService.stop(app)
    }

    suspend fun changePassword(current: String, next: String): Boolean =
        withContext(Dispatchers.Default) { vault.changePassword(current, next) }.also { if (it) disableBiometric() }

    suspend fun setDuress(password: String?) = withContext(Dispatchers.Default) { vault.setDuress(password) }

    // ── clipboard ──────────────────────────────────────────────────────────
    fun copySensitive(text: String, label: String = "najvaa") {
        val cm = app.getSystemService(ClipboardManager::class.java) ?: return
        val clip = ClipData.newPlainText(label, text)
        if (Build.VERSION.SDK_INT >= 33) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        cm.setPrimaryClip(clip)
        clipJob?.cancel()
        val seconds = _settings.value.clipboardClearSeconds
        if (seconds > 0) clipJob = scope.launch {
            delay(seconds * 1_000L)
            runCatching {
                if (cm.primaryClip?.getItemAt(0)?.text?.toString() == text) {
                    if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }
        }
    }

    fun shareText(text: String) {
        val i = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        ContextCompat.startActivity(app, Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), null)
    }
}
