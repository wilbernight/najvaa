package com.najvaa.app.ui.screens

import android.app.Activity
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.najvaa.app.AppController
import com.najvaa.app.MainActivity
import com.najvaa.app.data.NotificationSound
import com.najvaa.app.data.VibrationStyle
import com.najvaa.app.ui.components.Chip
import com.najvaa.app.ui.components.Divider
import com.najvaa.app.ui.components.NajvaaScreen
import com.najvaa.app.ui.components.Panel
import com.najvaa.app.ui.components.RoundIconButton
import com.najvaa.app.ui.components.SectionLabel
import com.najvaa.app.ui.components.SoftButton
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type

@Composable
fun SoundScreen(controller: AppController, activity: MainActivity, onBack: () -> Unit) {
    val c = LocalNajvaa.current
    val s by controller.settings.collectAsState()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            @Suppress("DEPRECATION")
            val uri: Uri? = result.data?.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
            controller.updateSettings { it.copy(notificationSound = NotificationSound.SYSTEM, systemSoundUri = uri?.toString()) }
            controller.notifier.preview(controller.settings.value)
        }
    }

    fun pickSystem() {
        val i = Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
            putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
            putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "صدای اعلان نجوا")
            putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
            putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, s.systemSoundUri?.let { Uri.parse(it) } ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
        }
        runCatching { picker.launch(i) }.onFailure { controller.toast("انتخاب‌گر صدای سیستم در دسترس نیست", warn = true) }
    }

    val descriptions = mapOf(
        NotificationSound.NAJVA to "دو نت نرم؛ صدای خود نجوا",
        NotificationSound.DROP to "یک قطره؛ کوتاه و بی‌سروصدا",
        NotificationSound.BELL to "زنگ شفاف؛ برای محیط شلوغ",
        NotificationSound.PULSE to "نبض کوتاه؛ خنثی",
        NotificationSound.SYSTEM to "از صداهای گوشی انتخاب کنید",
        NotificationSound.SILENT to "فقط لرزش یا هیچ",
    )

    NajvaaScreen(title = "صدا و لرزش", subtitle = "اعلان پیام تازه", onBack = onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter)) {
            SectionLabel("صدا")
            Panel {
                NotificationSound.entries.forEachIndexed { i, sound ->
                    if (i > 0) Divider(inset = 16.dp)
                    val on = s.notificationSound == sound
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            if (sound == NotificationSound.SYSTEM) pickSystem()
                            else { controller.updateSettings { it.copy(notificationSound = sound) }; controller.notifier.preview(controller.settings.value) }
                        }.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(22.dp).clip(CircleShape).background(if (on) c.primary else c.surface3), contentAlignment = Alignment.Center) {
                            if (on) Icon(NajvaaIcons.Check, null, tint = c.onPrimary, modifier = Modifier.size(14.dp))
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(sound.label, style = Type.subtitle, color = c.text)
                            Text(descriptions[sound] ?: "", style = Type.caption, color = c.text3)
                        }
                        if (sound != NotificationSound.SILENT) RoundIconButton(NajvaaIcons.Play, "پخش", size = 36.dp, tint = c.primary) {
                            if (sound == NotificationSound.SYSTEM && s.notificationSound != sound) pickSystem()
                            else controller.notifier.preview(s.copy(notificationSound = sound))
                        }
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("لرزش")
            Panel {
                Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    VibrationStyle.entries.forEach { v ->
                        val on = s.vibration == v
                        Chip(v.label, tint = if (on) c.onPrimary else c.text2, bg = if (on) c.primary else c.surface2) {
                            controller.updateSettings { it.copy(vibration = v) }
                            controller.notifier.vibrate(v)
                        }
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            SoftButton("آزمایش اعلان", icon = NajvaaIcons.Bell, modifier = Modifier.fillMaxWidth()) { controller.notifier.preview(s) }
            Spacer(Modifier.height(10.dp))
            Text("اندروید صدای هر کانال اعلان را قفل می‌کند؛ نجوا با هر تغییر، کانال تازه‌ای می‌سازد تا انتخاب شما همیشه اعمال شود.", style = Type.caption, color = c.text3)
            Spacer(Modifier.height(40.dp))
        }
    }
}
