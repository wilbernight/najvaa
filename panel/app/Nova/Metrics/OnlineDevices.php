<?php

namespace App\Nova\Metrics;

use App\Models\Metric;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Value;
use Laravel\Nova\Metrics\ValueResult;

class OnlineDevices extends Value
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'دستگاه‌های آنلاین';
    }

    public function calculate(NovaRequest $request): ValueResult
    {
        $latest = Metric::query()->latest('created_at')->first();
        $before = Metric::query()->where('created_at', '<=', now()->subDay())->latest('created_at')->first();

        return $this->result((int) $latest?->devices)
            ->previous($before ? (int) $before->devices : null)
            ->allowZeroResult();
    }

    public function ranges(): array
    {
        return [];
    }

    public function uriKey(): string
    {
        return 'online-devices';
    }

    public function helpText(): string
    {
        return 'دستگاه‌هایی که همین الان به چت وصل‌اند (مقایسه با ۲۴ ساعت پیش).';
    }
}
