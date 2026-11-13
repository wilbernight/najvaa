package com.najvaa.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.BuildConfig
import com.najvaa.app.MainActivity
import com.najvaa.app.core.fa
import com.najvaa.app.data.AppTheme
import com.najvaa.app.ui.Biometric
import com.najvaa.app.ui.components.Chip
import com.najvaa.app.ui.components.ConfirmDialog
import com.najvaa.app.ui.components.Divider
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.Panel
import com.najvaa.app.ui.components.PasswordField
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.components.SectionLabel
import com.najvaa.app.ui.components.SettingRow
import com.najvaa.app.ui.components.SoftButton
import com.najvaa.app.ui.components.SwitchRow
import com.najvaa.app.ui.components.passwordScore
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import com.najvaa.app.vault.DeviceKey
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(controller: AppController, activity: MainActivity, onBack: () -> Unit, onSound: () -> Unit, onWiped: () -> Unit) {
    val c = LocalNajvaa.current
    val s by controller.settings.collectAsState()
    var changePass by remember { mutableStateOf(false) }
    var duress by remember { mutableStateOf(false) }
    var confirmWipe by remember { mutableStateOf(false) }
    val biometricHw = Biometric.available(activity)

    fun enrolBiometric() {
        val cipher = DeviceKey.encryptCipher(activity) ?: run { controller.toast("سخت‌افزار امن در دسترس نیست", warn = true); return }
        Biometric.prompt(activity, cipher, "فعال‌سازی اثر انگشت", "برای باز کردن نجوا بدون رمز",
            onSuccess = { if (controller.completeBiometricEnrol(it)) controller.updateSettings { s0 -> s0.copy(biometric = true) } },
            onFailure = { msg -> if (msg != null) controller.toast(msg, warn = true) })
    }

    NajvaaScreen(title = "تنظیمات", onBack = onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter)) {
            SectionLabel("ظاهر")
            Panel {
                Column(Modifier.padding(16.dp)) {
                    Text("پوسته", style = Type.label, color = c.text2)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AppTheme.entries.forEach { t ->
                            val on = s.theme == t
                            Chip(t.label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { controller.updateSettings { it.copy(theme = t) } }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("اندازه‌ی نوشته", style = Type.label, color = c.text2)
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(0.9f to "کوچک", 1f to "معمولی", 1.12f to "بزرگ", 1.25f to "خیلی بزرگ").forEach { (f, label) ->
                            val on = s.fontScale == f
                            Chip(label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { controller.updateSettings { it.copy(fontScale = f) } }
                        }
                    }
                }
                Divider(inset = 16.dp)
                SwitchRow(NajvaaIcons.Vibrate, "لرزش لمسی", "بازخورد کوتاه هنگام ارسال و انتخاب", s.hapticFeedback) { v -> controller.updateSettings { it.copy(hapticFeedback = v) } }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("اعلان")
            Panel {
                SwitchRow(NajvaaIcons.Bell, "اعلان پیام تازه", "محتوای پیام هرگز در اعلان نمایش داده نمی‌شود", s.notifications) { v -> controller.updateSettings { it.copy(notifications = v) } }
                Divider()
                SettingRow(NajvaaIcons.Sound, "صدا و لرزش", "${s.notificationSound.label} · لرزش ${s.vibration.label}", onClick = onSound)
                Divider()
                SwitchRow(NajvaaIcons.Chat, "نام اتاق در اعلان", "در حالت خاموش فقط «پیام تازه» نشان داده می‌شود", s.showRoomInNotification) { v -> controller.updateSettings { it.copy(showRoomInNotification = v) } }
                Divider()
                SwitchRow(NajvaaIcons.Bolt, "اتصال پس‌زمینه", "پیام‌ها بی‌درنگ می‌رسند؛ یک اعلان ثابت نمایش داده می‌شود و باتری کمی بیشتر مصرف می‌شود", s.backgroundLink) { v -> controller.updateSettings { it.copy(backgroundLink = v) } }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("قفل و امنیت")
            Panel {
                if (biometricHw) {
                    SwitchRow(NajvaaIcons.Fingerprint, "باز کردن با اثر انگشت", "کلید در سخت‌افزار امن گوشی", s.biometric && controller.canUseBiometric()) { v ->
                        if (v) enrolBiometric() else controller.updateSettings { it.copy(biometric = false) }
                    }
                    Divider()
                }
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text("قفل خودکار پس از خروج", style = Type.label, color = c.text2)
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(0 to "بی‌درنگ", 30 to "۳۰ ثانیه", 120 to "۲ دقیقه", 600 to "۱۰ دقیقه", 1800 to "۳۰ دقیقه").forEach { (sec, label) ->
                            val on = s.autoLockSeconds == sec
                            Chip(label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { controller.updateSettings { it.copy(autoLockSeconds = sec) } }
                        }
                    }
                }
                Divider(inset = 16.dp)
                SwitchRow(NajvaaIcons.Lock, "قفل با خاموش شدن صفحه", null, s.lockOnScreenOff) { v -> controller.updateSettings { it.copy(lockOnScreenOff = v) } }
                Divider()
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text("پاک شدن پس از تلاش‌های اشتباه", style = Type.label, color = c.text2)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(0 to "هرگز", 5 to "۵", 8 to "۸", 12 to "۱۲").forEach { (n, label) ->
                            val on = s.wipeAfterFailures == n
                            Chip(label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { controller.updateSettings { it.copy(wipeAfterFailures = n) } }
                        }
                    }
                }
                Divider(inset = 16.dp)
                SettingRow(NajvaaIcons.Key, "تغییر رمز برنامه", "اثر انگشت باید دوباره فعال شود") { changePass = true }
                Divider()
                SettingRow(NajvaaIcons.Warning, "رمز اضطراری", if (s.duressEnabled) "فعال؛ ورود با آن همه‌چیز را بی‌سروصدا پاک می‌کند" else "رمزی که در فشار وارد می‌کنید و همه‌چیز را پاک می‌کند", iconTint = c.accent) { duress = true }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("حریم خصوصی")
            Panel {
                SwitchRow(NajvaaIcons.Camera, "جلوگیری از اسکرین‌شات", "محتوای برنامه در فهرست برنامه‌های اخیر هم پنهان می‌ماند", s.blockScreenshots) { v -> controller.updateSettings { it.copy(blockScreenshots = v) } }
                Divider()
                SwitchRow(NajvaaIcons.Sparkle, "متن محرمانه (ضد زوم)", "متن پیام‌ها زیر ذرات متحرک پنهان است و فقط زیر انگشتِ نگه‌داشته دیده می‌شود", s.veil) { v -> controller.updateSettings { it.copy(veil = v) } }
                Divider()
                SwitchRow(NajvaaIcons.EyeOff, "پیام‌ها محو تا لمس", "پیام‌های تازه تا نگه‌داشتن انگشت، مات نمایش داده می‌شوند", s.spoiler) { v -> controller.updateSettings { it.copy(spoiler = v) } }
                Divider()
                SwitchRow(NajvaaIcons.Keyboard, "کیبورد بی‌حافظه", "از صفحه‌کلید می‌خواهد پیشنهاد و یادگیری را خاموش کند", s.incognitoKeyboard) { v -> controller.updateSettings { it.copy(incognitoKeyboard = v) } }
                Divider()
                SwitchRow(NajvaaIcons.Mic, "صدای ناشناس در پیام صوتی", "پیش از رمزنگاری، صدای شما به صدای رباتیکِ بی‌جنسیت تبدیل می‌شود و صدای واقعی‌تان فرستاده نمی‌شود", s.voiceFx) { v -> controller.updateSettings { it.copy(voiceFx = v) } }
                Divider()
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text("پاک شدن خودکار کلیپ‌بورد", style = Type.label, color = c.text2)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(15 to "۱۵ ثانیه", 45 to "۴۵ ثانیه", 120 to "۲ دقیقه", 0 to "هرگز").forEach { (sec, label) ->
                            val on = s.clipboardClearSeconds == sec
                            Chip(label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) { controller.updateSettings { it.copy(clipboardClearSeconds = sec) } }
                        }
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("درباره")
            Panel {
                SettingRow(NajvaaIcons.Info, "نجوا برای اندروید", "نسخه‌ی ${fa(BuildConfig.VERSION_NAME)} · سازگار با najvaa.xyz")
                Divider()
                SettingRow(NajvaaIcons.Shield, "رمزنگاری", "PBKDF2 ۸۰۰هزار دور · X25519 + P-256 · AES-256-GCM · چرخش کلید خودکار")
                Divider()
                SettingRow(NajvaaIcons.Trash, "پاک کردن همه‌چیز از این گوشی", "همه‌ی اتاق‌ها، کلیدها و رمز برنامه", danger = true) { confirmWipe = true }
            }
            Spacer(Modifier.height(40.dp))
        }
    }

    if (changePass) ChangePasswordDialog(controller) { changePass = false }
    if (duress) DuressDialog(controller, s.duressEnabled) { duress = false }
    if (confirmWipe) ConfirmDialog("پاک کردن همه‌چیز؟", "همه‌ی اتاق‌ها، کلیدها و رمز برنامه از این گوشی پاک می‌شود. تاریخچه‌ی رمزشده روی سرور می‌ماند و با کد و رمز هر اتاق دوباره در دسترس است.", "پاک کن", danger = true,
        onConfirm = { confirmWipe = false; controller.wipe(); onWiped() }, onDismiss = { confirmWipe = false })
}

@Composable
private fun ChangePasswordDialog(controller: AppController, onClose: () -> Unit) {
    val c = LocalNajvaa.current
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onClose, containerColor = c.surface2, titleContentColor = c.text, textContentColor = c.text2,
        title = { Text("تغییر رمز برنامه", style = Type.title) },
        text = {
            Column {
                PasswordField(current, { current = it; error = null }, label = "رمز فعلی", imeAction = ImeAction.Next)
                Spacer(Modifier.height(10.dp))
                PasswordField(next, { next = it; error = null }, label = "رمز تازه", strength = true, imeAction = ImeAction.Next)
                Spacer(Modifier.height(10.dp))
                PasswordField(confirm, { confirm = it; error = null }, label = "تکرار رمز تازه", error = error)
            }
        },
        confirmButton = {
            PrimaryButton("تغییر", enabled = current.isNotEmpty() && next.isNotEmpty() && confirm.isNotEmpty(), loading = busy) {
                when {
                    next.length < 8 || passwordScore(next) < 2 -> error = "رمز تازه باید دست‌کم ۸ نویسه و ترکیبی باشد"
                    next != confirm -> error = "دو رمز یکی نیستند"
                    else -> {
                        busy = true
                        scope.launch {
                            val ok = controller.changePassword(current, next)
                            busy = false
                            if (ok) { controller.toast("رمز برنامه عوض شد"); onClose() } else error = "رمز فعلی اشتباه است"
                        }
                    }
                }
            }
        },
        dismissButton = { SoftButton("انصراف", onClick = onClose) },
    )
}

@Composable
private fun DuressDialog(controller: AppController, enabled: Boolean, onClose: () -> Unit) {
    val c = LocalNajvaa.current
    var value by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onClose, containerColor = c.surface2, titleContentColor = c.text, textContentColor = c.text2,
        title = { Text("رمز اضطراری", style = Type.title) },
        text = {
            Column {
                Text("اگر کسی شما را وادار به باز کردن برنامه کرد، این رمز را وارد کنید: برنامه بدون هیچ نشانه‌ای همه‌ی اتاق‌ها و کلیدها را پاک می‌کند و مثل نصب تازه بالا می‌آید.", style = Type.bodySmall)
                Spacer(Modifier.height(12.dp))
                PasswordField(value, { value = it }, label = "رمز اضطراری", hint = "باید با رمز اصلی فرق داشته باشد")
            }
        },
        confirmButton = {
            PrimaryButton(if (enabled) "به‌روزرسانی" else "فعال‌سازی", enabled = value.length >= 4, loading = busy) {
                busy = true
                scope.launch {
                    controller.setDuress(value)
                    controller.updateSettings { it.copy(duressEnabled = true) }
                    busy = false
                    controller.toast("رمز اضطراری فعال شد")
                    onClose()
                }
            }
        },
        dismissButton = {
            if (enabled) SoftButton("غیرفعال", danger = true) {
                scope.launch { controller.setDuress(null); controller.updateSettings { it.copy(duressEnabled = false) }; onClose() }
            } else SoftButton("انصراف", onClick = onClose)
        },
    )
}
