<?php

namespace App\Support;

/**
 * Server-side SVG paths for the panel's charts (no chart library, nothing
 * inline: the CSP allows only the panel's own script and stylesheet).
 * Curves use monotone cubic interpolation, so a line never overshoots the data.
 * panel.js maps hover positions with the same geometry (W, H, TOP, BOTTOM).
 */
final class Chart
{
    public const W = 1000;
    public const H = 220;
    public const TOP = 14;
    public const BOTTOM = 6;

    /** @return array{0:string,1:string} [line path, area path] */
    public static function paths(array $values, ?float $max = null, int $w = self::W, int $h = self::H, int $top = self::TOP, int $bottom = self::BOTTOM): array
    {
        $values = array_values(array_map('floatval', $values));
        $n = count($values);
        if ($n < 2) {
            return ['', ''];
        }
        $max = $max ?: (max($values) ?: 1);
        $pts = [];
        foreach ($values as $i => $v) {
            $pts[] = [$i / ($n - 1) * $w, $top + (1 - min($v, $max) / $max) * ($h - $top - $bottom)];
        }

        // Fritsch–Carlson tangents.
        $d = $m = [];
        for ($i = 0; $i < $n - 1; $i++) {
            $dx = $pts[$i + 1][0] - $pts[$i][0];
            $d[$i] = $dx ? ($pts[$i + 1][1] - $pts[$i][1]) / $dx : 0;
        }
        $m[0] = $d[0];
        $m[$n - 1] = $d[$n - 2];
        for ($i = 1; $i < $n - 1; $i++) {
            $m[$i] = ($d[$i - 1] * $d[$i] <= 0) ? 0 : ($d[$i - 1] + $d[$i]) / 2;
        }
        for ($i = 0; $i < $n - 1; $i++) {
            if ($d[$i] == 0) {
                $m[$i] = $m[$i + 1] = 0;

                continue;
            }
            $a = $m[$i] / $d[$i];
            $b = $m[$i + 1] / $d[$i];
            $s = $a * $a + $b * $b;
            if ($s > 9) {
                $t = 3 / sqrt($s);
                $m[$i] = $t * $a * $d[$i];
                $m[$i + 1] = $t * $b * $d[$i];
            }
        }

        $f = fn ($x) => rtrim(rtrim(number_format($x, 2, '.', ''), '0'), '.');
        $line = 'M'.$f($pts[0][0]).','.$f($pts[0][1]);
        for ($i = 0; $i < $n - 1; $i++) {
            $dx = ($pts[$i + 1][0] - $pts[$i][0]) / 3;
            $line .= ' C'.$f($pts[$i][0] + $dx).','.$f($pts[$i][1] + $m[$i] * $dx)
                .' '.$f($pts[$i + 1][0] - $dx).','.$f($pts[$i + 1][1] - $m[$i + 1] * $dx)
                .' '.$f($pts[$i + 1][0]).','.$f($pts[$i + 1][1]);
        }
        $area = $line.' L'.$f($w).','.$h.' L0,'.$h.' Z';

        return [$line, $area];
    }

    /** A "nice" axis maximum (1, 2, 2.5, 5 × 10^k) at or above $v. */
    public static function niceMax(float $v): float
    {
        if ($v <= 0) {
            return 4;
        }
        $p = 10 ** floor(log10($v));
        foreach ([1, 2, 2.5, 5, 10] as $s) {
            if ($s * $p >= $v) {
                return $s * $p;
            }
        }

        return 10 * $p;
    }

    /** Stroke-dasharray for a ring of radius $r filled to $pct. */
    public static function ring(float $pct, float $r = 48): string
    {
        $c = 2 * M_PI * $r;
        $on = max(0, min(100, $pct)) / 100 * $c;

        return round($on, 2).' '.round($c, 2);
    }
}
