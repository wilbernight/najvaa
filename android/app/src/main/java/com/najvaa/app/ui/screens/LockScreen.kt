package com.najvaa.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.MainActivity
import com.najvaa.app.UnlockResult
import com.najvaa.app.core.fa
import com.najvaa.app.ui.Biometric
import com.najvaa.app.ui.components.PasswordField
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import com.najvaa.app.vault.DeviceKey
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun LockScreen(controller: AppController, activity: MainActivity, onUnlocked: () -> Unit, onWiped: () -> Unit) {
    val c = LocalNajvaa.current
    val settings by controller.settings.collectAsState()
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var lockoutLeft by remember { mutableLongStateOf(controller.lockoutRemaining) }
    val shake = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val canBiometric = settings.biometric && controller.canUseBiometric() && Biometric.available(activity)

    LaunchedEffect(lockoutLeft) {
        while (lockoutLeft > 0) {
            delay(1_000)
            lockoutLeft = controller.lockoutRemaining
        }
    }

    fun handle(result: UnlockResult) {
        busy = false
        when (result) {
            UnlockResult.Ok -> { password = ""; onUnlocked() }
            UnlockResult.Wiped -> onWiped()
            is UnlockResult.Wrong -> {
                password = ""
                lockoutLeft = result.waitMillis
                error = when {
                    result.waitMillis > 0 -> "رمز اشتباه بود"
                    result.attemptsLeft in 1..2 -> "رمز اشتباه بود. ${fa(result.attemptsLeft)} تلاش تا پاک شدن همه‌چیز"
                    else -> "رمز اشتباه بود"
                }
                scope.launch { shake.animateTo(0f, keyframes { durationMillis = 420; 0f at 0; -14f at 60; 12f at 140; -8f at 220; 5f at 300; 0f at 420 }) }
            }
        }
    }

    fun submit() {
        if (password.isEmpty() || busy || lockoutLeft > 0) return
        busy = true
        scope.launch { handle(if (controller.hasLiveEngines) controller.resumeFromSoftLock(password) else controller.unlock(password)) }
    }

    fun biometric() {
        val blob = controller.wrappedBlob() ?: return
        val cipher = DeviceKey.decryptCipher(activity, blob) ?: run {
            // Key invalidated (biometrics changed): fall back to the password and clean up.
            controller.disableBiometric()
            error = "اثر انگشت گوشی تغییر کرده؛ با رمز وارد شوید و دوباره فعالش کنید"
            return
        }
        Biometric.prompt(activity, cipher, "باز کردن نجوا", onSuccess = { authed ->
            scope.launch {
                busy = true
                val ok = controller.unlockWithDevice(authed)
                busy = false
                if (ok) onUnlocked() else error = "باز کردن با اثر انگشت نشد؛ رمز را وارد کنید"
            }
        }, onFailure = { msg -> if (msg != null) error = msg })
    }

    LaunchedEffect(Unit) { if (canBiometric && lockoutLeft <= 0) biometric() }

    Column(
        Modifier.fillMaxSize().background(c.bgGradient).statusBarsPadding().navigationBarsPadding().imePadding().padding(horizontal = Space.gutter),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.weight(0.8f))
        com.najvaa.app.ui.components.NajvaLogo(84.dp)
        Spacer(Modifier.height(20.dp))
        Text("نجوا قفل است", style = Type.headline, color = c.text)
        Spacer(Modifier.height(6.dp))
        Text(if (controller.hasLiveEngines) "اتاق‌ها در پس‌زمینه متصل‌اند؛ برای دیدن، رمز لازم است" else "برای باز کردن اتاق‌ها رمز برنامه را وارد کنید", style = Type.bodySmall, color = c.text3, textAlign = TextAlign.Center)
        Spacer(Modifier.height(30.dp))
        Box(Modifier.offset { IntOffset(shake.value.toInt(), 0) }) {
            PasswordField(password, { password = it; error = null }, label = null, placeholder = "رمز برنامه", error = error, onImeAction = { submit() })
        }
        AnimatedVisibility(lockoutLeft > 0) {
            Text("به‌خاطر چند تلاش اشتباه، ${fa((lockoutLeft / 1000).toInt() + 1)} ثانیه صبر کنید", style = Type.caption, color = c.accent, modifier = Modifier.padding(top = 10.dp))
        }
        Spacer(Modifier.height(22.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                PrimaryButton("باز کردن", icon = NajvaaIcons.LockOpen, enabled = password.isNotEmpty() && lockoutLeft <= 0, loading = busy) { submit() }
            }
            if (canBiometric) {
                Spacer(Modifier.width(12.dp))
                RoundIconButton(NajvaaIcons.Fingerprint, "اثر انگشت", size = 54.dp, container = c.surface2, tint = c.primary) { biometric() }
            }
        }
        Spacer(Modifier.weight(1.2f))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(c.primary))
            Spacer(Modifier.width(8.dp))
            Text("رمزنگاری سرتاسری · کلیدها فقط روی این گوشی", style = Type.caption, color = c.text3)
        }
        Spacer(Modifier.height(20.dp))
    }
}
