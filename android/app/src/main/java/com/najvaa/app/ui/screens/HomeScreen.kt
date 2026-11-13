package com.najvaa.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.MainActivity
import com.najvaa.app.core.dayLabelOf
import com.najvaa.app.core.greetingOf
import com.najvaa.app.data.LinkState
import com.najvaa.app.data.Room
import com.najvaa.app.ui.components.Badge
import com.najvaa.app.ui.components.ConfirmDialog
import com.najvaa.app.ui.components.EmptyState
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.RoomAvatar
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.SheetHandle
import com.najvaa.app.ui.components.SheetItem
import com.najvaa.app.ui.components.SheetShape
import com.najvaa.app.ui.components.SoftButton
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    controller: AppController,
    activity: MainActivity,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    onJoin: () -> Unit,
    onSettings: () -> Unit,
    onInfo: (String) -> Unit,
) {
    val c = LocalNajvaa.current
    val rooms by controller.rooms.collectAsState()
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var menuRoom by remember { mutableStateOf<Room?>(null) }
    var fabOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Room?>(null) }

    LaunchedEffect(Unit) { activity.askNotificationPermission() }

    val shown = remember(rooms, query) {
        if (query.isBlank()) rooms else rooms.filter { it.title.contains(query, true) || it.code.contains(com.najvaa.app.core.latinDigits(query)) }
    }

    Box(Modifier.fillMaxSize().background(c.bgGradient)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 14.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(greetingOf(), style = Type.caption, color = c.text3)
                    Text("گفتگوها", style = Type.display.copy(fontSize = 26.sp()), color = c.text)
                }
                RoundIconButton(NajvaaIcons.Search, "جستجو", tint = if (searching) c.primary else c.text2) { searching = !searching; if (!searching) query = "" }
                RoundIconButton(NajvaaIcons.Lock, "قفل") { controller.lockHard() }
                RoundIconButton(NajvaaIcons.Settings, "تنظیمات", onClick = onSettings)
            }
            AnimatedVisibility(searching) {
                NajvaaField(query, { query = it }, placeholder = "نام یا کد اتاق", leading = NajvaaIcons.Search, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 6.dp))
            }
            if (rooms.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(NajvaaIcons.Chat, "هنوز اتاقی ندارید", "یک اتاق بسازید و کد و رمزش را جداگانه به طرف مقابل بدهید، یا با کد و رمز یک اتاق وارد شوید.") {
                        Row {
                            SoftButton("ساخت اتاق", icon = NajvaaIcons.Plus, onClick = onCreate)
                            Spacer(Modifier.width(10.dp))
                            SoftButton("ورود با کد", icon = NajvaaIcons.Key, onClick = onJoin)
                        }
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = 120.dp)) {
                    items(shown, key = { it.id }) { room ->
                        RoomRow(
                            controller, room,
                            onClick = { onOpen(room.id) },
                            onLong = { menuRoom = room },
                        )
                    }
                    if (shown.isEmpty()) item {
                        Text("چیزی پیدا نشد", style = Type.bodySmall, color = c.text3, modifier = Modifier.fillMaxWidth().padding(32.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
            }
        }

        // FAB with a two-option fan-out.
        Column(Modifier.align(Alignment.BottomStart).navigationBarsPadding().padding(20.dp), horizontalAlignment = Alignment.Start) {
            AnimatedVisibility(fabOpen, enter = fadeIn(tween(140)) + scaleIn(tween(160)), exit = fadeOut(tween(120)) + scaleOut(tween(120))) {
                Column(horizontalAlignment = Alignment.Start) {
                    MiniAction(NajvaaIcons.Key, "ورود با کد") { fabOpen = false; onJoin() }
                    Spacer(Modifier.height(10.dp))
                    MiniAction(NajvaaIcons.Plus, "ساخت اتاق تازه") { fabOpen = false; onCreate() }
                    Spacer(Modifier.height(14.dp))
                }
            }
            Box(
                Modifier.size(58.dp).shadow(16.dp, CircleShape, ambientColor = c.glow, spotColor = c.glow).clip(CircleShape).background(c.buttonGradient)
                    .combinedClickable(onClick = { fabOpen = !fabOpen }),
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (fabOpen) NajvaaIcons.Close else NajvaaIcons.Plus, "اتاق تازه", tint = c.onPrimary, modifier = Modifier.size(26.dp))
            }
        }
        if (fabOpen) Box(Modifier.fillMaxSize().combinedClickable(onClick = { fabOpen = false }).padding(0.dp))
    }

    menuRoom?.let { room ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { menuRoom = null }, sheetState = sheet, containerColor = c.surface2, shape = SheetShape, dragHandle = { SheetHandle() }) {
            Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 24.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    RoomAvatar(room.code, room.title, size = 40.dp)
                    Spacer(Modifier.width(12.dp))
                    Column { Text(room.title, style = Type.subtitle, color = c.text); Text(com.najvaa.app.core.fa(com.najvaa.app.core.spacedCode(room.code)), style = Type.caption.copy(textDirection = androidx.compose.ui.text.style.TextDirection.Ltr), color = c.text3) }
                }
                SheetItem(NajvaaIcons.Info, "اطلاعات اتاق") { menuRoom = null; onInfo(room.id) }
                SheetItem(NajvaaIcons.Pin, if (room.pinned) "برداشتن سنجاق" else "سنجاق کردن") { controller.updateRoom(room.id) { it.pinned = !it.pinned }; menuRoom = null }
                SheetItem(if (room.muted) NajvaaIcons.Bell else NajvaaIcons.BellOff, if (room.muted) "روشن کردن اعلان" else "بی‌صدا کردن") { controller.updateRoom(room.id) { it.muted = !it.muted }; menuRoom = null }
                SheetItem(NajvaaIcons.Trash, "پاک کردن از این گوشی", danger = true, subtitle = "تاریخچه‌ی رمزشده روی سرور می‌ماند") { confirmDelete = room; menuRoom = null }
            }
        }
    }

    confirmDelete?.let { room ->
        ConfirmDialog("پاک کردن «${room.title}»؟", "اتاق و پیام‌هایش از این گوشی پاک می‌شود. با کد و رمز دوباره می‌توانید وارد شوید.", "پاک کن", danger = true,
            onConfirm = { controller.deleteRoom(room.id); confirmDelete = null }, onDismiss = { confirmDelete = null })
    }
}

private fun Int.sp() = androidx.compose.ui.unit.TextUnit(this.toFloat(), androidx.compose.ui.unit.TextUnitType.Sp)

@Composable
private fun MiniAction(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Row(
        Modifier.shadow(10.dp, RoundedCornerShape(Radius.md)).clip(RoundedCornerShape(Radius.md)).background(c.surface2).border(1.dp, c.hairline, RoundedCornerShape(Radius.md))
            .combinedClickable(onClick = onClick).padding(start = 12.dp, end = 16.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = c.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, style = Type.label, color = c.text)
    }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun RoomRow(controller: AppController, room: Room, onClick: () -> Unit, onLong: () -> Unit) {
    val c = LocalNajvaa.current
    val engine = controller.engine(room.id)
    val link by (engine?.link ?: kotlinx.coroutines.flow.MutableStateFlow(LinkState.CONNECTING)).collectAsState()
    val peers by (engine?.peers ?: kotlinx.coroutines.flow.MutableStateFlow(emptyList())).collectAsState()
    val typing by (engine?.typing ?: kotlinx.coroutines.flow.MutableStateFlow(false)).collectAsState()
    val unread by (engine?.unread ?: kotlinx.coroutines.flow.MutableStateFlow(room.unread)).collectAsState()
    val live = peers.any { it.secure }
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onLong).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoomAvatar(room.code, room.title, size = 54.dp, online = live)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(room.title, style = Type.subtitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (room.pinned) { Spacer(Modifier.width(6.dp)); Icon(NajvaaIcons.Pin, null, tint = c.text3, modifier = Modifier.size(13.dp)) }
                if (room.muted) { Spacer(Modifier.width(6.dp)); Icon(NajvaaIcons.BellOff, null, tint = c.text3, modifier = Modifier.size(13.dp)) }
                Spacer(Modifier.width(8.dp))
                Text(dayLabelOf(room.lastAt), style = Type.caption, color = if (unread > 0) c.primary else c.text3)
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val text = when {
                    typing -> "در حال نوشتن…"
                    link == LinkState.MISMATCH -> "رمز با سرور نمی‌خواند"
                    link == LinkState.OFFLINE -> "آفلاین · ${room.lastPreview.ifEmpty { "پیامی نیست" }}"
                    room.waiting && room.lastPreview.isEmpty() -> "منتظر طرف مقابل"
                    room.lastPreview.isEmpty() -> "هنوز پیامی نیست"
                    else -> room.lastPreview
                }
                Text(
                    text, style = Type.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = when {
                        typing -> c.primary
                        link == LinkState.MISMATCH -> c.danger
                        unread > 0 -> c.text
                        else -> c.text3
                    },
                    modifier = Modifier.weight(1f),
                )
                if (unread > 0) { Spacer(Modifier.width(8.dp)); Badge(unread) }
            }
        }
    }
}
