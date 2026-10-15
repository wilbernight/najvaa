<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Audit trail of admin activity. Never stores anything about chat users. */
class AdminLog extends Model
{
    use Prunable;

    protected $table = 'admin_logs';

    public const UPDATED_AT = null;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['detail' => 'array', 'created_at' => 'datetime'];
    }

    public function prunable(): Builder
    {
        return static::where('created_at', '<', now()->subYear());
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public static function record(string $action, ?string $target = null, array $detail = [], ?User $user = null, ?string $email = null): void
    {
        $user ??= auth()->user();
        static::query()->create([
            'user_id' => $user?->id,
            'email' => $email ?? $user?->email,
            'action' => $action,
            'target' => $target,
            'detail' => $detail ?: null,
            'ip' => request()?->ip(),
        ]);
    }
}
