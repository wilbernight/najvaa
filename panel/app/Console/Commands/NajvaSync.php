<?php

namespace App\Console\Commands;

use App\Models\Metric;
use App\Models\PanelSetting;
use App\Models\Room;
use App\Models\ServiceCheck;
use App\Services\Relay;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Throwable;

class NajvaSync extends Command
{
    protected $signature = 'najva:sync';

    protected $description = 'Mirror the chat relay\'s room sizes, counts and settings into the panel';

    public function handle(Relay $relay): int
    {
        try {
            $stats = $relay->stats();
        } catch (Throwable $e) {
            ServiceCheck::report('relay', 'سرویس چت (رله)', 'down', 'پاسخ نمی‌دهد: '.class_basename($e));

            return self::FAILURE;
        }

        $ts = fn ($ms) => $ms ? Carbon::createFromTimestampMs($ms) : null;

        DB::transaction(function () use ($stats, $ts) {
            $seen = [];
            foreach ($stats['rooms'] ?? [] as $r) {
                $seen[] = $r['id'];
                Room::query()->updateOrCreate(['room_id' => $r['id']], [
                    'bytes' => $r['bytes'], 'items' => $r['items'], 'files' => $r['files'],
                    'online' => $r['online'], 'stored' => $r['stored'],
                    'remote_created_at' => $ts($r['created']), 'last_activity_at' => $ts($r['lastActivity']),
                ]);
            }
            Room::query()->whereNotIn('room_id', $seen)->delete();

            $s = $stats['settings'];
            PanelSetting::$syncing = true;
            try {
                PanelSetting::current()->update([
                    'cap_gb' => $s['capGB'], 'max_days' => $s['maxDays'],
                    'gif' => $s['features']['gif'], 'preview' => $s['features']['preview'],
                    'calls' => $s['features']['calls'], 'new_rooms' => $s['features']['newRooms'],
                ]);
            } finally {
                PanelSetting::$syncing = false;
            }

            Metric::query()->create([
                'total_bytes' => $stats['store']['totalBytes'], 'cap_bytes' => $stats['store']['capBytes'],
                'stored_rooms' => collect($stats['rooms'])->where('stored', true)->count(),
                'live_rooms' => $stats['live']['rooms'], 'devices' => $stats['live']['devices'],
                'relay_rss' => $stats['rss'], 'created_at' => now(),
            ]);
            Metric::query()->where('created_at', '<', now()->subDays(config('najva.metrics_days')))->delete();
        });

        ServiceCheck::report('relay', 'سرویس چت (رله)', 'ok',
            'روشن از '.round($stats['uptime'] / 3600, 1).' ساعت پیش · '.round($stats['rss'] / 1048576).' مگ حافظه');

        return self::SUCCESS;
    }
}
