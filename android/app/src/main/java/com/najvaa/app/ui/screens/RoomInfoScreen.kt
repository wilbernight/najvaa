package com.najvaa.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.core.TTL_OPTIONS
import com.najvaa.app.core.fa
import com.najvaa.app.core.sizeOf
import com.najvaa.app.core.roomTitle
import com.najvaa.app.core.spacedCode
import com.najvaa.app.core.ttlLabel
import com.najvaa.app.data.LinkState
import com.najvaa.app.data.PeerInfo
import com.najvaa.app.net.Relay
import com.najvaa.app.net.StoreResult
import com.najvaa.app.ui.components.Chip
import com.najvaa.app.ui.components.CodeDisplay
import com.najvaa.app.ui.components.ConfirmDialog
import com.najvaa.app.ui.components.Divider
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.Panel
import com.najvaa.app.ui.components.RoomAvatar
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.SectionLabel
import com.najvaa.app.ui.components.SettingRow
import com.najvaa.app.ui.components.SoftButton
import com.najvaa.app.ui.components.SwitchRow
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type

@Composable
fun RoomInfoScreen(controller: AppController, roomId: String, onBack: () -> Unit, onDeleted: () -> Unit, onManage: () -> Unit = {}) {
    val c = LocalNajvaa.current
    val rooms by controller.rooms.collectAsState()
    val room = rooms.firstOrNull { it.id == roomId }
    val engine = controller.engine(roomId)
    if (room == null) { LaunchedEffect(Unit) { onBack() }; return }

    val link by (engine?.link ?: kotlinx.coroutines.flow.MutableStateFlow(LinkState.OFFLINE)).collectAsState()
    val peers by (engine?.peers ?: kotlinx.coroutines.flow.MutableStateFlow(emptyList())).collectAsState()
    var title by remember(room.id) { mutableStateOf(room.title) }
    var myName by remember(room.id) { mutableStateOf(room.myName) }
    var showPassword by remember { mutableStateOf(false) }
    var usage by remember { mutableStateOf<Relay.Usage?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var safety by remember { mutableStateOf<Map<String, Pair<String, String>>>(emptyMap()) }

    LaunchedEffect(engine) { engine?.let { e -> (e.usage() as? StoreResult.Ok)?.let { usage = it.value } } }
    LaunchedEffect(peers) {
        val e = engine ?: return@LaunchedEffect
        safety = peers.filter { it.secure }.mapNotNull { p -> e.safetyFor(p.id)?.let { p.id to it } }.toMap()
    }

    NajvaaScreen(title = "اطلاعات اتاق", onBack = onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter)) {
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                RoomAvatar(room.code, room.title, size = 84.dp, online = peers.any { it.secure })
                Spacer(Modifier.height(12.dp))
                Text(room.title, style = Type.headline, color = c.text, textAlign = TextAlign.Center)
                Spacer(Modifier.height(4.dp))
                val status = when {
                    peers.any { it.secure } -> "متصل · رمزنگاری زنده" to c.success
                    link == LinkState.MISMATCH -> "رمز با سرور نمی‌خواند" to c.danger
                    link == LinkState.OFFLINE -> "آفلاین" to c.text3
                    link == LinkState.FULL -> "اتاق پر است" to c.accent
                    else -> "منتظر طرف مقابل" to c.text3
                }
                Text(status.first, style = Type.caption, color = status.second)
            }

            SectionLabel("کد اتاق")
            CodeDisplay(room.code, Modifier.fillMaxWidth(), onCopy = { controller.copySensitive(room.code); controller.toast("کد کپی شد") })
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SoftButton("ارسال کد", Modifier.weight(1f), icon = NajvaaIcons.Share) { controller.shareText("کد اتاق نجوا: ${spacedCode(room.code)}\nhttps://najvaa.xyz") }
                SoftButton("ارسال رمز", Modifier.weight(1f), icon = NajvaaIcons.Key) { controller.roomPassword(room.id)?.let { controller.shareText("رمز اتاق نجوا: $it") } }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("رمز اتاق")
            Panel {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (showPassword) controller.roomPassword(room.id) ?: "—" else "•••••••••••••",
                        style = Type.body.copy(fontFamily = Type.mono.fontFamily, textDirection = TextDirection.Ltr), color = c.text, modifier = Modifier.weight(1f),
                    )
                    RoundIconButton(if (showPassword) NajvaaIcons.EyeOff else NajvaaIcons.Eye, "نمایش رمز", size = 38.dp) { showPassword = !showPassword }
                    RoundIconButton(NajvaaIcons.Copy, "کپی رمز", size = 38.dp) { controller.roomPassword(room.id)?.let { controller.copySensitive(it); controller.toast("رمز کپی شد؛ خودکار پاک می‌شود") } }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("روی این گوشی")
            NajvaaField(title, { title = it }, label = "نام اتاق", leading = NajvaaIcons.Text, onImeAction = { controller.updateRoom(room.id) { it.title = title.trim().ifEmpty { roomTitle(room.code) } } })
            Spacer(Modifier.height(12.dp))
            NajvaaField(myName, { myName = it.take(24) }, label = "نام من (برای طرف مقابل)", placeholder = "بی‌نام", leading = NajvaaIcons.Users, onImeAction = { controller.updateRoom(room.id) { it.myName = myName.trim() } })
            if (title.trim() != room.title || myName.trim() != room.myName) {
                Spacer(Modifier.height(10.dp))
                SoftButton("ذخیره", icon = NajvaaIcons.Check) {
                    controller.updateRoom(room.id) { it.title = title.trim().ifEmpty { roomTitle(room.code) }; it.myName = myName.trim() }
                    controller.toast("ذخیره شد")
                }
            }
            Spacer(Modifier.height(8.dp))
            Panel {
                SwitchRow(NajvaaIcons.Pin, "سنجاق در فهرست", null, room.pinned) { v -> controller.updateRoom(room.id) { it.pinned = v } }
                Divider()
                SwitchRow(NajvaaIcons.BellOff, "بی‌صدا", "اعلان پیام‌های این اتاق نمایش داده نمی‌شود", room.muted) { v -> controller.updateRoom(room.id) { it.muted = v } }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("حذف خودکار پیام‌ها")
            Text("برای هر دو طرف اعمال می‌شود. زمان از لحظه‌ی دیده شدن حساب می‌شود.", style = Type.caption, color = c.text3, modifier = Modifier.padding(bottom = 8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TTL_OPTIONS.forEach { t ->
                    val on = room.ttl == t
                    Chip(ttlLabel(t), tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { engine?.setTtl(t); controller.updateRoom(room.id) { it.ttl = t } }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("دستگاه‌ها و شماره‌ی امنیتی")
            Panel {
                if (peers.isEmpty()) {
                    Text("هنوز دستگاهی متصل نیست. وقتی طرف مقابل آنلاین شود، شماره‌ی امنیتی مشترک این‌جا نمایش داده می‌شود؛ آن را تلفنی یا حضوری با هم مقایسه کنید.", style = Type.bodySmall, color = c.text3, modifier = Modifier.padding(16.dp))
                } else peers.forEachIndexed { i, p ->
                    if (i > 0) Divider(inset = 16.dp)
                    PeerRow(p, safety[p.id])
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("فضای سرور")
            Panel {
                SettingRow(NajvaaIcons.Search, "مدیریت پیام‌ها و فایل‌ها", "جستجو، فیلتر، حذف گروهی و ذخیره‌ی عکس‌ها در گالری", onClick = onManage)
                Divider()
                val u = usage
                if (u == null) {
                    Text("در حال خواندن…", style = Type.bodySmall, color = c.text3, modifier = Modifier.padding(16.dp))
                } else {
                    Column(Modifier.padding(16.dp)) {
                        Row { Text("این اتاق", style = Type.label, color = c.text2, modifier = Modifier.weight(1f)); Text("${sizeOf(u.roomBytes)} · ${fa(u.roomItems)} مورد", style = Type.label, color = c.text) }
                        Spacer(Modifier.height(8.dp))
                        Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(c.surface3)) {
                            Box(Modifier.fillMaxWidth(if (u.capBytes > 0) (u.totalBytes.toFloat() / u.capBytes).coerceIn(0f, 1f) else 0f).height(6.dp).background(c.primary))
                        }
                        Spacer(Modifier.height(6.dp))
                        Text("کل سرور ${sizeOf(u.totalBytes)} از ${sizeOf(u.capBytes)} · نگهداری تا ${fa(u.maxDays)} روز", style = Type.caption, color = c.text3)
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("منطقه‌ی خطر")
            Panel {
                SettingRow(NajvaaIcons.Trash, "پاک کردن همه‌ی پیام‌ها", "برای هر دو طرف و روی سرور", danger = true) { confirmClear = true }
                Divider()
                SettingRow(NajvaaIcons.Logout, "پاک کردن اتاق از این گوشی", "تاریخچه‌ی رمزشده روی سرور می‌ماند", danger = true) { confirmDelete = true }
            }
            Spacer(Modifier.height(40.dp))
        }
    }

    if (confirmClear) ConfirmDialog("پاک کردن همه‌ی پیام‌ها؟", "همه‌ی پیام‌ها و فایل‌های این اتاق برای هر دو طرف و از سرور پاک می‌شود. برگشت‌پذیر نیست.", "پاک کن", danger = true,
        onConfirm = { engine?.clearAll(); confirmClear = false; controller.toast("پیام‌ها پاک شد") }, onDismiss = { confirmClear = false })
    if (confirmDelete) ConfirmDialog("پاک کردن از این گوشی؟", "کلیدها و پیام‌های این اتاق از گوشی پاک می‌شود. با کد و رمز می‌توانید دوباره وارد شوید.", "پاک کن", danger = true,
        onConfirm = { confirmDelete = false; controller.deleteRoom(room.id); onDeleted() }, onDismiss = { confirmDelete = false })
}

@Composable
private fun PeerRow(p: PeerInfo, safety: Pair<String, String>?) {
    val c = LocalNajvaa.current
    Column(Modifier.padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(if (p.mobile) NajvaaIcons.Phone else NajvaaIcons.Laptop, null, tint = if (p.secure) c.success else c.text3, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text(p.name.ifEmpty { "طرف مقابل" }, style = Type.subtitle, color = c.text, modifier = Modifier.weight(1f))
            Text(if (p.secure) "امن" else "در حال دست‌دادن…", style = Type.caption, color = if (p.secure) c.success else c.accent)
        }
        if (safety != null) {
            Spacer(Modifier.height(10.dp))
            Text(fa(safety.first), style = Type.mono.copy(fontSize = Type.title.fontSize, textDirection = TextDirection.Ltr), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm)).background(c.surface2).padding(10.dp))
            Spacer(Modifier.height(6.dp))
            Text(safety.second, style = Type.caption, color = c.text3)
        }
    }
}
