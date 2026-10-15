<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Laravel\Nova\Actions\Actionable;

/** A chat room as the relay reports it: sizes, counts and times only. */
class Room extends Model
{
    use Actionable;

    protected $table = 'najva_rooms';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'stored' => 'boolean',
            'remote_created_at' => 'datetime',
            'last_activity_at' => 'datetime',
        ];
    }

    /** A short, non-reversible label; the full id is never shown. */
    public function getShortIdAttribute(): string
    {
        return substr($this->room_id, 0, 8);
    }
}
