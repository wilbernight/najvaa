package com.najvaa.app.data

import android.content.Context
import org.json.JSONObject

/**
 * Preferences that are not secrets (theme, sounds, lock timing). They live in
 * plain SharedPreferences so the notification channel and theme are right
 * before the vault is open. Nothing about any room is stored here.
 */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("najvaa.settings", Context.MODE_PRIVATE)

    fun load(): Settings {
        val raw = prefs.getString("s", null) ?: return Settings()
        return runCatching {
            val o = JSONObject(raw)
            Settings(
                theme = enum(o.optString("theme"), AppTheme.SYSTEM),
                biometric = o.optBoolean("biometric", true),
                autoLockSeconds = o.optInt("autoLock", 30),
                lockOnScreenOff = o.optBoolean("lockOnScreenOff", true),
                wipeAfterFailures = o.optInt("wipeAfter", 5),
                blockScreenshots = o.optBoolean("blockShots", true),
                spoiler = o.optBoolean("spoiler", true),
                incognitoKeyboard = o.optBoolean("incognito", true),
                clipboardClearSeconds = o.optInt("clipClear", 45),
                notifications = o.optBoolean("notif", true),
                notificationSound = enum(o.optString("sound"), NotificationSound.NAJVA),
                systemSoundUri = o.optString("sysSound").ifEmpty { null },
                vibration = enum(o.optString("vib"), VibrationStyle.SHORT),
                showRoomInNotification = o.optBoolean("showRoom", false),
                backgroundLink = o.optBoolean("bgLink", false),
                soundVersion = o.optInt("soundVer", 1),
                hapticFeedback = o.optBoolean("haptic", true),
                duressEnabled = o.optBoolean("duress", false),
                fontScale = o.optDouble("fontScale", 1.0).toFloat(),
                veil = o.optBoolean("veil", true),
                voiceFx = o.optBoolean("voiceFx", false),
            )
        }.getOrDefault(Settings())
    }

    fun save(s: Settings) {
        val o = JSONObject()
            .put("theme", s.theme.name).put("biometric", s.biometric).put("autoLock", s.autoLockSeconds)
            .put("lockOnScreenOff", s.lockOnScreenOff).put("wipeAfter", s.wipeAfterFailures).put("blockShots", s.blockScreenshots)
            .put("spoiler", s.spoiler).put("incognito", s.incognitoKeyboard).put("clipClear", s.clipboardClearSeconds)
            .put("notif", s.notifications).put("sound", s.notificationSound.name).put("sysSound", s.systemSoundUri ?: "")
            .put("vib", s.vibration.name).put("showRoom", s.showRoomInNotification).put("bgLink", s.backgroundLink)
            .put("soundVer", s.soundVersion).put("haptic", s.hapticFeedback).put("duress", s.duressEnabled)
            .put("fontScale", s.fontScale.toDouble()).put("veil", s.veil).put("voiceFx", s.voiceFx)
        prefs.edit().putString("s", o.toString()).apply()
    }

    var failedAttempts: Int
        get() = prefs.getInt("fails", 0)
        set(v) = prefs.edit().putInt("fails", v).apply()

    var lockoutUntil: Long
        get() = prefs.getLong("lockout", 0)
        set(v) = prefs.edit().putLong("lockout", v).apply()

    var onboarded: Boolean
        get() = prefs.getBoolean("onboarded", false)
        set(v) = prefs.edit().putBoolean("onboarded", v).apply()

    fun clear() = prefs.edit().clear().apply()

    private inline fun <reified T : Enum<T>> enum(name: String, default: T): T =
        runCatching { enumValueOf<T>(name) }.getOrDefault(default)
}
