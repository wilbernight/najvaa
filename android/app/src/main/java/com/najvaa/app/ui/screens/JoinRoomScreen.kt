package com.najvaa.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.JoinResult
import com.najvaa.app.core.latinDigits
import com.najvaa.app.ui.components.CodeField
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.PasswordField
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.components.SectionLabel
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.launch

@Composable
fun JoinRoomScreen(controller: AppController, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = LocalNajvaa.current
    var code by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var codeError by remember { mutableStateOf<String?>(null) }
    var passError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ready = code.length == 7 && password.isNotBlank()

    fun join() {
        if (!ready || busy) return
        busy = true
        scope.launch {
            when (val r = controller.joinRoom(code, password, title)) {
                is JoinResult.Ok -> onOpen(r.room.id)
                JoinResult.WrongPassword -> passError = "رمز با این اتاق نمی‌خواند"
                JoinResult.AlreadyHere -> codeError = "این اتاق همین حالا روی گوشی هست"
                JoinResult.Offline -> controller.toast("به سرور نرسیدیم؛ اتصال را بررسی کنید", warn = true)
            }
            busy = false
        }
    }

    NajvaaScreen(title = "ورود به اتاق", subtitle = "کد و رمزی که برایتان فرستاده‌اند", onBack = onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Space.gutter)) {
            SectionLabel("کد هفت‌رقمی")
            CodeField(code, { code = latinDigits(it).filter(Char::isDigit).take(7); codeError = null }, error = codeError, autoFocus = true)
            Spacer(Modifier.height(20.dp))
            PasswordField(password, { password = it; passError = null }, label = "رمز اتاق", placeholder = "رمزی که سازنده‌ی اتاق داده", error = passError, imeAction = ImeAction.Next)
            Spacer(Modifier.height(16.dp))
            NajvaaField(title, { title = it }, label = "نام اتاق (اختیاری)", placeholder = "فقط روی این گوشی دیده می‌شود", leading = NajvaaIcons.Text, onImeAction = { join() })
            Spacer(Modifier.height(26.dp))
            PrimaryButton("ورود", icon = NajvaaIcons.Forward, enabled = ready, loading = busy) { join() }
            Spacer(Modifier.height(12.dp))
            Text("رمز اشتباه یعنی کلیدهای متفاوت؛ سرور فقط می‌فهمد که با رمز این اتاق نمی‌خواند، نه این‌که رمز چیست.", style = Type.caption, color = c.text3)
            Spacer(Modifier.height(32.dp))
        }
    }
}
