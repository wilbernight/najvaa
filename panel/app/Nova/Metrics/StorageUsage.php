<?php

namespace App\Nova\Metrics;

use App\Models\Metric;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Progress;
use Laravel\Nova\Metrics\ProgressResult;

class StorageUsage extends Progress
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'فضای مصرف‌شده (گیگابایت)';
    }

    public function calculate(NovaRequest $request): ProgressResult
    {
        $m = Metric::query()->latest('created_at')->first();
        $gb = fn ($b) => round(((int) $b) / 1073741824, 2);

        return $this->result($gb($m?->total_bytes), max($gb($m?->cap_bytes), 0.01))->avoid();
    }

    public function uriKey(): string
    {
        return 'storage-usage';
    }

    public function helpText(): string
    {
        return 'حجم محتوای رمزشده روی سرور نسبت به سقف. با رسیدن به سقف، قدیمی‌ترین محتوا پاک می‌شود.';
    }
}
