<?php

namespace App\Nova\Metrics;

use App\Models\Room;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Partition;
use Laravel\Nova\Metrics\PartitionResult;

class RoomsBySize extends Partition
{
    public $refreshWhenActionsRun = true;

    public function name(): string
    {
        return 'اتاق‌ها بر اساس حجم';
    }

    public function calculate(NovaRequest $request): PartitionResult
    {
        $mb = 1048576;
        $buckets = ['زیر ۱ مگ' => 0, '۱ تا ۱۰۰ مگ' => 0, '۱۰۰ مگ تا ۱ گیگ' => 0, 'بیش از ۱ گیگ' => 0];
        foreach (Room::query()->where('stored', true)->pluck('bytes') as $b) {
            $key = match (true) {
                $b < $mb => 'زیر ۱ مگ',
                $b < 100 * $mb => '۱ تا ۱۰۰ مگ',
                $b < 1024 * $mb => '۱۰۰ مگ تا ۱ گیگ',
                default => 'بیش از ۱ گیگ',
            };
            $buckets[$key]++;
        }

        return $this->result(array_filter($buckets));
    }

    public function uriKey(): string
    {
        return 'rooms-by-size';
    }
}
