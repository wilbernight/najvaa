package com.najvaa.app.core

import java.util.Calendar
import java.util.Locale

private const val PERSIAN_ZERO = '۰'

/** Converts every ASCII digit in the string to a Persian digit. */
fun fa(value: String): String {
    val out = StringBuilder(value.length)
    for (ch in value) out.append(if (ch in '0'..'9') (PERSIAN_ZERO + (ch - '0')) else ch)
    return out.toString()
}

fun fa(value: Int): String = fa(value.toString())
fun fa(value: Long): String = fa(value.toString())

/** Persian or Arabic-Indic digits typed by the user back to ASCII. */
fun latinDigits(value: String): String {
    val out = StringBuilder(value.length)
    for (ch in value) {
        out.append(
            when (ch) {
                in '۰'..'۹' -> '0' + (ch - '۰')
                in '٠'..'٩' -> '0' + (ch - '٠')
                else -> ch
            },
        )
    }
    return out.toString()
}

/** 1177951 -> "117 7951" */
fun spacedCode(code: String): String = if (code.length == 7) "${code.take(3)} ${code.drop(3)}" else code

/**
 * Default room title: Persian digits joined by a no-break space, which the
 * bidi algorithm treats as part of one number, so the two halves keep their
 * order inside right-to-left text.
 */
fun roomTitle(code: String): String =
    "اتاق " + if (code.length == 7) "${fa(code.take(3))}\u00A0${fa(code.drop(3))}" else fa(code)

fun clockOf(ts: Long): String {
    val c = Calendar.getInstance().apply { timeInMillis = ts }
    return fa(String.format(Locale.US, "%02d:%02d", c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE)))
}

fun durationOf(seconds: Int): String {
    val safe = seconds.coerceAtLeast(0)
    return fa(String.format(Locale.US, "%d:%02d", safe / 60, safe % 60))
}

fun sizeOf(bytes: Long): String = when {
    bytes < 1024 -> "${fa(bytes)} بایت"
    bytes < 1024 * 1024 -> "${fa(bytes / 1024)} کیلوبایت"
    bytes < 1024L * 1024 * 1024 -> fa(String.format(Locale.US, "%.1f", bytes / (1024.0 * 1024))) + " مگابایت"
    else -> fa(String.format(Locale.US, "%.2f", bytes / (1024.0 * 1024 * 1024))) + " گیگابایت"
}

fun ttlLabel(seconds: Int): String = when (seconds) {
    0 -> "بدون حذف"
    10 -> "۱۰ ثانیه"
    30 -> "۳۰ ثانیه"
    60 -> "۱ دقیقه"
    300 -> "۵ دقیقه"
    1800 -> "۳۰ دقیقه"
    3600 -> "۱ ساعت"
    else -> fa(seconds) + " ثانیه"
}

val TTL_OPTIONS = listOf(0, 10, 30, 60, 300, 1800, 3600)

private val jalaliMonths = listOf(
    "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
    "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
)

private val weekDays = listOf("یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه")

fun gregorianToJalali(gy: Int, gm: Int, gd: Int): Triple<Int, Int, Int> {
    val gDaysInMonth = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    val gy2 = gy - 1600
    val gm2 = gm - 1
    val gd2 = gd - 1
    var gDayNo = 365 * gy2 + (gy2 + 3) / 4 - (gy2 + 99) / 100 + (gy2 + 399) / 400
    for (i in 0 until gm2) gDayNo += gDaysInMonth[i]
    if (gm2 > 1 && ((gy % 4 == 0 && gy % 100 != 0) || (gy % 400 == 0))) gDayNo++
    gDayNo += gd2
    var jDayNo = gDayNo - 79
    val jNp = jDayNo / 12053
    jDayNo %= 12053
    var jy = 979 + 33 * jNp + 4 * (jDayNo / 1461)
    jDayNo %= 1461
    if (jDayNo >= 366) {
        jy += (jDayNo - 1) / 365
        jDayNo = (jDayNo - 1) % 365
    }
    return if (jDayNo < 186) Triple(jy, 1 + jDayNo / 31, 1 + jDayNo % 31)
    else Triple(jy, 7 + (jDayNo - 186) / 30, 1 + (jDayNo - 186) % 30)
}

private fun sameDay(a: Calendar, b: Calendar) =
    a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

/** "۱۲:۳۰" today, "دیروز" yesterday, else "۱۴ مهر". For list rows. */
fun dayLabelOf(ts: Long): String {
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = ts }
    if (sameDay(now, then)) return clockOf(ts)
    val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
    if (sameDay(yesterday, then)) return "دیروز"
    val (_, jm, jd) = gregorianToJalali(then.get(Calendar.YEAR), then.get(Calendar.MONTH) + 1, then.get(Calendar.DAY_OF_MONTH))
    return "${fa(jd)} ${jalaliMonths[jm - 1]}"
}

/** Full separator label inside a chat: "امروز", "دیروز", "سه‌شنبه ۱۴ مهر ۱۴۰۴". */
fun dayHeaderOf(ts: Long): String {
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = ts }
    if (sameDay(now, then)) return "امروز"
    val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
    if (sameDay(yesterday, then)) return "دیروز"
    val (jy, jm, jd) = gregorianToJalali(then.get(Calendar.YEAR), then.get(Calendar.MONTH) + 1, then.get(Calendar.DAY_OF_MONTH))
    val weekday = weekDays[then.get(Calendar.DAY_OF_WEEK) - 1]
    val year = if (now.get(Calendar.YEAR) == then.get(Calendar.YEAR)) "" else " ${fa(jy)}"
    return "$weekday ${fa(jd)} ${jalaliMonths[jm - 1]}$year"
}

/** Local calendar day as a number; only compared for equality. Cheap: no Calendar per call. */
fun dayKeyOf(ts: Long): Int {
    val offset = java.util.TimeZone.getDefault().getOffset(ts)
    return Math.floorDiv(ts + offset, 86_400_000L).toInt()
}

fun greetingOf(ts: Long = System.currentTimeMillis()): String {
    val hour = Calendar.getInstance().apply { timeInMillis = ts }.get(Calendar.HOUR_OF_DAY)
    return when (hour) {
        in 5..11 -> "صبح بخیر"
        in 12..16 -> "ظهر بخیر"
        in 17..20 -> "عصر بخیر"
        else -> "شب بخیر"
    }
}

fun relativeOf(ts: Long): String {
    val diff = System.currentTimeMillis() - ts
    return when {
        diff < 60_000 -> "همین حالا"
        diff < 3_600_000 -> "${fa((diff / 60_000).toInt())} دقیقه پیش"
        diff < 86_400_000 -> "${fa((diff / 3_600_000).toInt())} ساعت پیش"
        else -> dayLabelOf(ts)
    }
}
