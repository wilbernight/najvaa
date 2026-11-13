<?php

namespace App\Console\Commands;

use App\Models\AbuseReport;
use App\Models\AdminLog;
use App\Models\DisclosureExport;
use App\Models\Metric;
use Illuminate\Support\Facades\Storage;
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
                $flags = $r['flags'] ?? [];
                Room::query()->updateOrCreate(['room_id' => $r['id']], [
                    'bytes' => $r['bytes'], 'items' => $r['items'], 'files' => $r['files'],
                    'online' => $r['online'], 'stored' => $r['stored'],
                    'remote_created_at' => $ts($r['created']), 'last_activity_at' => $ts($r['lastActivity']),
                    'hold' => ! empty($flags['hold']), 'suspended' => ! empty($flags['suspend']),
                    'watch_until' => ! empty($flags['watch']) ? $ts($flags['watch']['until'] ?? null) : null,
                    'held_items' => (int) ($r['held'] ?? 0), 'flags' => $flags ?: null,
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

        $this->pullReports($relay);
        $this->purgeExports();

        return self::SUCCESS;
    }

    /** Copies new abuse reports into the panel (encrypted), then drops them from the relay. */
    private function pullReports(Relay $relay): void
    {
        try {
            $list = $relay->reports();
        } catch (Throwable) {
            return;
        }
        $done = [];
        foreach ($list as $r) {
            if (! is_string($r['id'] ?? null) || ! preg_match('/^[A-Za-z0-9_-]{8,20}$/', $r['id'])) {
                continue;
            }
            AbuseReport::query()->firstOrCreate(['remote_id' => $r['id']], [
                'room_id' => (string) ($r['room'] ?? ''), 'code' => (string) ($r['code'] ?? ''),
                'reason' => array_key_exists($r['reason'] ?? '', AbuseReport::REASONS) ? $r['reason'] : 'other',
                'body' => (string) ($r['text'] ?? ''), 'contact' => (string) ($r['contact'] ?? ''),
                'received_at' => Carbon::createFromTimestampMs((int) ($r['ts'] ?? 0) ?: now()->getTimestampMs()),
            ]);
            $done[] = $r['id'];
        }
        if ($done) {
            try {
                $relay->ackReports($done);
            } catch (Throwable) {
                // collected again next minute; firstOrCreate keeps it single
            }
        }
    }

    /** Disclosure packages are deleted once their time is up. */
    private function purgeExports(): void
    {
        DisclosureExport::query()->whereNull('purged_at')->whereNotNull('file')->where('expires_at', '<', now())
            ->each(function (DisclosureExport $x) {
                Storage::disk('local')->delete($x->file);
                $x->update(['purged_at' => now()]);
                AdminLog::record('export.purged', (string) $x->id, ['sha256' => $x->sha256], null, 'system');
            });
    }
}
