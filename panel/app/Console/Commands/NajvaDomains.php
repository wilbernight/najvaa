<?php

namespace App\Console\Commands;

use App\Models\Domain;
use App\Services\Cloudflare;
use Illuminate\Console\Command;

class NajvaDomains extends Command
{
    protected $signature = 'najva:domains';

    protected $description = 'Refresh the Cloudflare zones, their SSL settings and AAAA records';

    public function handle(Cloudflare $cf): int
    {
        if (! $cf->configured()) {
            return self::SUCCESS;
        }

        $ddns = json_decode((string) @file_get_contents(config('najva.ddns_status')), true);
        $ip = $ddns['ip'] ?? null;

        $seen = [];
        foreach ($cf->zones() as $z) {
            $seen[] = $z['id'];
            $aaaa = collect($cf->records($z['id'], 'AAAA'));
            Domain::query()->updateOrCreate(['zone_id' => $z['id']], [
                'name' => $z['name'],
                'status' => $z['status'],
                'ssl_mode' => $cf->setting($z['id'], 'ssl'),
                'always_https' => $cf->setting($z['id'], 'always_use_https'),
                'min_tls' => $cf->setting($z['id'], 'min_tls_version'),
                'aaaa_records' => $aaaa->count(),
                'aaaa_proxied' => $aaaa->where('proxied', true)->count(),
                // records still pointing at an address that is not the server's current one
                'aaaa_stale' => $ip ? $aaaa->where('content', '!=', $ip)->count() : 0,
                'synced_at' => now(),
            ]);
        }
        Domain::query()->whereNotIn('zone_id', $seen)->delete();

        return self::SUCCESS;
    }
}
