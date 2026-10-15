<?php

namespace App\Console\Commands;

use App\Models\Metric;
use App\Models\ServiceCheck;
use App\Services\Cloudflare;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;
use Throwable;

class NajvaHealth extends Command
{
    protected $signature = 'najva:health';

    protected $description = 'Check the chat site, disk, storage, certificate, DDNS and Cloudflare token';

    public function handle(Cloudflare $cf): int
    {
        // Public chat site, through Cloudflare like a visitor.
        try {
            $r = Http::timeout(15)->get(config('najva.chat_url'));
            ServiceCheck::report('site', 'سایت چت', $r->successful() ? 'ok' : 'down',
                'HTTP '.$r->status().' · '.round(($r->handlerStats()['total_time'] ?? 0) * 1000).' ms');
        } catch (Throwable $e) {
            ServiceCheck::report('site', 'سایت چت', 'down', class_basename($e));
        }

        // Disk of the server.
        $free = @disk_free_space('/');
        $total = @disk_total_space('/');
        if ($free && $total) {
            $pct = round(100 * (1 - $free / $total));
            ServiceCheck::report('disk', 'دیسک سرور', $pct >= 90 ? 'down' : ($pct >= 80 ? 'warn' : 'ok'),
                "{$pct}% پر · ".round($free / 1073741824).' گیگ خالی');
        }

        // Encrypted chat storage against its cap.
        if ($m = Metric::query()->latest('id')->first()) {
            $pct = $m->cap_bytes ? round(100 * $m->total_bytes / $m->cap_bytes) : 0;
            ServiceCheck::report('store', 'فضای ذخیره‌ی چت', $pct >= 95 ? 'warn' : 'ok',
                "{$pct}% از سقف · ".round($m->total_bytes / 1048576).' مگ');
        }

        // Origin certificate nginx actually serves for the chat site.
        $cert = $this->originCert();
        if ($cert) {
            $days = (int) floor(($cert['validTo_time_t'] - time()) / 86400);
            ServiceCheck::report('cert', 'گواهی سرور', $days < 30 ? 'warn' : 'ok', "{$days} روز اعتبار باقی است");
        } else {
            ServiceCheck::report('cert', 'گواهی سرور', 'warn', 'خوانده نشد');
        }

        // DDNS timer that keeps Cloudflare on the server's IPv6.
        $d = json_decode((string) @file_get_contents(config('najva.ddns_status')), true);
        if (is_array($d)) {
            $age = time() - (int) ($d['last_check'] ?? 0);
            $ok = ($d['ok'] ?? false) && $age < 900;
            ServiceCheck::report('ddns', 'به‌روزرسانی خودکار IP', $ok ? 'ok' : 'down',
                $ok ? 'آخرین بررسی '.max(1, intdiv($age, 60)).' دقیقه پیش' : ($d['error'] ?? 'مدتی است اجرا نشده'));
        } else {
            ServiceCheck::report('ddns', 'به‌روزرسانی خودکار IP', 'warn', 'فایل وضعیت پیدا نشد');
        }

        // Cloudflare API token used by the panel and the DDNS.
        if ($cf->configured()) {
            try {
                ServiceCheck::report('cloudflare', 'توکن Cloudflare', $cf->tokenValid() ? 'ok' : 'down');
            } catch (Throwable $e) {
                ServiceCheck::report('cloudflare', 'توکن Cloudflare', 'warn', class_basename($e));
            }
        }

        return self::SUCCESS;
    }

    /** Parsed certificate from a local TLS handshake with the chat's vhost (SNI), or null. */
    private function originCert(): ?array
    {
        $host = (string) parse_url(config('najva.chat_url'), PHP_URL_HOST);
        $ctx = stream_context_create(['ssl' => [
            'capture_peer_cert' => true, 'peer_name' => $host, 'SNI_enabled' => true,
            'verify_peer' => false, 'verify_peer_name' => false,   // Cloudflare Origin CA is not a public CA
        ]]);
        $s = @stream_socket_client('ssl://'.config('najva.origin_tls'), $errno, $err, 5, STREAM_CLIENT_CONNECT, $ctx);
        if (! $s) {
            return null;
        }
        $peer = stream_context_get_params($s)['options']['ssl']['peer_certificate'] ?? null;
        fclose($s);

        return $peer ? (openssl_x509_parse($peer) ?: null) : null;
    }
}
