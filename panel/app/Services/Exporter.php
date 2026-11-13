<?php

namespace App\Services;

use App\Models\DisclosureExport;
use App\Models\LegalCase;
use App\Models\Room;
use App\Support\Jalali;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use ZipArchive;

/**
 * Builds a disclosure package for one room of a legal case.
 *
 * What it can contain is what the server has: times, sizes, ids and timers
 * of the stored items, the room's flags, the connection log of a watched
 * room, and (optionally) the stored files themselves, which are end-to-end
 * ciphertext that nobody can open without the room password.
 *
 * Chain of custody: every file is listed in SHA256SUMS, SIGNATURE is an HMAC
 * of that list under the panel's key (checked by `najva:verify-export`), the
 * archive is AES-256 encrypted with a one-time password shown only to the
 * admin who made it, and the archive's own SHA-256 is kept in the panel.
 */
class Exporter
{
    public function __construct(private Relay $relay) {}

    /** @return array{0: DisclosureExport, 1: string} the export and its one-time password */
    public function build(LegalCase $case, string $roomId, bool $withContent): array
    {
        if (! class_exists(ZipArchive::class)) {
            throw new RuntimeException('PHP zip extension is missing.');
        }
        $meta = $this->relay->roomMeta($roomId);
        if (! $meta) {
            throw new RuntimeException('room-not-found');
        }
        $maxBytes = (int) config('najva.export_max_mb', 2048) * 1048576;
        if ($withContent && ($meta['bytes'] ?? 0) > $maxBytes) {
            throw new RuntimeException('too-big');
        }

        $room = Room::query()->where('room_id', $roomId)->first();
        $code = $room?->code;
        $user = auth()->user();
        $export = DisclosureExport::query()->create([
            'legal_case_id' => $case->id, 'room_id' => $roomId, 'code' => $code,
            'with_content' => $withContent, 'created_by' => $user?->id,
            'expires_at' => now()->addDays((int) config('najva.export_days', 7)),
        ]);

        $dir = 'exports';
        Storage::disk('local')->makeDirectory($dir);
        $name = sprintf('%s/%d-%s-%s.zip', $dir, $export->id, $case->ref, $code ?? substr($roomId, 0, 8));
        $path = Storage::disk('local')->path($name);
        $password = Str::password(24, symbols: false);

        $files = [];   // archive path => contents
        $files['manifest.json'] = json_encode($this->manifest($export, $case, $meta, $code, $user?->email), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $files['entries.csv'] = $this->entriesCsv($meta);
        $files['connections.csv'] = $this->connCsv($meta);
        $files['README-fa.txt'] = $this->readme($case, $code, $withContent);

        $zip = new ZipArchive;
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new RuntimeException('cannot-create');
        }
        $sums = [];
        $add = function (string $p, string $data) use ($zip, &$sums, $password) {
            $zip->addFromString($p, $data);
            $this->encrypt($zip, $p, $password);
            $sums[] = hash('sha256', $data).'  '.$p;
        };
        foreach ($files as $p => $data) {
            $add($p, $data);
        }
        $items = count($meta['entries'] ?? []) + count($meta['held'] ?? []);
        if ($withContent) {
            foreach ([['entries', 'log', 'blob'], ['held', 'held/log', 'held/blob']] as [$set, $logDir, $blobDir]) {
                foreach ($meta[$set] ?? [] as $e) {
                    $add("content/{$logDir}/{$e['name']}", $this->relay->roomFile($roomId, "{$logDir}/{$e['name']}"));
                    for ($i = 0; $e['blob'] && $i < ($e['chunks'] ?? 0); $i++) {
                        $add("content/{$blobDir}/{$e['id']}/{$i}", $this->relay->roomFile($roomId, "{$blobDir}/{$e['id']}/{$i}"));
                    }
                }
            }
        }
        $sumsText = implode("\n", $sums)."\n";
        $zip->addFromString('SHA256SUMS', $sumsText);
        $this->encrypt($zip, 'SHA256SUMS', $password);
        $sig = self::sign($export->id, $sumsText);
        $zip->addFromString('SIGNATURE', "najva-disclosure/1\nexport: {$export->id}\nhmac-sha256: {$sig}\n");
        $this->encrypt($zip, 'SIGNATURE', $password);
        $zip->close();
        @chmod($path, 0640);

        $export->update([
            'file' => $name, 'bytes' => filesize($path), 'sha256' => hash_file('sha256', $path),
            'signature' => $sig, 'items' => $items,
        ]);

        return [$export, $password];
    }

    public static function sign(int $exportId, string $sums): string
    {
        return hash_hmac('sha256', "{$exportId}\n{$sums}", 'najva-export|'.config('app.key'));
    }

    private function encrypt(ZipArchive $zip, string $name, string $password): void
    {
        if (defined(ZipArchive::class.'::EM_AES_256')) {
            $zip->setEncryptionName($name, ZipArchive::EM_AES_256, $password);
        }
    }

    private function iso(?int $ms): ?string
    {
        return $ms ? Carbon::createFromTimestampMs($ms)->utc()->toIso8601ZuluString() : null;
    }

    private function manifest(DisclosureExport $x, LegalCase $case, array $meta, ?string $code, ?string $by): array
    {
        $entries = $meta['entries'] ?? [];
        $held = $meta['held'] ?? [];

        return [
            'format' => 'najva-disclosure/1',
            'export_id' => $x->id,
            'exported_at' => now()->utc()->toIso8601ZuluString(),
            'exported_by' => $by,
            'case' => ['ref' => $case->ref, 'kind' => $case->kind, 'authority_ref' => $case->authority_ref],
            'room' => [
                'code' => $code, 'id' => $meta['id'],
                'created_at' => $this->iso($meta['created'] ?? null),
                'store_registered_at' => $this->iso($meta['registered'] ?? null),
                'devices_online_now' => count($meta['live'] ?? []),
                'stored_bytes' => $meta['bytes'] ?? 0,
            ],
            'flags' => $meta['flags'] ?? [],
            'counts' => [
                'items' => count($entries), 'files' => count(array_filter($entries, fn ($e) => $e['blob'])),
                'held_items' => count($held), 'connection_events' => count($meta['conn'] ?? []),
            ],
            'first_item_at' => $this->iso($entries[0]['ts'] ?? null),
            'last_item_at' => $this->iso($entries ? end($entries)['ts'] : null),
            'content_included' => (bool) $x->with_content,
            'notes' => [
                'All message content, files and calls are end-to-end encrypted on the users\' devices (X25519 + AES-256-GCM). The server never has the room password or any key, so neither the operator nor this package can reveal content.',
                'The service has no accounts: no names, phone numbers or e-mail addresses exist.',
                'Connection records exist only for the period in which this room was under a case-bound watch (see flags.watch).',
                'All times are UTC.',
            ],
        ];
    }

    private function csv(array $rows): string
    {
        $h = fopen('php://temp', 'r+');
        fwrite($h, "\xEF\xBB\xBF");   // BOM so spreadsheet apps read UTF-8
        foreach ($rows as $r) {
            fputcsv($h, $r, ',', '"', '');
        }
        rewind($h);

        return stream_get_contents($h);
    }

    private function entriesCsv(array $meta): string
    {
        $rows = [['state', 'stored_at_utc', 'stored_at_jalali', 'item_id', 'type', 'bytes', 'chunks', 'self_destruct_at_utc', 'retired_at_utc']];
        foreach ([['live', $meta['entries'] ?? []], ['held', $meta['held'] ?? []]] as [$state, $list]) {
            foreach ($list as $e) {
                $rows[] = [$state, $this->iso($e['ts']), Jalali::latin(Jalali::format($e['ts'], 'Y/m/d H:i:s')), $e['id'],
                    $e['blob'] ? 'file' : 'message', $e['size'], $e['chunks'] ?? 0, $this->iso($e['exp'] ?: null), $this->iso($e['retired'] ?? null)];
            }
        }

        return $this->csv($rows);
    }

    private function connCsv(array $meta): string
    {
        $rows = [['time_utc', 'time_jalali', 'event', 'ip', 'country', 'device_id', 'user_agent', 'duration_s', 'item', 'case']];
        foreach ($meta['conn'] ?? [] as $c) {
            $rows[] = [$this->iso($c['ts'] ?? null), Jalali::latin(Jalali::format($c['ts'] ?? null, 'Y/m/d H:i:s')), $c['ev'] ?? '', $c['ip'] ?? '',
                $c['cc'] ?? '', $c['cid'] ?? '', $c['ua'] ?? '', $c['secs'] ?? '', $c['item'] ?? '', $c['case'] ?? ''];
        }

        return $this->csv($rows);
    }

    private function readme(LegalCase $case, ?string $code, bool $withContent): string
    {
        $c = $code ?? '—';

        return <<<TXT
        بسته‌ی افشای اطلاعات نجوا
        پرونده: {$case->ref}
        اتاق: {$c}

        محتوای پیام‌ها، فایل‌ها و تماس‌ها در نجوا روی دستگاه کاربران به‌صورت سرتاسری رمز می‌شود
        و سرور هیچ کلید یا رمزی ندارد؛ بنابراین نه اپراتور و نه این بسته نمی‌تواند محتوا را آشکار کند.
        نجوا حساب کاربری، نام، شماره تلفن یا ایمیل ندارد.

        manifest.json    مشخصات اتاق، پرچم‌های حقوقی و شمارش‌ها
        entries.csv      زمان، شناسه، نوع و حجم هر مورد ذخیره‌شده (live = موجود، held = حفظ‌شده پس از حذف)
        connections.csv  ثبت اتصال‌ها (فقط در بازه‌ای که اتاق تحت پایش پرونده بوده)
        TXT
        .($withContent ? "\ncontent/         فایل‌های ذخیره‌شده به همان شکل رمزشده (قابل خواندن نیستند)" : '')
        .<<<TXT

        SHA256SUMS       چکیده‌ی همه‌ی فایل‌ها
        SIGNATURE        امضای HMAC فهرست چکیده‌ها با کلید پنل (قابل بررسی با najva:verify-export)

        همه‌ی زمان‌های فایل‌های CSV به UTC و ستون jalali به وقت تهران است.
        TXT;
    }
}
