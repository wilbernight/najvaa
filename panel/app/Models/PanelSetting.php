<?php

namespace App\Models;

use App\Services\Relay;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * The chat's adjustable settings. The relay is the source of truth: saving
 * here pushes to the relay first and only keeps the change if it accepted it.
 */
class PanelSetting extends Model
{
    protected $table = 'najva_settings';

    protected $guarded = [];

    public static bool $syncing = false; // set while mirroring the relay's own values

    protected function casts(): array
    {
        return ['gif' => 'boolean', 'preview' => 'boolean', 'calls' => 'boolean', 'new_rooms' => 'boolean'];
    }

    public static function current(): self
    {
        return static::query()->firstOrCreate(['id' => 1]);
    }

    protected static function booted(): void
    {
        static::updating(function (self $s) {
            if (static::$syncing) {
                return;
            }
            try {
                app(Relay::class)->saveSettings([
                    'capGB' => (int) $s->cap_gb,
                    'maxDays' => (int) $s->max_days,
                    'features' => [
                        'gif' => $s->gif, 'preview' => $s->preview,
                        'calls' => $s->calls, 'newRooms' => $s->new_rooms,
                    ],
                ]);
            } catch (Throwable) {
                throw ValidationException::withMessages(['cap_gb' => 'سرویس چت در دسترس نیست؛ تنظیمات ذخیره نشد.']);
            }
            AdminLog::record('settings.updated', 'najva', $s->getDirty());
        });
    }
}
