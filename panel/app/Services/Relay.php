<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;

/**
 * Talks to the chat relay's admin API on 127.0.0.1. It can read sizes,
 * counts, times and settings, and delete or disconnect a room. There is no
 * call that returns content: the relay itself never has any.
 */
class Relay
{
    private function http(): PendingRequest
    {
        return Http::baseUrl(config('najva.relay_url'))
            ->withHeaders(['X-Admin-Secret' => (string) config('najva.relay_secret')])
            ->acceptJson()
            ->timeout(15);
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

    public function runJanitor(): array
    {
        return $this->http()->post('/janitor')->throw()->json();
    }
}
