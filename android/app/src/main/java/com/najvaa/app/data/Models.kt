package com.najvaa.app.data

enum class Direction { OUT, IN }

enum class Kind { TEXT, IMAGE, VIDEO, AUDIO, VOICE, GIF, FILE }

/** Where an outgoing message stands on its way to the other side. */
enum class Delivery { QUEUED, STORED, DELIVERED, READ }

data class Reply(
    val id: String,
    val author: String?,
    val snippet: String,
    val kind: String = "text",
)

/**
 * One entry in a room. Text and files share the type; file fields are null
 * for text. [serverTs] is the store's clock and orders the list; [sentAt]
 * is the sender's own clock, shown as the time.
 */
data class Message(
    val id: String,
    val dir: Direction,
    val kind: Kind,
    val author: String,
    val authorName: String = "",
    val body: String = "",
    val sentAt: Long,
    val serverTs: Long = sentAt,
    val ttl: Int = 0,
    val expiresAt: Long? = null,
    val reply: Reply? = null,
    val edited: Boolean = false,
    val delivery: Delivery = Delivery.STORED,
    val readByMe: Boolean = false,
    val myReaction: String? = null,
    val peerReactions: Map<String, String> = emptyMap(),
    // files
    val fileName: String? = null,
    val mime: String? = null,
    val size: Long = 0,
    val chunks: Int = 0,
    val fileKey: String? = null,
    val caption: String? = null,
    val voiceSeconds: Int = 0,
    val voiceWave: String? = null,
    val deleted: Boolean = false,
) {
    val orderTs: Long get() = if (serverTs > 0) serverTs else sentAt
    val isMedia: Boolean get() = kind == Kind.IMAGE || kind == Kind.VIDEO || kind == Kind.GIF
    val isFile: Boolean get() = kind != Kind.TEXT

    fun preview(): String = when (kind) {
        Kind.TEXT -> body
        Kind.IMAGE -> "📷 عکس"
        Kind.VIDEO -> "🎬 ویدیو"
        Kind.AUDIO -> "🎵 ${fileName ?: "آهنگ"}"
        Kind.VOICE -> "🎙 پیام صوتی"
        Kind.GIF -> "گیف"
        Kind.FILE -> "📎 ${fileName ?: "فایل"}"
    }
}

/** Room metadata kept in the encrypted index; never the password in clear. */
data class Room(
    val id: String,
    val code: String,
    val title: String,
    val createdAt: Long,
    val lastAt: Long,
    val lastPreview: String = "",
    val unread: Int = 0,
    val pinned: Boolean = false,
    val muted: Boolean = false,
    val ttl: Int = 0,
    val myName: String = "",
    val waiting: Boolean = true,
)

enum class LinkState { OFFLINE, CONNECTING, CONNECTED, LIVE, MISMATCH, FULL }

data class PeerInfo(val id: String, val name: String, val secure: Boolean, val mobile: Boolean)

enum class NotificationSound(val label: String) {
    NAJVA("نجوا"),
    DROP("قطره"),
    BELL("زنگ"),
    PULSE("نبض"),
    SYSTEM("صدای سیستم"),
    SILENT("بی‌صدا"),
}

enum class VibrationStyle(val label: String) { OFF("خاموش"), SHORT("کوتاه"), DOUBLE("دوتایی"), LONG("بلند") }

enum class AppTheme(val label: String) { SYSTEM("مطابق دستگاه"), DARK("تیره"), LIGHT("روشن") }

data class Settings(
    val theme: AppTheme = AppTheme.SYSTEM,
    val biometric: Boolean = true,
    val autoLockSeconds: Int = 30,
    val lockOnScreenOff: Boolean = true,
    val wipeAfterFailures: Int = 5,
    val blockScreenshots: Boolean = true,
    val spoiler: Boolean = true,
    val incognitoKeyboard: Boolean = true,
    val clipboardClearSeconds: Int = 45,
    val notifications: Boolean = true,
    val notificationSound: NotificationSound = NotificationSound.NAJVA,
    val systemSoundUri: String? = null,
    val vibration: VibrationStyle = VibrationStyle.SHORT,
    val showRoomInNotification: Boolean = false,
    val backgroundLink: Boolean = false,
    val soundVersion: Int = 1,
    val hapticFeedback: Boolean = true,
    val duressEnabled: Boolean = false,
    val fontScale: Float = 1f,
    /** Message text hidden under moving particles, shown only under a resting finger (web: "متن محرمانه"). */
    val veil: Boolean = true,
    /** Voice messages are re-synthesised as an anonymous robotic voice before encryption. */
    val voiceFx: Boolean = false,
)
