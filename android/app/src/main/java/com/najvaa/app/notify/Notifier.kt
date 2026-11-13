package com.najvaa.app.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import com.najvaa.app.MainActivity
import com.najvaa.app.R
import com.najvaa.app.data.NotificationSound
import com.najvaa.app.data.Settings
import com.najvaa.app.data.VibrationStyle

/**
 * Message notifications. Android locks a channel's sound after it is created,
 * so every sound change retires the old channel and creates "messages.<n>"
 * with the new one; the user's choice always wins. Notifications never show
 * a message or a name unless the user opts in to the room title.
 */
class Notifier(private val context: Context) {

    private val manager get() = context.getSystemService(NotificationManager::class.java)

    fun soundUri(settings: Settings): Uri? = when (settings.notificationSound) {
        NotificationSound.SILENT -> null
        NotificationSound.SYSTEM -> settings.systemSoundUri?.let { Uri.parse(it) }
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        NotificationSound.NAJVA -> raw(R.raw.tone_najva)
        NotificationSound.DROP -> raw(R.raw.tone_drop)
        NotificationSound.BELL -> raw(R.raw.tone_bell)
        NotificationSound.PULSE -> raw(R.raw.tone_pulse)
    }

    private fun raw(res: Int): Uri = Uri.parse("android.resource://${context.packageName}/$res")

    private fun pattern(style: VibrationStyle): LongArray? = when (style) {
        VibrationStyle.OFF -> null
        VibrationStyle.SHORT -> longArrayOf(0, 60)
        VibrationStyle.DOUBLE -> longArrayOf(0, 50, 90, 50)
        VibrationStyle.LONG -> longArrayOf(0, 260)
    }

    fun channelId(settings: Settings) = "messages.${settings.soundVersion}"

    /** (Re)creates the message channel for the current sound; retires older ones. */
    fun ensureChannels(settings: Settings) {
        val nm = manager ?: return
        val id = channelId(settings)
        nm.notificationChannels.filter { it.id.startsWith("messages.") && it.id != id }.forEach { nm.deleteNotificationChannel(it.id) }
        if (nm.getNotificationChannel(id) == null) {
            val ch = NotificationChannel(id, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
                description = "پیام تازه در یک اتاق"
                lockscreenVisibility = Notification.VISIBILITY_SECRET
                setShowBadge(true)
                enableLights(true)
                lightColor = 0xFF3FC1B0.toInt()
                val uri = soundUri(settings)
                if (uri != null) {
                    setSound(uri, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                } else {
                    setSound(null, null)
                }
                val p = pattern(settings.vibration)
                enableVibration(p != null)
                if (p != null) vibrationPattern = p
            }
            nm.createNotificationChannel(ch)
        }
        if (nm.getNotificationChannel(SERVICE_CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(SERVICE_CHANNEL, context.getString(R.string.channel_service), NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                    lockscreenVisibility = Notification.VISIBILITY_SECRET
                },
            )
        }
    }

    fun showMessage(settings: Settings, roomId: String, roomTitle: String, count: Int) {
        if (!settings.notifications) return
        ensureChannels(settings)
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            putExtra("room", roomId)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(context, roomId.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = if (settings.showRoomInNotification) roomTitle else context.getString(R.string.notif_new_message)
        val body = if (count > 1) "${com.najvaa.app.core.fa(count)} پیام تازه" else context.getString(R.string.notif_new_message_body)
        val n = NotificationCompat.Builder(context, channelId(settings))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF3FC1B0.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setNumber(count)
            .build()
        runCatching { manager?.notify(roomId.hashCode(), n) }
    }

    fun clear(roomId: String) {
        runCatching { manager?.cancel(roomId.hashCode()) }
    }

    fun clearAll() {
        runCatching { manager?.cancelAll() }
    }

    fun serviceNotification(): Notification {
        val open = Intent(context, MainActivity::class.java)
        val pi = PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notif_service_title))
            .setContentText(context.getString(R.string.notif_service_body))
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
    }

    // ── preview from settings ──────────────────────────────────────────────
    private var preview: MediaPlayer? = null

    fun preview(settings: Settings) {
        preview?.release()
        preview = null
        vibrate(settings.vibration)
        val uri = soundUri(settings) ?: return
        preview = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(context, uri)
                setOnCompletionListener { it.release(); if (preview === it) preview = null }
                prepare()
                start()
            }
        }.getOrNull()
    }

    fun vibrate(style: VibrationStyle) {
        val p = pattern(style) ?: return
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        } ?: return
        runCatching { vibrator.vibrate(VibrationEffect.createWaveform(p, -1)) }
    }

    fun tick() {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") context.getSystemService(Vibrator::class.java)
        runCatching { vibrator?.vibrate(VibrationEffect.createOneShot(12, 80)) }
    }

    companion object {
        const val SERVICE_CHANNEL = "service"
        const val SERVICE_ID = 7
    }
}
