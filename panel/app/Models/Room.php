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
            'hold' => 'boolean',
            'suspended' => 'boolean',
            'watch_until' => 'datetime',
            'flags' => 'array',
        ];
    }

    public function cases(): \Illuminate\Database\Eloquent\Relations\BelongsToMany
    {
        return $this->belongsToMany(LegalCase::class, 'legal_case_rooms', 'room_id', 'legal_case_id', 'room_id', 'id')->withTimestamps();
    }

    /** roomId = HKDF(code), the same derivation as the chat client. */
    public static function idForCode(string $code): string
    {
        return rtrim(strtr(base64_encode(hash_hkdf('sha256', 'najva/room/'.$code, 16, 'wn1/room-id', str_repeat("\0", 32))), '+/', '-_'), '=');
    }

    public function watched(): bool
    {
        return $this->watch_until !== null && $this->watch_until->isFuture();
    }

    /** Label for lists: the 7-digit code, or the id prefix until it is found. */
    public function getLabelAttribute(): string
    {
        return $this->code ?? substr($this->room_id, 0, 8);
    }

    /** A short, non-reversible label; the full id is never shown. */
    public function getShortIdAttribute(): string
    {
        return substr($this->room_id, 0, 8);
    }
}
