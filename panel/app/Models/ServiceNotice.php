<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ServiceNotice extends Model
{
    protected $guarded = [];

    public const LEVELS = ['info' => 'اطلاع‌رسانی', 'warn' => 'هشدار', 'alert' => 'فوری'];

    protected function casts(): array
    {
        return ['until' => 'datetime', 'cleared_at' => 'datetime'];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function active(): bool
    {
        return ! $this->cleared_at && (! $this->until || $this->until->isFuture());
    }
}
