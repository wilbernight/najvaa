package com.najvaa.app.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import androidx.compose.ui.text.AnnotatedString
import android.media.MediaPlayer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.najvaa.app.AppController
import com.najvaa.app.ui.components.AnimatedImage
import com.najvaa.app.ui.components.VeiledText
import com.najvaa.app.MainActivity
import com.najvaa.app.core.Bytes
import com.najvaa.app.core.clockOf
import com.najvaa.app.core.dayHeaderOf
import com.najvaa.app.core.dayKeyOf
import com.najvaa.app.core.durationOf
import com.najvaa.app.core.fa
import com.najvaa.app.core.sizeOf
import com.najvaa.app.core.ttlLabel
import com.najvaa.app.data.Delivery
import com.najvaa.app.data.Direction
import com.najvaa.app.data.Kind
import com.najvaa.app.data.LinkState
import com.najvaa.app.data.Message
import com.najvaa.app.data.Reply
import com.najvaa.app.engine.RoomEngine
import com.najvaa.app.files.FileCodec
import com.najvaa.app.files.VoiceRecorder
import com.najvaa.app.ui.components.Chip
import com.najvaa.app.ui.components.ConfirmDialog
import com.najvaa.app.ui.components.IncognitoInput
import com.najvaa.app.ui.components.RoomAvatar
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.SheetHandle
import com.najvaa.app.ui.components.SheetItem
import com.najvaa.app.ui.components.SheetShape
import com.najvaa.app.ui.components.Spinner
import com.najvaa.app.ui.components.TopBar
import com.najvaa.app.ui.components.rememberHaptic
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.io.File

private val EMOJIS = listOf("❤️", "😂", "👍", "😮", "😢", "🔥", "🙏", "👀")

private sealed interface Row {
    data class Day(val key: Int, val ts: Long) : Row
    data class Msg(val m: Message, val first: Boolean, val last: Boolean) : Row
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(controller: AppController, activity: MainActivity, roomId: String, onBack: () -> Unit, onInfo: () -> Unit, focus: String? = null, onManage: () -> Unit = {}) {
    val c = LocalNajvaa.current
    val ctx = LocalContext.current
    val settings by controller.settings.collectAsState()
    val rooms by controller.rooms.collectAsState()
    val room = rooms.firstOrNull { it.id == roomId }
    val engine = controller.engine(roomId)
    if (room == null || engine == null) {
        LaunchedEffect(room, engine) { if (room == null) onBack() }
        Box(Modifier.fillMaxSize().background(c.bg), contentAlignment = Alignment.Center) { Spinner() }
        return
    }

    val messages by engine.messages.collectAsState()
    val link by engine.link.collectAsState()
    val peers by engine.peers.collectAsState()
    val typing by engine.typing.collectAsState()
    val progress by engine.progress.collectAsState()
    val files by engine.files.collectAsState()
    val haptic = rememberHaptic()
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    var draft by remember(roomId) { mutableStateOf("") }
    var reply by remember(roomId) { mutableStateOf<Reply?>(null) }
    var editing by remember(roomId) { mutableStateOf<Message?>(null) }
    var menuFor by remember { mutableStateOf<Message?>(null) }
    var attach by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Message?>(null) }
    var revealed by remember(roomId) { mutableStateOf(setOf<String>()) }
    val nowState = remember { mutableLongStateOf(System.currentTimeMillis()) }
    val clock: () -> Long = remember { { nowState.longValue } }
    val recorder = remember { VoiceRecorder(ctx) }
    var recording by remember { mutableStateOf(false) }
    val player = remember { VoicePlayer() }
    DisposableEffect(Unit) { onDispose { player.release(); recorder.cancel() } }
    var expressions by remember { mutableStateOf<Boolean?>(null) } // null closed, false emoji, true GIF
    var flash by remember { mutableStateOf<String?>(null) }
    val gate = rememberStorageGate(controller)
    val emojiIndex by androidx.compose.runtime.produceState<EmojiIndex?>(null) { value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { EmojiIndex.load(ctx) } }

    // Tick only while something on screen is counting down.
    val anyTimer = remember(messages) { messages.any { it.expiresAt != null } }
    LaunchedEffect(anyTimer) { while (anyTimer) { delay(1_000); nowState.longValue = System.currentTimeMillis() } }
    LaunchedEffect(engine) { engine.notices.collect { controller.toast(it) } }

    val rows = remember(messages) {
        val sorted = messages.sortedByDescending { it.orderTs }
        val out = ArrayList<Row>(sorted.size + 8)
        for (i in sorted.indices) {
            val m = sorted[i]
            val newer = sorted.getOrNull(i - 1)
            val older = sorted.getOrNull(i + 1)
            val sameNewer = newer != null && newer.dir == m.dir && newer.author == m.author && newer.orderTs - m.orderTs < 120_000 && dayKeyOf(newer.orderTs) == dayKeyOf(m.orderTs)
            val sameOlder = older != null && older.dir == m.dir && older.author == m.author && m.orderTs - older.orderTs < 120_000 && dayKeyOf(older.orderTs) == dayKeyOf(m.orderTs)
            out += Row.Msg(m, first = !sameOlder, last = !sameNewer)
            if (older == null || dayKeyOf(older.orderTs) != dayKeyOf(m.orderTs)) out += Row.Day(dayKeyOf(m.orderTs), m.orderTs)
        }
        out
    }

    // Opened from the content manager: bring that message into view and flash it.
    var focused by remember(roomId) { mutableStateOf<String?>(null) }
    LaunchedEffect(focus, rows.size) {
        val id = focus ?: return@LaunchedEffect
        if (focused == id) return@LaunchedEffect
        val idx = rows.indexOfFirst { it is Row.Msg && it.m.id == id }
        if (idx >= 0) {
            focused = id
            listState.scrollToItem(idx)
            flash = id
            delay(1800)
            flash = null
        }
    }

    // Mark incoming messages read once they are on screen (spoilered ones only after reveal).
    LaunchedEffect(listState, settings.spoiler) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.map { it.key } }.distinctUntilChanged().collect { keys ->
            val ids = messages.filter { m ->
                m.dir == Direction.IN && !m.readByMe && keys.contains(m.id) && !(settings.spoiler && m.ttl > 0 && m.id !in revealed)
            }.map { it.id }
            if (ids.isNotEmpty()) engine.markRead(ids)
        }
    }
    LaunchedEffect(revealed) {
        val ids = revealed.filter { id -> messages.any { it.id == id && it.dir == Direction.IN && !it.readByMe } }
        if (ids.isNotEmpty()) engine.markRead(ids)
    }

    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    var lastCount by remember { mutableIntStateOf(messages.size) }
    var newChip by remember { mutableStateOf(false) }
    LaunchedEffect(messages.size) {
        if (messages.size > lastCount) {
            val newest = messages.maxByOrNull { it.orderTs }
            if (atBottom || newest?.dir == Direction.OUT) listState.animateScrollToItem(0) else newChip = true
        }
        lastCount = messages.size
    }
    LaunchedEffect(atBottom) { if (atBottom) newChip = false }

    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val picked = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { FileCodec.read(ctx.contentResolver, uri) }
            if (picked == null) controller.toast("فایل خوانده نشد", warn = true)
            else if (picked.bytes.size > FileCodec.MAX_FILE) controller.toast("بیشینه‌ی اندازه ${sizeOf(FileCodec.MAX_FILE.toLong())} است", warn = true)
            else { engine.sendFile(picked, reply = reply); reply = null }
        }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val picked = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { FileCodec.read(ctx.contentResolver, uri) }
            if (picked == null) controller.toast("فایل خوانده نشد", warn = true)
            else if (picked.bytes.size > FileCodec.MAX_FILE) controller.toast("بیشینه‌ی اندازه ${sizeOf(FileCodec.MAX_FILE.toLong())} است", warn = true)
            else { engine.sendFile(picked, reply = reply); reply = null }
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok && recorder.start(settings.voiceFx)) recording = true else if (!ok) controller.toast("بدون دسترسی میکروفون نمی‌شود ضبط کرد", warn = true)
    }

    fun startRecording() {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            if (recorder.start(settings.voiceFx)) { recording = true; haptic() } else controller.toast("ضبط شروع نشد", warn = true)
        } else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun finishRecording(send: Boolean) {
        recording = false
        if (!send) { recorder.cancel(); return }
        val replyTo = reply
        reply = null
        scope.launch {
            // The anonymous voice is re-synthesised here, before anything is encrypted or sent.
            val r = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { recorder.stop() }
            if (r == null) { controller.toast("خیلی کوتاه بود"); return@launch }
            engine.sendFile(FileCodec.Picked(r.name, r.mime, r.bytes), voiceSeconds = r.seconds, wave = r.wave, reply = replyTo)
        }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        val e = editing
        if (e != null) { engine.edit(e.id, text); editing = null } else { engine.sendText(text, reply); reply = null }
        draft = ""
        haptic()
    }

    fun openFile(f: File) {
        val uri = FileProvider.getUriForFile(ctx, "com.najvaa.app.files", f)
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, ctx.contentResolver.getType(uri) ?: "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { ctx.startActivity(Intent.createChooser(i, null)) }.onFailure { controller.toast("برنامه‌ای برای باز کردن این فایل نیست", warn = true) }
    }

    val live = peers.any { it.secure }
    val statusText = when {
        typing -> "در حال نوشتن…"
        live -> "متصل · رمزنگاری زنده"
        link == LinkState.MISMATCH -> "رمز با سرور نمی‌خواند"
        link == LinkState.OFFLINE -> "آفلاین"
        link == LinkState.CONNECTING -> "در حال اتصال…"
        link == LinkState.FULL -> "اتاق پر است"
        else -> "طرف مقابل آفلاین · پیام‌ها ذخیره می‌شوند"
    }
    val statusColor = when {
        typing || live -> c.primary
        link == LinkState.MISMATCH -> c.danger
        else -> c.text3
    }

    Column(Modifier.fillMaxSize().background(c.bg)) {
        TopBar(
            title = room.title, subtitle = statusText, onBack = onBack,
            leading = { RoomAvatar(room.code, room.title, size = 38.dp, online = live, modifier = Modifier.clickable(onClick = onInfo)) },
            actions = {
                if (room.ttl > 0) Chip(ttlLabel(room.ttl), icon = NajvaaIcons.Timer, onClick = onInfo)
                RoundIconButton(NajvaaIcons.Search, "مدیریت و جستجوی پیام‌ها", onClick = onManage)
                RoundIconButton(NajvaaIcons.Info, "اطلاعات اتاق", onClick = onInfo)
            },
        )
        // Subtitle colour override lives in TopBar; show the state as a thin strip when it matters.
        AnimatedVisibility(link == LinkState.MISMATCH || link == LinkState.OFFLINE || link == LinkState.FULL) {
            val (text, tint) = when (link) {
                LinkState.MISMATCH -> "رمز این اتاق با آنچه روی سرور است نمی‌خواند؛ اتاق را پاک و با رمز درست وارد شوید" to c.danger
                LinkState.FULL -> "دو دستگاه دیگر در این اتاق فعال‌اند؛ نجوا فقط دونفره است" to c.accent
                else -> "آفلاین؛ پیام‌ها در صف می‌مانند و با اتصال فرستاده می‌شوند" to c.text2
            }
            Text(text, style = Type.caption, color = tint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().background(tint.copy(alpha = 0.08f)).padding(horizontal = 16.dp, vertical = 6.dp))
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (messages.isEmpty()) {
                Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Box(Modifier.size(64.dp).clip(RoundedCornerShape(22.dp)).background(c.primarySoft), contentAlignment = Alignment.Center) { Icon(NajvaaIcons.Shield, null, tint = c.primary, modifier = Modifier.size(30.dp)) }
                    Spacer(Modifier.height(16.dp))
                    Text("این گفتگو سرتاسری رمز شده است", style = Type.subtitle, color = c.text, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(6.dp))
                    Text(if (room.waiting) "کد و رمز را به طرف مقابل بدهید؛ اولین پیام را هم می‌توانید همین حالا بنویسید." else "هنوز پیامی رد و بدل نشده.", style = Type.bodySmall, color = c.text3, textAlign = TextAlign.Center)
                }
            }
            LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
                items(rows, key = { r -> when (r) { is Row.Day -> "d${r.key}"; is Row.Msg -> r.m.id } }) { r ->
                    when (r) {
                        is Row.Day -> DayHeader(r.ts)
                        is Row.Msg -> Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(if (flash == r.m.id) c.primarySoft else Color.Transparent)) { Bubble(
                            r.m, r.first, r.last, clock, engine, files[r.m.id], progress[r.m.id], player,
                            spoiler = settings.spoiler && r.m.dir == Direction.IN && r.m.ttl > 0 && r.m.id !in revealed,
                            onReveal = { revealed = revealed + r.m.id },
                            onLong = { haptic(); menuFor = r.m },
                            onDouble = { haptic(); engine.react(r.m.id, if (r.m.myReaction == "❤️") null else "❤️") },
                            onOpen = { f -> openFile(f) },
                            nameOf = { engine.nameOf(it) },
                            veil = settings.veil, emoji = emojiIndex,
                        ) }
                    }
                }
            }
            androidx.compose.animation.AnimatedVisibility(newChip, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp), enter = fadeIn() + slideInVertically { it }, exit = fadeOut() + slideOutVertically { it }) {
                Chip("پیام تازه", icon = NajvaaIcons.Forward, tint = c.onPrimary, bg = c.primary) { scope.launch { listState.animateScrollToItem(0) }; newChip = false }
            }
            ExportProgress(engine, controller)
        }

        Composer(
            draft, onDraft = { draft = it; if (it.isNotEmpty()) engine.sendTyping() },
            reply = reply, onClearReply = { reply = null },
            editing = editing, onCancelEdit = { editing = null; draft = "" },
            recording = recording, recorder = recorder,
            onAttach = { attach = true }, onSend = { send() }, onEmoji = { expressions = false }, anonymous = settings.voiceFx,
            onMic = { startRecording() }, onStopRecording = { finishRecording(it) },
            incognito = settings.incognitoKeyboard,
            enabled = link != LinkState.MISMATCH,
        )
    }

    menuFor?.let { m ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { menuFor = null }, sheetState = sheet, containerColor = c.surface2, shape = SheetShape, dragHandle = { SheetHandle() }) {
            Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 24.dp)) {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    EMOJIS.forEach { e ->
                        val on = m.myReaction == e
                        Box(Modifier.size(46.dp).clip(CircleShape).background(if (on) c.primarySoft else c.surface3).clickable { engine.react(m.id, if (on) null else e); menuFor = null }, contentAlignment = Alignment.Center) {
                            EmojiImage(e, 28.dp)
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                SheetItem(NajvaaIcons.Reply, "پاسخ") { reply = Reply(m.id, m.author, m.preview().take(80), if (m.kind == Kind.TEXT) "text" else m.kind.name.lowercase()); menuFor = null }
                if (m.kind == Kind.TEXT) SheetItem(NajvaaIcons.Copy, "کپی متن", subtitle = "پس از ${fa(settings.clipboardClearSeconds)} ثانیه از کلیپ‌بورد پاک می‌شود") { controller.copySensitive(m.body); controller.toast("کپی شد"); menuFor = null }
                if (m.kind == Kind.TEXT && m.dir == Direction.OUT) SheetItem(NajvaaIcons.Edit, "ویرایش") { editing = m; draft = m.body; reply = null; menuFor = null }
                if (m.isFile) {
                    val f = files[m.id]
                    if (f != null) SheetItem(NajvaaIcons.Share, "باز کردن / اشتراک") { openFile(f); menuFor = null }
                    else SheetItem(NajvaaIcons.Download, "دانلود و رمزگشایی") { engine.download(m.id); menuFor = null }
                    SheetItem(NajvaaIcons.Image, if (m.isMedia) "ذخیره در گالری" else "ذخیره در حافظه‌ی گوشی", subtitle = "پوشه‌ی Najva · نسخه‌ی ذخیره‌شده دیگر رمزشده نیست") {
                        menuFor = null
                        gate { engine.exportToGallery(listOf(m.id)) }
                    }
                }
                SheetItem(NajvaaIcons.Trash, "حذف برای من", danger = true) { engine.delete(listOf(m.id), everyone = false); menuFor = null }
                SheetItem(NajvaaIcons.Trash, "حذف برای هر دو", danger = true, subtitle = "از سرور و از دستگاه طرف مقابل هم پاک می‌شود") { confirmDelete = m; menuFor = null }
            }
        }
    }

    if (attach) {
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { attach = false }, sheetState = sheet, containerColor = c.surface2, shape = SheetShape, dragHandle = { SheetHandle() }) {
            Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 24.dp)) {
                SheetItem(NajvaaIcons.Image, "عکس", subtitle = "اطلاعات مکان و دوربین پیش از ارسال حذف می‌شود") { attach = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                SheetItem(NajvaaIcons.Sparkle, "گیف", subtitle = "جستجو از طریق سرور نجوا") { attach = false; expressions = true }
                SheetItem(NajvaaIcons.Video, "ویدیو") { attach = false; pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly)) }
                SheetItem(NajvaaIcons.File, "فایل", subtitle = "تا ${sizeOf(FileCodec.MAX_FILE.toLong())}") { attach = false; pickFile.launch(arrayOf("*/*")) }
                SheetItem(NajvaaIcons.Mic, "پیام صوتی") { attach = false; startRecording() }
            }
        }
    }

    expressions?.let { gifTab ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { expressions = null }, sheetState = sheet, containerColor = c.surface2, shape = SheetShape, dragHandle = { SheetHandle() }) {
            ExpressionsSheet(
                initialGif = gifTab, gifEnabled = true,
                onEmoji = { e -> draft = (draft + e).take(4000) },
                onGif = { type, bytes ->
                    expressions = null
                    engine.sendFile(FileCodec.Picked(if (type == "image/gif") "gif.gif" else "gif.webp", type, bytes), reply = reply, gif = true)
                    reply = null
                    haptic()
                },
            )
        }
    }

    confirmDelete?.let { m ->
        ConfirmDialog("حذف برای هر دو؟", "این پیام از سرور و از دستگاه طرف مقابل هم پاک می‌شود.", "حذف", danger = true,
            onConfirm = { engine.delete(listOf(m.id), everyone = true); confirmDelete = null }, onDismiss = { confirmDelete = null })
    }
}

@Composable
private fun DayHeader(ts: Long) {
    val c = LocalNajvaa.current
    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(dayHeaderOf(ts), style = Type.caption, color = c.text3, modifier = Modifier.clip(CircleShape).background(c.surface2).padding(horizontal = 12.dp, vertical = 4.dp))
    }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun Bubble(
    m: Message, first: Boolean, last: Boolean, clock: () -> Long, engine: RoomEngine,
    file: File?, progress: Float?, player: VoicePlayer,
    spoiler: Boolean, onReveal: () -> Unit, onLong: () -> Unit, onDouble: () -> Unit, onOpen: (File) -> Unit, nameOf: (String) -> String,
    veil: Boolean = false, emoji: EmojiIndex? = null,
) {
    val c = LocalNajvaa.current
    val out = m.dir == Direction.OUT
    val shape = RoundedCornerShape(
        topStart = if (out || first) Radius.lg else Radius.xs,
        topEnd = if (!out || first) Radius.lg else Radius.xs,
        bottomStart = if (out || last) Radius.lg else Radius.xs,
        bottomEnd = if (!out || last) Radius.lg else Radius.xs,
    )
    val bg = if (out) c.bubbleMe else c.bubblePeer
    val fg = if (out) c.bubbleMeText else c.bubblePeerText
    val meta = if (out) c.bubbleMeText.copy(alpha = 0.65f) else c.text3
    var holding by remember { mutableStateOf(false) }
    val coords = remember { BubbleCoords() }
    var textOrigin by remember { mutableStateOf<Offset?>(null) }
    var captionOrigin by remember { mutableStateOf<Offset?>(null) }
    val big = remember(m.body, emoji) { if (m.kind == Kind.TEXT && !m.deleted && emoji != null) bigEmojiOf(m.body, emoji) else null }
    // The text veil replaces the blur for text: the particles already hide it.
    val veilText = veil && !m.deleted && big == null
    val blurOn = spoiler && !(veilText && m.kind == Kind.TEXT)
    val blur by animateFloatAsState(if (blurOn && !holding) 1f else 0f, tween(220), label = "blur")
    val reveal by animateFloatAsState(if (holding) 1f else 0f, tween(if (holding) 420 else 260), label = "reveal")
    val rich = remember(m.body, emoji, big) { if (m.kind == Kind.TEXT && !m.deleted && big == null) emojiText(m.body, emoji) else null }
    val richCaption = remember(m.caption, emoji) { m.caption?.let { emojiText(it, emoji) } }

    Column(Modifier.fillMaxWidth().padding(top = if (first) 6.dp else 1.dp, bottom = 1.dp), horizontalAlignment = if (out) Alignment.End else Alignment.Start) {
        if (!out && first && m.authorName.isNotEmpty()) Text(m.authorName, style = Type.caption, color = c.primary, modifier = Modifier.padding(start = 10.dp, bottom = 2.dp))
        Box(
            Modifier.widthIn(max = 300.dp).clip(shape).background(if (big != null) Color.Transparent else bg)
                .onGloballyPositioned { coords.box = it }
                .pointerInput(m.id, spoiler, veilText) {
                    detectTapGestures(
                        onLongPress = { onLong() },
                        onDoubleTap = { if (!spoiler) onDouble() },
                        onPress = { at ->
                            if (spoiler || veilText) {
                                textOrigin = coords.originIn(coords.text, at)
                                captionOrigin = coords.originIn(coords.caption, at)
                                holding = true
                                val released = tryAwaitRelease()
                                holding = false
                                if (released && spoiler) onReveal()
                            } else tryAwaitRelease()
                        },
                        onTap = { if (!spoiler) file?.let { if (m.isFile && m.kind != Kind.VOICE) onOpen(it) } },
                    )
                },
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).then(if (blur > 0f) Modifier.blur((blur * 14).dp) else Modifier).alpha(if (blur > 0.5f) 0.75f else 1f)) {
                m.reply?.let { r ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xs)).background(fg.copy(alpha = 0.08f)).padding(8.dp)) {
                        Box(Modifier.width(3.dp).height(32.dp).clip(CircleShape).background(if (out) fg else c.primary))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(r.author?.let { if (it == m.author && out) "شما" else nameOf(it) } ?: "پیام", style = Type.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = if (out) fg else c.primary)
                            Text(r.snippet, style = Type.caption, color = meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                when (m.kind) {
                    Kind.TEXT -> when {
                        m.deleted -> Text("پیام پاک شد", style = Type.body, color = meta)
                        big != null -> Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) { big.forEach { BigEmoji(it, if (big.size == 1) 120 else 84) } }
                        else -> VeiledText(rich?.first ?: AnnotatedString(m.body), Type.body, fg, veiled = veilText, reveal = { reveal }, origin = textOrigin, inline = rich?.second ?: emptyMap(), modifier = Modifier.onGloballyPositioned { coords.text = it })
                    }
                    Kind.IMAGE, Kind.GIF -> MediaBody(m, file, progress, engine, fg, meta)
                    Kind.VIDEO -> FileBody(m, file, progress, engine, fg, meta, NajvaaIcons.Video)
                    Kind.VOICE -> VoiceBody(m, file, progress, engine, player, fg, meta, out)
                    Kind.AUDIO -> FileBody(m, file, progress, engine, fg, meta, NajvaaIcons.Music)
                    Kind.FILE -> FileBody(m, file, progress, engine, fg, meta, NajvaaIcons.File)
                }
                m.caption?.takeIf { it.isNotBlank() }?.let {
                    VeiledText(richCaption?.first ?: AnnotatedString(it), Type.body, fg, veiled = veil, reveal = { reveal }, origin = captionOrigin, inline = richCaption?.second ?: emptyMap(), modifier = Modifier.padding(top = 6.dp).onGloballyPositioned { c2 -> coords.caption = c2 })
                }
                Row(Modifier.align(Alignment.End).padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (m.edited) Text("ویرایش‌شده · ", style = Type.caption, color = meta)
                    m.expiresAt?.let { exp ->
                        Icon(NajvaaIcons.Timer, null, tint = meta, modifier = Modifier.size(11.dp))
                        ExpiryLabel(exp, clock, meta)
                    } ?: if (m.ttl > 0) {
                        Icon(NajvaaIcons.Timer, null, tint = meta, modifier = Modifier.size(11.dp)); Text(" ", style = Type.caption)
                    } else Unit
                    Text(clockOf(m.sentAt), style = Type.caption, color = meta)
                    if (out) {
                        Spacer(Modifier.width(4.dp))
                        when (m.delivery) {
                            Delivery.QUEUED -> Icon(NajvaaIcons.Clock, null, tint = meta, modifier = Modifier.size(13.dp))
                            Delivery.STORED -> Icon(NajvaaIcons.Check, null, tint = meta, modifier = Modifier.size(13.dp))
                            Delivery.DELIVERED -> Icon(NajvaaIcons.DoubleCheck, null, tint = meta, modifier = Modifier.size(14.dp))
                            Delivery.READ -> Icon(NajvaaIcons.DoubleCheck, null, tint = c.accent, modifier = Modifier.size(14.dp))
                        }
                    }
                }
            }
            if (blurOn && !holding) {
                Box(Modifier.matchParentSize(), contentAlignment = Alignment.Center) {
                    Row(Modifier.clip(CircleShape).background(c.scrim).padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(NajvaaIcons.EyeOff, null, tint = Color.White, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(5.dp))
                        Text("نگه دارید تا ببینید", style = Type.caption, color = Color.White)
                    }
                }
            }
        }
        val reactions = buildList { m.myReaction?.let { add(it) }; addAll(m.peerReactions.values) }
        if (reactions.isNotEmpty()) {
            Row(Modifier.padding(top = 2.dp, start = 6.dp, end = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                reactions.groupBy { it }.forEach { (e, list) ->
                    Row(Modifier.clip(CircleShape).background(c.surface2).border(1.dp, if (m.myReaction == e) c.primary else c.hairline, CircleShape).clickable { engine.react(m.id, if (m.myReaction == e) null else e) }.padding(horizontal = 7.dp, vertical = 2.dp)) {
                        EmojiImage(e, 16.dp)
                        if (list.size > 1) Text(" ${fa(list.size)}", style = Type.caption, color = c.text2)
                    }
                }
            }
        }
    }
}

@Composable
private fun MediaBody(m: Message, file: File?, progress: Float?, engine: RoomEngine, fg: Color, meta: Color) {
    LaunchedEffect(m.id, file) { if (file == null && progress == null && m.size <= 6L * 1024 * 1024) engine.download(m.id) }
    val pending: @Composable () -> Unit = {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (progress != null) { Spinner(color = fg); Spacer(Modifier.height(8.dp)); Text("${fa((progress * 100).toInt())}٪", style = Type.caption, color = meta) }
            else { Icon(NajvaaIcons.Download, null, tint = fg, modifier = Modifier.size(28.dp).clickable { engine.download(m.id) }); Spacer(Modifier.height(6.dp)); Text(sizeOf(m.size), style = Type.caption, color = meta) }
        }
    }
    if (m.kind == Kind.GIF) {
        // GIFs arrive as small (~100 px) files; show them big enough to enjoy, animated.
        Box(Modifier.width(240.dp).clip(RoundedCornerShape(Radius.md)).background(fg.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) {
            if (file != null) AnimatedImage(file = file, modifier = Modifier.fillMaxWidth(), placeholder = { Box(Modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) { Spinner(color = fg) } })
            else Box(Modifier.fillMaxWidth().height(180.dp), contentAlignment = Alignment.Center) { pending() }
        }
        return
    }
    val path = file?.absolutePath
    val bitmap by androidx.compose.runtime.produceState(path?.let { ThumbCache.get(it) }, path) {
        if (path == null || value != null) return@produceState
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { ThumbCache.load(path) }
    }
    val bmp = bitmap
    if (bmp != null) {
        val ratio = (bmp.width.toFloat() / bmp.height.coerceAtLeast(1)).coerceIn(0.6f, 1.9f)
        Image(
            bmp, m.fileName, contentScale = ContentScale.Crop,
            modifier = Modifier.width(264.dp).aspectRatio(ratio).clip(RoundedCornerShape(Radius.md)),
        )
    } else {
        Box(Modifier.width(264.dp).height(180.dp).clip(RoundedCornerShape(Radius.md)).background(fg.copy(alpha = 0.06f)), contentAlignment = Alignment.Center) { pending() }
    }
}

@Composable
private fun FileBody(m: Message, file: File?, progress: Float?, engine: RoomEngine, fg: Color, meta: Color, icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Row(Modifier.widthIn(min = 180.dp, max = 276.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(Radius.sm)).background(fg.copy(alpha = 0.1f)).clickable { if (file == null && progress == null) engine.download(m.id) }, contentAlignment = Alignment.Center) {
            when {
                progress != null -> Spinner(color = fg, size = 20.dp)
                file != null -> Icon(icon, null, tint = fg, modifier = Modifier.size(22.dp))
                else -> Icon(NajvaaIcons.Download, null, tint = fg, modifier = Modifier.size(22.dp))
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(m.fileName ?: "فایل", style = Type.label, color = fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(if (progress != null) "${fa((progress * 100).toInt())}٪ · ${sizeOf(m.size)}" else if (file != null) "${sizeOf(m.size)} · برای باز کردن لمس کنید" else "${sizeOf(m.size)} · رمزشده روی سرور", style = Type.caption, color = meta)
        }
    }
}

@Composable
private fun VoiceBody(m: Message, file: File?, progress: Float?, engine: RoomEngine, player: VoicePlayer, fg: Color, meta: Color, out: Boolean) {
    val c = LocalNajvaa.current
    val playing = player.playingId == m.id
    val pos = if (playing) player.progress else 0f
    val bars = remember(m.voiceWave) { Bytes.unb64u(m.voiceWave ?: "")?.map { (it.toInt() and 0xFF) / 255f } ?: List(48) { 0.3f } }
    LaunchedEffect(m.id, file) { if (file == null && progress == null) engine.download(m.id) }
    Row(Modifier.widthIn(min = 200.dp, max = 276.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(if (out) fg.copy(alpha = 0.18f) else c.primary).clickable(enabled = file != null) { file?.let { player.toggle(m.id, it) } }, contentAlignment = Alignment.Center) {
            when {
                file == null -> Spinner(color = fg, size = 18.dp)
                playing -> Icon(NajvaaIcons.Pause, "توقف", tint = if (out) fg else c.onPrimary, modifier = Modifier.size(20.dp))
                else -> Icon(NajvaaIcons.Play, "پخش", tint = if (out) fg else c.onPrimary, modifier = Modifier.size(20.dp))
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(Modifier.fillMaxWidth().height(28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                bars.forEachIndexed { i, v ->
                    val done = i.toFloat() / bars.size < pos
                    Box(Modifier.weight(1f).height((4 + v * 22).dp).clip(CircleShape).background(if (done) (if (out) fg else c.primary) else fg.copy(alpha = 0.3f)))
                }
            }
            Text(if (playing) durationOf((player.progress * m.voiceSeconds).toInt()) + " / " + durationOf(m.voiceSeconds) else durationOf(m.voiceSeconds), style = Type.caption, color = meta)
        }
    }
}

/** One player for the screen; keeps playback state observable. */
class VoicePlayer {
    var playingId by mutableStateOf<String?>(null)
        private set
    var progress by mutableFloatStateOf(0f)
        private set
    private var mp: MediaPlayer? = null
    private var ticker: Thread? = null

    fun toggle(id: String, file: File) {
        if (playingId == id) { release(); return }
        release()
        mp = runCatching {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener { release() }
                prepare()
                start()
            }
        }.getOrNull() ?: return
        playingId = id
        ticker = Thread {
            while (mp != null && playingId == id) {
                val p = mp ?: break
                runCatching { if (p.duration > 0) progress = p.currentPosition.toFloat() / p.duration }
                Thread.sleep(120)
            }
        }.apply { isDaemon = true; start() }
    }

    fun release() {
        playingId = null
        progress = 0f
        runCatching { mp?.stop() }
        runCatching { mp?.release() }
        mp = null
    }
}

@Composable
private fun Composer(
    draft: String, onDraft: (String) -> Unit,
    reply: Reply?, onClearReply: () -> Unit,
    editing: Message?, onCancelEdit: () -> Unit,
    recording: Boolean, recorder: VoiceRecorder,
    onAttach: () -> Unit, onSend: () -> Unit, onMic: () -> Unit, onStopRecording: (Boolean) -> Unit,
    incognito: Boolean, enabled: Boolean, onEmoji: () -> Unit = {}, anonymous: Boolean = false,
) {
    val c = LocalNajvaa.current
    Column(Modifier.fillMaxWidth().background(c.bgElevated).navigationBarsPadding().imePadding()) {
        AnimatedVisibility(reply != null || editing != null) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(3.dp).height(34.dp).clip(CircleShape).background(c.primary))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (editing != null) "ویرایش پیام" else "پاسخ به", style = Type.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.primary)
                    Text(editing?.body ?: reply?.snippet ?: "", style = Type.caption, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                RoundIconButton(NajvaaIcons.Close, "بستن", size = 36.dp, tint = c.text3) { if (editing != null) onCancelEdit() else onClearReply() }
            }
        }
        if (recording) {
            var seconds by remember { mutableIntStateOf(0) }
            var level by remember { mutableFloatStateOf(0f) }
            LaunchedEffect(Unit) { while (true) { delay(100); seconds = recorder.seconds; level = recorder.sample() } }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIconButton(NajvaaIcons.Trash, "لغو", tint = c.danger) { onStopRecording(false) }
                Spacer(Modifier.width(6.dp))
                Box(Modifier.size(10.dp).clip(CircleShape).background(c.danger.copy(alpha = 0.5f + level * 0.5f)))
                Spacer(Modifier.width(8.dp))
                Text(durationOf(seconds), style = Type.subtitle, color = c.text)
                if (anonymous) {
                    Spacer(Modifier.width(8.dp))
                    Text("صدای ناشناس", style = Type.caption, color = c.accent, modifier = Modifier.clip(CircleShape).background(c.accentSoft).padding(horizontal = 8.dp, vertical = 3.dp))
                }
                Spacer(Modifier.width(12.dp))
                Row(Modifier.weight(1f).height(28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    repeat(24) { i -> val h = 4 + (level * 20 * (0.4f + 0.6f * ((i * 7) % 5) / 4f)); Box(Modifier.width(3.dp).height(h.dp).clip(CircleShape).background(c.primary)) }
                }
                Spacer(Modifier.width(6.dp))
                Box(Modifier.size(46.dp).clip(CircleShape).background(c.buttonGradient).clickable { onStopRecording(true) }, contentAlignment = Alignment.Center) { Icon(NajvaaIcons.Send, "ارسال", tint = c.onPrimary, modifier = Modifier.size(22.dp)) }
            }
            return@Column
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            RoundIconButton(NajvaaIcons.Attach, "پیوست", tint = c.text2, enabled = enabled, onClick = onAttach)
            Row(Modifier.weight(1f).clip(RoundedCornerShape(Radius.lg)).background(c.surface2).border(1.dp, c.hairline, RoundedCornerShape(Radius.lg)).padding(start = 14.dp, end = 4.dp), verticalAlignment = Alignment.Bottom) {
                Box(Modifier.weight(1f).padding(vertical = 10.dp)) {
                IncognitoInput(incognito) {
                    androidx.compose.foundation.text.BasicTextField(
                        value = draft, onValueChange = { onDraft(it.take(4000)) }, enabled = enabled,
                        textStyle = Type.body.copy(color = c.text), cursorBrush = androidx.compose.ui.graphics.SolidColor(c.primary),
                        maxLines = 6,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences, autoCorrectEnabled = !incognito),
                        decorationBox = { inner -> Box { if (draft.isEmpty()) Text(if (enabled) "پیام…" else "رمز اتاق درست نیست", style = Type.body, color = c.text3); inner() } },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                }
                RoundIconButton(NajvaaIcons.Emoji, "ایموجی و گیف", size = 40.dp, tint = c.text3, enabled = enabled, onClick = onEmoji)
            }
            Spacer(Modifier.width(6.dp))
            val hasText = draft.isNotBlank()
            Box(
                Modifier.size(46.dp).clip(CircleShape).background(if (hasText || editing != null) c.buttonGradient else androidx.compose.ui.graphics.SolidColor(c.surface2))
                    .clickable(enabled = enabled) { if (hasText) onSend() else if (editing == null) onMic() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (hasText || editing != null) (if (editing != null) NajvaaIcons.Check else NajvaaIcons.Send) else NajvaaIcons.Mic, if (hasText) "ارسال" else "ضبط صدا", tint = if (hasText || editing != null) c.onPrimary else c.text2, modifier = Modifier.size(22.dp))
            }
        }
    }
}

/** Layout coordinates of a bubble's parts; plain fields, so layout passes never trigger recomposition. */
private class BubbleCoords {
    var box: LayoutCoordinates? = null
    var text: LayoutCoordinates? = null
    var caption: LayoutCoordinates? = null
    fun originIn(target: LayoutCoordinates?, at: Offset): Offset? {
        val b = box ?: return null
        val t = target ?: return null
        return runCatching { if (b.isAttached && t.isAttached) t.localPositionOf(b, at) else null }.getOrNull()
    }
}

/** The countdown of a disappearing message; the only thing that recomposes every second. */
@Composable
private fun ExpiryLabel(exp: Long, clock: () -> Long, color: Color) {
    val left = ((exp - clock()) / 1000).coerceAtLeast(0)
    Text(" ${if (left >= 60) durationOf(left.toInt()) else fa(left)} · ", style = Type.caption, color = color)
}

/** Decoded photo previews, sized for a bubble (about 1080 px), so scrolling back never decodes again. */
private object ThumbCache {
    private val cache = object : android.util.LruCache<String, androidx.compose.ui.graphics.ImageBitmap>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: androidx.compose.ui.graphics.ImageBitmap) = value.width * value.height * 4
    }

    fun get(path: String) = cache.get(path)

    fun load(path: String): androidx.compose.ui.graphics.ImageBitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= 1080 || bounds.outHeight / (sample * 2) >= 1080) sample *= 2
        BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }.getOrNull()?.also { cache.put(path, it) }
}
