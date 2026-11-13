<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A request from a court, prosecutor or police body, and how it was handled. */
class LegalCase extends Model
{
    protected $guarded = [];

    public const KINDS = [
        'preservation' => 'حفظ داده (توقیف)',
        'disclosure' => 'درخواست اطلاعات',
        'takedown' => 'حذف محتوا / اتاق',
        'suspension' => 'مسدودسازی اتاق',
        'monitoring' => 'ثبت اتصال‌ها (پایش)',
        'info' => 'استعلام عمومی',
    ];

    public const STATUSES = [
        'received' => 'دریافت شد',
        'review' => 'بررسی حقوقی',
        'in_progress' => 'در حال اجرا',
        'fulfilled' => 'انجام شد',
        'partial' => 'انجام بخشی',
        'rejected' => 'رد شد',
        'closed' => 'بسته شد',
    ];

    public const OPEN = ['received', 'review', 'in_progress'];

    public const PRIORITIES = ['low' => 'کم', 'normal' => 'عادی', 'high' => 'بالا', 'urgent' => 'فوری'];

    protected function casts(): array
    {
        return [
            'authority' => 'encrypted',
            'authority_ref' => 'encrypted',
            'subject' => 'encrypted',
            'description' => 'encrypted',
            'received_on' => 'date',
            'due_on' => 'date',
            'closed_at' => 'datetime',
        ];
    }

    public static function nextRef(): string
    {
        $year = \App\Support\Jalali::year(now());
        $n = static::query()->where('ref', 'like', "NJ-{$year}-%")->count() + 1;
        do {
            $ref = sprintf('NJ-%d-%04d', $year, $n++);
        } while (static::query()->where('ref', $ref)->exists());

        return $ref;
    }

    public function rooms(): HasMany
    {
        return $this->hasMany(LegalCaseRoom::class);
    }

    public function events(): HasMany
    {
        return $this->hasMany(CaseEvent::class)->orderBy('created_at')->orderBy('id');
    }

    public function exports(): HasMany
    {
        return $this->hasMany(DisclosureExport::class)->latest();
    }

    public function assignee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assignee_id');
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function isOpen(): bool
    {
        return in_array($this->status, self::OPEN, true);
    }

    public function overdue(): bool
    {
        return $this->isOpen() && $this->due_on && $this->due_on->endOfDay()->isPast();
    }

    public function log(string $kind, ?string $body = null, array $meta = []): CaseEvent
    {
        return $this->events()->create([
            'user_id' => auth()->id(),
            'kind' => $kind,
            'body' => $body,
            'meta' => $meta ?: null,
            'created_at' => now(),
        ]);
    }
}
