<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;

class Cloudflare
{
    private function http(): PendingRequest
    {
        return Http::baseUrl('https://api.cloudflare.com/client/v4')
            ->withToken((string) config('najva.cloudflare_token'))
            ->acceptJson()
            ->timeout(20);
    }

    public function configured(): bool
    {
        return filled(config('najva.cloudflare_token'));
    }

    public function tokenValid(): bool
    {
        return (bool) $this->http()->get('/user/tokens/verify')->json('success');
    }

    public function zones(): array
    {
        return $this->http()->get('/zones', ['per_page' => 50])->throw()->json('result') ?? [];
    }

    public function records(string $zoneId, string $type): array
    {
        return $this->http()->get("/zones/{$zoneId}/dns_records", ['type' => $type, 'per_page' => 100])->throw()->json('result') ?? [];
    }

    public function setting(string $zoneId, string $name): mixed
    {
        return $this->http()->get("/zones/{$zoneId}/settings/{$name}")->json('result.value');
    }

    public function changeSetting(string $zoneId, string $name, mixed $value): void
    {
        $this->http()->patch("/zones/{$zoneId}/settings/{$name}", ['value' => $value])->throw();
    }
}
