<?php

namespace App\Nova\Metrics;

use App\Models\Metric;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Trend;
use Laravel\Nova\Metrics\TrendResult;

class StorageTrend extends Trend
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'روند حجم ذخیره (مگابایت)';
    }

    public function calculate(NovaRequest $request): TrendResult
    {
        $days = (int) $request->range ?: 7;
        $hourly = $days <= 1;
        $fmt = $hourly ? 'H:00' : 'm/d';
        $start = $hourly ? now()->subDay()->startOfHour() : now()->subDays($days - 1)->startOfDay();

        $buckets = [];
        for ($t = $start->copy(); $t <= now(); $hourly ? $t->addHour() : $t->addDay()) {
            $buckets[$t->format($fmt)] = null;
        }

        Metric::query()->where('created_at', '>=', $start)->orderBy('created_at')
            ->get(['total_bytes', 'created_at'])
            ->groupBy(fn ($m) => $m->created_at->format($fmt))
            ->each(function ($rows, $key) use (&$buckets) {
                $buckets[$key] = round($rows->avg('total_bytes') / 1048576, 1);
            });

        $last = 0;
        foreach ($buckets as $k => $v) {   // carry the last value over gaps (e.g. relay restarts)
            $buckets[$k] = $last = $v ?? $last;
        }

        return $this->result($last)->trend($buckets)->suffix('MB')->withoutSuffixInflection();
    }

    public function ranges(): array
    {
        return [1 => '۲۴ ساعت', 7 => '۷ روز', 30 => '۳۰ روز', 90 => '۹۰ روز'];
    }

    public function uriKey(): string
    {
        return 'storage-trend';
    }
}
