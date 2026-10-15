<?php

namespace App\Nova\Metrics;

use App\Models\Metric;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Value;
use Laravel\Nova\Metrics\ValueResult;

class StoredRooms extends Value
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'اتاق‌های دارای تاریخچه';
    }

    public function calculate(NovaRequest $request): ValueResult
    {
        $latest = Metric::query()->latest('created_at')->first();
        $before = Metric::query()->where('created_at', '<=', now()->subDay())->latest('created_at')->first();

        return $this->result((int) $latest?->stored_rooms)
            ->previous($before ? (int) $before->stored_rooms : null)
            ->allowZeroResult();
    }

    public function ranges(): array
    {
        return [];
    }

    public function uriKey(): string
    {
        return 'stored-rooms';
    }

    public function helpText(): string
    {
        return 'اتاق‌هایی که محتوای رمزشده روی سرور دارند.';
    }
}
