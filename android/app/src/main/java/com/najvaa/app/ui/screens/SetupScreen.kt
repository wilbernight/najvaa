package com.najvaa.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import com.najvaa.app.MainActivity
import com.najvaa.app.ui.Biometric
import com.najvaa.app.ui.components.Banner
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.Panel
import com.najvaa.app.ui.components.PasswordField
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.components.SwitchRow
import com.najvaa.app.ui.components.passwordScore
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import com.najvaa.app.vault.DeviceKey
import kotlinx.coroutines.launch

@Composable
fun SetupScreen(controller: AppController, activity: MainActivity, onDone: () -> Unit) {
    val c = LocalNajvaa.current
    var password by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    var useBiometric by rememberSaveable { mutableStateOf(Biometric.available(activity)) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val strongEnough = passwordScore(password) >= 2 && password.length >= 8
    val matches = confirm == password

    fun finish() {
        if (!strongEnough) { error = "رمز باید دست‌کم ۸ نویسه و ترکیبی از حرف و عدد باشد"; return }
        if (!matches) { error = "دو رمز یکی نیستند"; return }
        busy = true
        scope.launch {
            controller.setUp(password)
            controller.updateSettings { it.copy(biometric = useBiometric) }
            if (useBiometric) {
                val cipher = DeviceKey.encryptCipher(activity)
                if (cipher != null) {
                    Biometric.prompt(activity, cipher, "فعال‌سازی اثر انگشت", "برای باز کردن نجوا بدون رمز",
                        onSuccess = { controller.completeBiometricEnrol(it); onDone() },
                        onFailure = { controller.updateSettings { s -> s.copy(biometric = false) }; onDone() })
                    return@launch
                }
            }
            onDone()
        }
    }

    NajvaaScreen(title = "رمز برنامه", subtitle = "قفل همه‌ی اتاق‌ها روی این گوشی") {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = Space.gutter)) {
            Text("یک رمز برای خود برنامه بگذارید. با آن، همه‌ی اتاق‌هایی که وارد شده‌اید یک‌جا باز می‌شوند؛ رمز هر اتاق جداگانه و رمزشده نگه داشته می‌شود.", style = Type.body, color = c.text2)
            Spacer(Modifier.height(22.dp))
            PasswordField(password, { password = it; error = null }, label = "رمز برنامه", placeholder = "دست‌کم ۸ نویسه", strength = true, imeAction = ImeAction.Next)
            Spacer(Modifier.height(16.dp))
            PasswordField(confirm, { confirm = it; error = null }, label = "تکرار رمز", placeholder = "دوباره", error = error, onImeAction = { finish() })
            Spacer(Modifier.height(18.dp))
            if (Biometric.available(activity)) {
                Panel { SwitchRow(NajvaaIcons.Fingerprint, "باز کردن با اثر انگشت", "کلید در سخت‌افزار امن گوشی قفل می‌شود و با تغییر اثر انگشت از بین می‌رود", useBiometric) { useBiometric = it } }
                Spacer(Modifier.height(16.dp))
            }
            Banner("این رمز هیچ‌جا ذخیره نمی‌شود و راهی برای بازیابی آن نیست. فراموشش کنید، همه‌چیز روی این گوشی از دست می‌رود.", icon = NajvaaIcons.Warning)
            Spacer(Modifier.height(24.dp))
            PrimaryButton("ساخت قفل", icon = NajvaaIcons.Lock, enabled = password.isNotEmpty() && confirm.isNotEmpty(), loading = busy) { finish() }
            Spacer(Modifier.height(32.dp))
        }
    }
}
