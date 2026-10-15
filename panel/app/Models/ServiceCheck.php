<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ServiceCheck extends Model
{
    protected $table = 'najva_service_checks';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['checked_at' => 'datetime'];
    }

    public static function report(string $key, string $name, string $status, ?string $detail = null): void
    {
        static::query()->updateOrCreate(
            ['key' => $key],
            ['name' => $name, 'status' => $status, 'detail' => $detail ? mb_substr($detail, 0, 250) : null, 'checked_at' => now()]
        );
    }
}
