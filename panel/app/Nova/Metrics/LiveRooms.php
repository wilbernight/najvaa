<?php

namespace App\Nova\Metrics;

use App\Models\Metric;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Value;
use Laravel\Nova\Metrics\ValueResult;

class LiveRooms extends Value
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'اتاق‌های فعال';
    }

    public function calculate(NovaRequest $request): ValueResult
    {
        $latest = Metric::query()->latest('created_at')->first();
        $before = Metric::query()->where('created_at', '<=', now()->subDay())->latest('created_at')->first();

        return $this->result((int) $latest?->live_rooms)
            ->previous($before ? (int) $before->live_rooms : null)
            ->allowZeroResult();
    }

    public function ranges(): array
    {
        return [];
    }

    public function uriKey(): string
    {
        return 'live-rooms';
    }

    public function helpText(): string
    {
        return 'اتاق‌هایی که دست‌کم یک دستگاه داخلشان است.';
    }
}
