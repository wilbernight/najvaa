<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class IpBlock extends Model
{
    protected $guarded = [];

    protected function casts(): array
    {
        return ['until' => 'datetime'];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** The list the relay enforces: only blocks that have not run out. */
    public static function forRelay(): array
    {
        return static::query()
            ->where(fn ($q) => $q->whereNull('until')->orWhere('until', '>', now()))
            ->get()
            ->map(fn (self $b) => ['cidr' => $b->cidr, 'until' => $b->until?->getTimestampMs() ?? 0, 'note' => (string) $b->note])
            ->all();
    }
}
