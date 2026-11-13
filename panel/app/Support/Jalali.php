<?php

namespace App\Support;

use DateTimeInterface;
use Illuminate\Support\Carbon;

/** Solar Hijri (Jalali) dates and Persian digits for the panel's display. */
final class Jalali
{
    private const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

    /** @return array{0:int,1:int,2:int} */
    public static function fromGregorian(int $gy, int $gm, int $gd): array
    {
        $gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        $gy2 = $gm > 2 ? $gy + 1 : $gy;
        $days = 355666 + (365 * $gy) + intdiv($gy2 + 3, 4) - intdiv($gy2 + 99, 100) + intdiv($gy2 + 399, 400) + $gd + $gdm[$gm - 1];
        $jy = -1595 + (33 * intdiv($days, 12053));
        $days %= 12053;
        $jy += 4 * intdiv($days, 1461);
        $days %= 1461;
        if ($days > 365) {
            $jy += intdiv($days - 1, 365);
            $days = ($days - 1) % 365;
        }
        $jm = $days < 186 ? 1 + intdiv($days, 31) : 7 + intdiv($days - 186, 30);
        $jd = 1 + ($days < 186 ? $days % 31 : ($days - 186) % 30);

        return [$jy, $jm, $jd];
    }

    /** @return array{0:int,1:int,2:int} */
    public static function toGregorian(int $jy, int $jm, int $jd): array
    {
        $jy += 1595;
        $days = -355668 + (365 * $jy) + (intdiv($jy, 33) * 8) + intdiv(($jy % 33) + 3, 4) + $jd + ($jm < 7 ? ($jm - 1) * 31 : (($jm - 7) * 30) + 186);
        $gy = 400 * intdiv($days, 146097);
        $days %= 146097;
        if ($days > 36524) {
            $gy += 100 * intdiv(--$days, 36524);
            $days %= 36524;
            if ($days >= 365) {
                $days++;
            }
        }
        $gy += 4 * intdiv($days, 1461);
        $days %= 1461;
        if ($days > 365) {
            $gy += intdiv($days - 1, 365);
            $days = ($days - 1) % 365;
        }
        $gd = $days + 1;
        $sal = [0, 31, (($gy % 4 === 0 && $gy % 100 !== 0) || $gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        for ($gm = 1; $gm <= 12 && $gd > $sal[$gm]; $gm++) {
            $gd -= $sal[$gm];
        }

        return [$gy, $gm, $gd];
    }

    public static function year(DateTimeInterface $d): int
    {
        return self::fromGregorian((int) $d->format('Y'), (int) $d->format('n'), (int) $d->format('j'))[0];
    }

    private static function local(DateTimeInterface|string|int|null $d): ?Carbon
    {
        if ($d === null || $d === '') {
            return null;
        }
        $c = $d instanceof DateTimeInterface ? Carbon::instance($d) : (is_int($d) ? Carbon::createFromTimestampMs($d) : Carbon::parse($d));

        return $c->setTimezone(config('najva.timezone', 'Asia/Tehran'));
    }

    /** Y/m/d, Y/m/d H:i or "d F Y" in Persian digits. */
    public static function format(DateTimeInterface|string|int|null $d, string $fmt = 'Y/m/d H:i'): string
    {
        $c = self::local($d);
        if (! $c) {
            return '—';
        }
        [$jy, $jm, $jd] = self::fromGregorian($c->year, $c->month, $c->day);
        $out = strtr($fmt, [
            'Y' => (string) $jy,
            'm' => str_pad((string) $jm, 2, '0', STR_PAD_LEFT),
            'd' => str_pad((string) $jd, 2, '0', STR_PAD_LEFT),
            'j' => (string) $jd,
            'F' => self::MONTHS[$jm - 1],
            'H' => $c->format('H'),
            'i' => $c->format('i'),
            's' => $c->format('s'),
            'l' => ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'][$c->dayOfWeek],
        ]);

        return self::digits($out);
    }

    /** "۵ دقیقه پیش" style. */
    public static function ago(DateTimeInterface|string|int|null $d): string
    {
        $c = self::local($d);
        if (! $c) {
            return '—';
        }
        $s = (int) abs(now()->diffInSeconds($c));
        $future = $c->isFuture();
        $txt = match (true) {
            $s < 60 => 'لحظاتی',
            $s < 3600 => intdiv($s, 60).' دقیقه',
            $s < 86400 => intdiv($s, 3600).' ساعت',
            $s < 86400 * 30 => intdiv($s, 86400).' روز',
            default => null,
        };
        if ($txt === null) {
            return self::format($c, 'Y/m/d');
        }

        return self::digits($txt.($future ? ' دیگر' : ' پیش'));
    }

    /** Short time for list rows: today → H:i, this week → day count, else date. */
    public static function short(DateTimeInterface|string|int|null $d): string
    {
        $c = self::local($d);
        if (! $c) {
            return '';
        }
        $now = now()->setTimezone($c->getTimezone());
        if ($c->isSameDay($now)) {
            return self::digits($c->format('H:i'));
        }

        return self::format($c, 'm/d');
    }

    /** Parses "1405/08/22" (either digit set) into a Gregorian date. */
    public static function parse(?string $s): ?Carbon
    {
        $s = trim(self::latin((string) $s));
        if (! preg_match('~^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$~', $s, $m)) {
            return null;
        }
        [$jy, $jm, $jd] = [(int) $m[1], (int) $m[2], (int) $m[3]];
        if ($jy < 1300 || $jy > 1500 || $jm < 1 || $jm > 12 || $jd < 1 || $jd > 31) {
            return null;
        }
        [$gy, $gm, $gd] = self::toGregorian($jy, $jm, $jd);

        return Carbon::create($gy, $gm, $gd, 0, 0, 0, config('najva.timezone', 'Asia/Tehran'));
    }

    public static function digits(string|int|float $s): string
    {
        return strtr((string) $s, ['0' => '۰', '1' => '۱', '2' => '۲', '3' => '۳', '4' => '۴', '5' => '۵', '6' => '۶', '7' => '۷', '8' => '۸', '9' => '۹']);
    }

    public static function latin(string $s): string
    {
        return strtr($s, ['۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
            '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9']);
    }

    public static function bytes(int|float|null $b): string
    {
        $b = (float) $b;
        foreach (['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت'] as $i => $u) {
            if ($b < 1024 ** ($i + 1) || $i === 4) {
                return self::digits(round($b / 1024 ** $i, $i ? 1 : 0)).' '.$u;
            }
        }

        return self::digits((string) $b);
    }
}
