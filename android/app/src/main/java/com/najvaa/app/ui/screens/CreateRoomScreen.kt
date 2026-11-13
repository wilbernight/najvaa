package com.najvaa.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.core.spacedCode
import com.najvaa.app.ui.components.Banner
import com.najvaa.app.ui.components.CodeDisplay
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.Panel
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.SectionLabel
import com.najvaa.app.ui.components.SoftButton
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.launch

@Composable
fun CreateRoomScreen(controller: AppController, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = LocalNajvaa.current
    var code by rememberSaveable { mutableStateOf(controller.newCode()) }
    var password by rememberSaveable { mutableStateOf(controller.newPassword()) }
    var title by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun create() {
        busy = true
        scope.launch {
            val room = controller.createRoom(code, password, title)
            busy = false
            if (room == null) {
                controller.toast("این کد قبلاً گرفته شده؛ کد تازه‌ای ساخته شد", warn = true)
                code = controller.newCode()
            } else onOpen(room.id)
        }
    }

    NajvaaScreen(title = "اتاق تازه", subtitle = "کد و رمز را جداگانه بدهید", onBack = onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Space.gutter)) {
            SectionLabel("کد اتاق")
            Panel(padding = androidx.compose.foundation.layout.PaddingValues(14.dp)) {
                CodeDisplay(code, Modifier.fillMaxWidth(), onCopy = { controller.copySensitive(code); controller.toast("کد کپی شد") })
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SoftButton("ارسال کد", Modifier.weight(1f), icon = NajvaaIcons.Share) { controller.shareText("کد اتاق نجوا: ${spacedCode(code)}\nhttps://najvaa.xyz") }
                    RoundIconButton(NajvaaIcons.Refresh, "کد تازه", container = c.surface2) { code = controller.newCode() }
                }
            }
            Spacer(Modifier.height(18.dp))
            SectionLabel("رمز اتاق")
            Panel(padding = androidx.compose.foundation.layout.PaddingValues(14.dp)) {
                NajvaaField(password, { password = it }, placeholder = "رمز اتاق", leading = NajvaaIcons.Key, textStyle = Type.mono.copy(fontSize = Type.body.fontSize, letterSpacing = 1.sp()), textDirection = TextDirection.Ltr, incognito = true, hint = "هرچه بلندتر، امن‌تر؛ این رمز کلید همه‌ی پیام‌هاست")
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SoftButton("ارسال رمز", Modifier.weight(1f), icon = NajvaaIcons.Share, enabled = password.isNotBlank()) { controller.shareText("رمز اتاق نجوا: $password") }
                    RoundIconButton(NajvaaIcons.Copy, "کپی رمز", container = c.surface2) { controller.copySensitive(password); controller.toast("رمز کپی شد؛ خودکار پاک می‌شود") }
                    RoundIconButton(NajvaaIcons.Refresh, "رمز تازه", container = c.surface2) { password = controller.newPassword() }
                }
            }
            Spacer(Modifier.height(18.dp))
            SectionLabel("نام اتاق (فقط روی این گوشی)")
            NajvaaField(title, { title = it }, placeholder = "مثلاً: سارا", leading = NajvaaIcons.Text, onImeAction = { if (password.isNotBlank()) create() })
            Spacer(Modifier.height(18.dp))
            Banner("کد را از یک راه و رمز را از راه دیگری بفرستید؛ هرکس هر دو را داشته باشد، می‌تواند پیام‌ها را بخواند.", icon = NajvaaIcons.Shield, tint = c.primary)
            Spacer(Modifier.height(24.dp))
            PrimaryButton("ساخت و ورود", icon = NajvaaIcons.Plus, enabled = password.isNotBlank() && code.length == 7, loading = busy) { create() }
            Spacer(Modifier.height(10.dp))
            Text("رمز اتاق روی این گوشی با رمز برنامه قفل می‌شود و روی سرور هرگز فرستاده نمی‌شود.", style = Type.caption, color = c.text3)
            Spacer(Modifier.height(32.dp))
        }
    }
}

private fun Int.sp() = androidx.compose.ui.unit.TextUnit(this.toFloat(), androidx.compose.ui.unit.TextUnitType.Sp)
