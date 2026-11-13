<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** A report sent through the chat's public report form. */
class AbuseReport extends Model
{
    protected $guarded = [];

    public const REASONS = [
        'csam' => 'سوءاستفاده از کودکان',
        'terror' => 'تروریسم / خشونت',
        'threat' => 'تهدید / اخاذی',
        'fraud' => 'کلاهبرداری',
        'abuse' => 'آزار و مزاحمت',
        'spam' => 'هرزنامه',
        'other' => 'سایر',
    ];

    public const STATUSES = ['new' => 'جدید', 'reviewing' => 'در حال بررسی', 'actioned' => 'اقدام شد', 'dismissed' => 'رد شد'];

    /** Reasons that go to the top of the queue. */
    public const SEVERE = ['csam', 'terror', 'threat'];

    protected function casts(): array
    {
        return [
            'body' => 'encrypted',
            'contact' => 'encrypted',
            'resolution' => 'encrypted',
            'received_at' => 'datetime',
            'handled_at' => 'datetime',
        ];
    }

    public function legalCase(): BelongsTo
    {
        return $this->belongsTo(LegalCase::class);
    }

    public function handler(): BelongsTo
    {
        return $this->belongsTo(User::class, 'handled_by');
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class, 'room_id', 'room_id');
    }

    public function severe(): bool
    {
        return in_array($this->reason, self::SEVERE, true);
    }
}
