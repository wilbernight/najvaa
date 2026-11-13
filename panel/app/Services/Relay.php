<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;

/**
 * Talks to the chat relay's admin API on 127.0.0.1. It can read sizes,
 * counts, times, settings and the metadata of a room, set legal flags, and
 * delete or disconnect a room. The relay never has any key, so nothing here
 * can return readable content: raw files are ciphertext.
 */
class Relay
{
    private function http(int $timeout = 15): PendingRequest
    {
        return Http::baseUrl(config('najva.relay_url'))
            ->withHeaders(['X-Admin-Secret' => (string) config('najva.relay_secret')])
            ->acceptJson()
            ->timeout($timeout);
    }

    public function stats(): array
    {
        return $this->http()->get('/stats')->throw()->json();
    }

    public function saveSettings(array $settings): array
    {
        return $this->http()->post('/settings', $settings)->throw()->json();
    }

    public function deleteRoom(string $roomId): int
    {
        return (int) $this->http()->post('/rooms/delete', ['id' => $roomId])->throw()->json('kicked');
    }

    public function kickRoom(string $roomId): int
    {
        return (int) $this->http()->post('/rooms/kick', ['id' => $roomId])->throw()->json('kicked');
    }

    /**
     * Forget which device registered a room's store. The stored ciphertext is
     * kept; the devices register again with their password-derived token on the
     * next write. Used when a room's history was claimed by another password.
     */
    public function resetRoom(string $roomId): bool
    {
        return (bool) $this->http()->post('/rooms/reset', ['id' => $roomId])->throw()->json('reset');
    }

    public function runJanitor(): array
    {
        return $this->http(120)->post('/janitor')->throw()->json();
    }

    /** Entry times/sizes, held entries, flags, live devices and the connection log. */
    public function roomMeta(string $roomId): ?array
    {
        $r = $this->http(60)->get('/rooms/meta', ['id' => $roomId]);
        if ($r->status() === 404) {
            return null;
        }

        return $r->throw()->json();
    }

    /** One stored file, as the ciphertext bytes. */
    public function roomFile(string $roomId, string $path): string
    {
        return $this->http(60)->accept('application/octet-stream')->get('/rooms/file', ['id' => $roomId, 'p' => $path])->throw()->body();
    }

    /**
     * @param  array<string, array|null>  $flags  hold / suspend / watch → record or null to clear
     */
    public function setFlags(string $roomId, array $flags): array
    {
        return $this->http()->post('/rooms/flags', ['id' => $roomId] + $flags)->throw()->json('flags') ?? [];
    }

    public function saveBlocks(array $blocks): array
    {
        return $this->http()->post('/blocks', ['blocks' => $blocks])->throw()->json('blocks') ?? [];
    }

    public function notice(?string $text, string $level = 'info', int $untilMs = 0): array
    {
        return $this->http()->post('/notice', ['text' => (string) $text, 'level' => $level, 'until' => $untilMs])->throw()->json();
    }

    public function reports(): array
    {
        return $this->http()->get('/reports')->throw()->json('reports') ?? [];
    }

    public function ackReports(array $ids): void
    {
        $this->http()->post('/reports/ack', ['ids' => array_values($ids)])->throw();
    }
}
