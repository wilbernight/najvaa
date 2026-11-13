package com.najvaa.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.najvaa.app.AppController
import com.najvaa.app.core.clockOf
import com.najvaa.app.core.dayHeaderOf
import com.najvaa.app.core.fa
import com.najvaa.app.core.latinDigits
import com.najvaa.app.core.sizeOf
import com.najvaa.app.data.Direction
import com.najvaa.app.data.Kind
import com.najvaa.app.data.Message
import com.najvaa.app.engine.RoomEngine
import com.najvaa.app.files.GallerySaver
import com.najvaa.app.net.Relay
import com.najvaa.app.net.StoreResult
import com.najvaa.app.ui.components.Chip
import com.najvaa.app.ui.components.ConfirmDialog
import com.najvaa.app.ui.components.EmptyState
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.Spinner
import com.najvaa.app.ui.components.rememberHaptic
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type

/** The filter groups of the content manager, the same ones as the web's. */
enum class MgKind(val label: String) {
    TEXT("متن"), IMAGE("عکس"), VIDEO("ویدیو"), AUDIO("موزیک"), VOICE("ویس"), FILE("فایل");

    val icon: ImageVector
        get() = when (this) {
            TEXT -> NajvaaIcons.Text
            IMAGE -> NajvaaIcons.Image
            VIDEO -> NajvaaIcons.Video
            AUDIO -> NajvaaIcons.Music
            VOICE -> NajvaaIcons.Mic
            FILE -> NajvaaIcons.File
        }
}

fun mgKindOf(m: Message): MgKind = when (m.kind) {
    Kind.TEXT -> MgKind.TEXT
    Kind.IMAGE, Kind.GIF -> MgKind.IMAGE
    Kind.VIDEO -> MgKind.VIDEO
    Kind.AUDIO -> MgKind.AUDIO
    Kind.VOICE -> MgKind.VOICE
    Kind.FILE -> MgKind.FILE
}

/** Folds what differs between typed and stored text: digit shapes, Arabic yeh/kaf, ZWNJ. */
private fun fold(s: String): String =
    latinDigits(s.lowercase()).replace("‌", "").replace("‍", "")
        .replace('ي', 'ی').replace('ى', 'ی').replace('ك', 'ک')

/**
 * Wraps an action that writes to shared storage. Android 10+ needs nothing;
 * Android 8-9 asks for the storage permission first.
 */
@Composable
fun rememberStorageGate(controller: AppController): (() -> Unit) -> Unit {
    val ctx = LocalContext.current
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) pending?.invoke() else controller.toast("بدون دسترسی حافظه نمی‌شود در گالری ذخیره کرد", warn = true)
        pending = null
    }
    return { action ->
        if (!GallerySaver.needsPermission ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        ) {
            action()
        } else {
            pending = action
            launcher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }
}

/** Floating progress card for a running gallery export; reports and clears itself when done. */
@Composable
fun BoxScope.ExportProgress(engine: RoomEngine, controller: AppController) {
    val c = LocalNajvaa.current
    val st by engine.export.collectAsState()
    LaunchedEffect(st?.finished) {
        val s = st ?: return@LaunchedEffect
        if (!s.finished) return@LaunchedEffect
        when {
            s.saved == 0 && s.failed > 0 -> controller.toast("ذخیره در گالری انجام نشد", warn = true)
            s.failed > 0 -> controller.toast("${fa(s.saved)} مورد ذخیره شد؛ ${fa(s.failed)} مورد دریافت نشد", warn = true)
            s.saved == 1 -> controller.toast("در گالری ذخیره شد · پوشه‌ی Najva")
            s.saved > 1 -> controller.toast("${fa(s.saved)} مورد در گالری ذخیره شد · پوشه‌ی Najva")
            else -> Unit
        }
        engine.dismissExport()
    }
    AnimatedVisibility(
        visible = st != null && st?.finished == false,
        enter = fadeIn() + slideInVertically { it },
        exit = fadeOut() + slideOutVertically { it },
        modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        val s = st ?: return@AnimatedVisibility
        Column(
            Modifier.fillMaxWidth()
                .shadow(16.dp, RoundedCornerShape(Radius.lg))
                .clip(RoundedCornerShape(Radius.lg))
                .background(c.surface3)
                .padding(horizontal = 16.dp, vertical = 14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(NajvaaIcons.Download, null, tint = c.primary, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("ذخیره در گالری · ${fa(s.done)} از ${fa(s.total)}", style = Type.subtitle, color = c.text)
                    Text("هر فایل رمزگشایی و در پوشه‌ی Najva گذاشته می‌شود", style = Type.caption, color = c.text3)
                }
                Text(
                    "لغو", style = Type.label, color = c.danger,
                    modifier = Modifier.clip(RoundedCornerShape(Radius.sm)).clickable { engine.cancelExport() }.padding(8.dp),
                )
            }
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(
                progress = { if (s.total == 0) 0f else s.done.toFloat() / s.total },
                modifier = Modifier.fillMaxWidth().height(5.dp).clip(CircleShape),
                color = c.primary, trackColor = c.surface1,
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ManageScreen(controller: AppController, roomId: String, onBack: () -> Unit, onOpenMessage: (String) -> Unit) {
    val c = LocalNajvaa.current
    val engine = controller.engine(roomId)
    if (engine == null) {
        LaunchedEffect(Unit) { onBack() }
        return
    }
    val messages by engine.messages.collectAsState()
    val export by engine.export.collectAsState()
    val haptic = rememberHaptic()
    val gate = rememberStorageGate(controller)

    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf<MgKind?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var usage by remember { mutableStateOf<Relay.Usage?>(null) }
    var usageTick by remember { mutableIntStateOf(0) }
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmSaveAll by remember { mutableStateOf(false) }

    LaunchedEffect(usageTick) { (engine.usage() as? StoreResult.Ok)?.let { usage = it.value } }

    val all = remember(messages) {
        val now = System.currentTimeMillis()
        messages.filter { !it.deleted && (it.expiresAt == null || it.expiresAt > now) }.sortedByDescending { it.orderTs }
    }
    val counts = remember(all) { all.groupingBy { mgKindOf(it) }.eachCount() }
    val haystack = remember(all) {
        all.associate { m ->
            val who = if (m.dir == Direction.OUT) "شما" else engine.nameOf(m.author)
            m.id to fold("${titleOf(m)}\n${m.caption.orEmpty()}\n$who\n${mgKindOf(m).label}\n${dayHeaderOf(m.orderTs)}")
        }
    }
    val rows = remember(all, query, filter) {
        val terms = fold(query.trim()).split(Regex("\\s+")).filter { it.isNotEmpty() }
        all.filter { m ->
            (filter == null || mgKindOf(m) == filter) && (terms.isEmpty() || terms.all { t -> haystack[m.id]?.contains(t) == true })
        }
    }
    val media = remember(all) { all.filter { it.kind == Kind.IMAGE || it.kind == Kind.GIF || it.kind == Kind.VIDEO } }
    val selecting = selected.isNotEmpty()
    val selectedFiles = remember(selected, all) { all.filter { it.id in selected && it.isFile }.map { it.id } }
    val busy = export != null && export?.finished == false

    NajvaaScreen(
        title = if (selecting) "${fa(selected.size)} مورد انتخاب شده" else "مدیریت پیام‌ها",
        subtitle = if (selecting) null else "${fa(all.size)} مورد · رمزشده روی سرور",
        onBack = { if (selecting) selected = emptySet() else onBack() },
        actions = {
            if (selecting) {
                val allVisible = rows.isNotEmpty() && rows.all { it.id in selected }
                Chip(if (allVisible) "هیچ‌کدام" else "انتخاب همه", tint = c.primaryTint, bg = c.primarySoft) {
                    selected = if (allVisible) selected - rows.map { it.id }.toSet() else selected + rows.map { it.id }
                }
            }
        },
        bottom = if (!selecting) null else ({
            Row(
                Modifier.fillMaxWidth().background(c.surface1).padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                ActionPill(NajvaaIcons.Download, "ذخیره در گالری", enabled = selectedFiles.isNotEmpty() && !busy, tint = c.primary, modifier = Modifier.weight(1f)) {
                    gate { engine.exportToGallery(selectedFiles); selected = emptySet() }
                }
                ActionPill(NajvaaIcons.Trash, "حذف برای همه", enabled = true, tint = c.danger, modifier = Modifier.weight(1f)) { confirmDelete = true }
            }
        }),
    ) {
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.padding(horizontal = Space.gutter)) {
                UsageStrip(usage)
                Spacer(Modifier.height(10.dp))
                NajvaaField(
                    query, { query = it.take(100) },
                    placeholder = "جستجو در متن، نام فایل، فرستنده و تاریخ",
                    leading = NajvaaIcons.Search,
                    trailing = if (query.isEmpty()) null else ({ RoundIconButton(NajvaaIcons.Close, "پاک کردن جستجو", size = 36.dp) { query = "" } }),
                    incognito = true,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Space.gutter),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip("همه", all.size, filter == null) { filter = null }
                MgKind.entries.forEach { k ->
                    val n = counts[k] ?: 0
                    if (n > 0 || filter == k) FilterChip(k.label, n, filter == k) { filter = if (filter == k) null else k }
                }
            }
            if (media.isNotEmpty() && !selecting && (filter == null || filter == MgKind.IMAGE || filter == MgKind.VIDEO)) {
                Spacer(Modifier.height(10.dp))
                Row(
                    Modifier.padding(horizontal = Space.gutter).fillMaxWidth()
                        .clip(RoundedCornerShape(Radius.md))
                        .background(c.primarySoft)
                        .clickable(enabled = !busy) { confirmSaveAll = true }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(c.primary), contentAlignment = Alignment.Center) {
                        Icon(NajvaaIcons.Download, null, tint = c.onPrimary, modifier = Modifier.size(20.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("ذخیره‌ی همه‌ی عکس‌ها و ویدیوها", style = Type.subtitle, color = c.text)
                        Text("${fa(media.size)} مورد · ${sizeOf(media.sumOf { it.size })} · در گالری گوشی", style = Type.caption, color = c.text2)
                    }
                    if (busy) Spinner(size = 18.dp) else Icon(NajvaaIcons.Forward, null, tint = c.primaryTint, modifier = Modifier.size(18.dp))
                }
            }
            Spacer(Modifier.height(6.dp))
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (rows.isEmpty()) {
                    EmptyState(
                        NajvaaIcons.Search,
                        if (query.isNotBlank()) "چیزی پیدا نشد" else "چیزی برای نمایش نیست",
                        if (query.isNotBlank()) "عبارت دیگری را امتحان کنید یا فیلتر را بردارید." else "پیام‌ها و فایل‌های این اتاق این‌جا فهرست می‌شوند.",
                    )
                } else {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 96.dp)) {
                        items(rows, key = { it.id }) { m ->
                            val on = m.id in selected
                            ManageRow(
                                m, on, selecting,
                                who = if (m.dir == Direction.OUT) "شما" else engine.nameOf(m.author),
                                modifier = Modifier.combinedClickable(
                                    onClick = { if (selecting) selected = if (on) selected - m.id else selected + m.id else onOpenMessage(m.id) },
                                    onLongClick = { haptic(); selected = if (on) selected - m.id else selected + m.id },
                                ),
                                onToggle = { selected = if (on) selected - m.id else selected + m.id },
                            )
                        }
                    }
                }
            }
        }
        ExportProgress(engine, controller)
    }

    if (confirmDelete) {
        val n = selected.size
        ConfirmDialog(
            "حذف برای همه؟", "${fa(n)} مورد از سرور و از دستگاه طرف مقابل هم پاک می‌شود. برگشت‌پذیر نیست.", "حذف ${fa(n)} مورد", danger = true,
            onConfirm = {
                engine.delete(selected.toList(), everyone = true)
                selected = emptySet()
                confirmDelete = false
                controller.toast("${fa(n)} مورد پاک شد")
                usageTick++
            },
            onDismiss = { confirmDelete = false },
        )
    }
    if (confirmSaveAll) {
        ConfirmDialog(
            "ذخیره در گالری؟",
            "${fa(media.size)} عکس و ویدیو (${sizeOf(media.sumOf { it.size })}) دریافت، رمزگشایی و در پوشه‌ی Najva گالری گذاشته می‌شود. نسخه‌ی گالری دیگر رمزشده نیست و برنامه‌های دیگر هم آن را می‌بینند.",
            "ذخیره کن",
            onConfirm = { confirmSaveAll = false; gate { engine.exportToGallery(media.map { it.id }) } },
            onDismiss = { confirmSaveAll = false },
        )
    }
}

private fun titleOf(m: Message): String = when (m.kind) {
    Kind.TEXT -> m.body
    else -> m.fileName ?: mgKindOf(m).label
}

@Composable
private fun UsageStrip(u: Relay.Usage?) {
    val c = LocalNajvaa.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(c.surface1).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("این گفتگو روی سرور", style = Type.label, color = c.text2, modifier = Modifier.weight(1f))
            Text(if (u == null) "…" else "${sizeOf(u.roomBytes)} · ${fa(u.roomItems)} مورد", style = Type.label, color = c.text)
        }
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(c.surface3)) {
            val frac = if (u != null && u.capBytes > 0) (u.totalBytes.toFloat() / u.capBytes).coerceIn(0f, 1f) else 0f
            Box(Modifier.fillMaxWidth(frac).height(5.dp).background(c.primary))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            if (u == null) "در حال خواندن فضای سرور…" else "کل سرور ${sizeOf(u.totalBytes)} از ${sizeOf(u.capBytes)} · قدیمی‌تر از ${fa(u.maxDays)} روز خودکار پاک می‌شود",
            style = Type.caption, color = c.text3,
        )
    }
}

@Composable
private fun FilterChip(label: String, count: Int, on: Boolean, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Row(
        Modifier.clip(CircleShape)
            .background(if (on) c.primary else c.surface2)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = Type.label, color = if (on) c.onPrimary else c.text)
        Spacer(Modifier.width(6.dp))
        Text(fa(count), style = Type.caption, color = if (on) c.onPrimary.copy(alpha = 0.8f) else c.text3)
    }
}

@Composable
private fun ManageRow(m: Message, on: Boolean, selecting: Boolean, who: String, modifier: Modifier, onToggle: () -> Unit) {
    val c = LocalNajvaa.current
    val k = mgKindOf(m)
    val size = if (m.isFile) m.size else m.body.toByteArray().size.toLong()
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md))
            .background(if (on) c.primarySoft else Color.Transparent)
            .then(modifier)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(26.dp).clip(CircleShape)
                .background(if (on) c.primary else Color.Transparent)
                .border(1.5.dp, if (on) c.primary else if (selecting) c.text3 else c.outline, CircleShape)
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) { if (on) Icon(NajvaaIcons.Check, "انتخاب‌شده", tint = c.onPrimary, modifier = Modifier.size(16.dp)) }
        Spacer(Modifier.width(12.dp))
        Box(
            Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(if (k == MgKind.TEXT) c.surface2 else c.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(k.icon, null, tint = if (k == MgKind.TEXT) c.text2 else c.accent, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(titleOf(m).replace('\n', ' ').take(140), style = Type.body, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${k.label} · $who · ${dayHeaderOf(m.orderTs)} ${clockOf(m.orderTs)} · ${sizeOf(size)}",
                style = Type.caption, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ActionPill(icon: ImageVector, text: String, enabled: Boolean, tint: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Row(
        modifier.clip(RoundedCornerShape(Radius.md))
            .background(if (enabled) tint.copy(alpha = 0.14f) else c.surface2)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (enabled) tint else c.textDisabled, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, style = Type.subtitle, color = if (enabled) tint else c.textDisabled)
    }
}
