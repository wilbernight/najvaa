<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** A signed disclosure package built for a case (see App\Services\Exporter). */
class DisclosureExport extends Model
{
    protected $guarded = [];

    protected function casts(): array
    {
        return ['with_content' => 'boolean', 'expires_at' => 'datetime', 'purged_at' => 'datetime'];
    }

    public function legalCase(): BelongsTo
    {
        return $this->belongsTo(LegalCase::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function available(): bool
    {
        return ! $this->purged_at && $this->file && (! $this->expires_at || $this->expires_at->isFuture());
    }
}
