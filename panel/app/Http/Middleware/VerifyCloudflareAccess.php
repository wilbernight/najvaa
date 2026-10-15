<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\Response;

/**
 * Defence in depth behind Cloudflare Access: even if someone reached the
 * origin directly, every request must carry an Access JWT that is signed by
 * this account's Access team, issued for this application (aud), still
 * valid, and for one of the allowed admin emails.
 */
class VerifyCloudflareAccess
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! config('najva.access.enabled') || $request->is('up')) {
            return $next($request);
        }

        $token = $request->header('Cf-Access-Jwt-Assertion') ?: $request->cookie('CF_Authorization');
        $email = is_string($token) ? $this->verify($token) : null;

        abort_if($email === null, 403);
        $request->attributes->set('access_email', $email);

        return $next($request);
    }

    /** Returns the verified email, or null. */
    private function verify(string $jwt): ?string
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            return null;
        }
        [$h, $p, $s] = $parts;
        $header = json_decode($this->b64($h), true);
        $claims = json_decode($this->b64($p), true);
        if (! is_array($header) || ! is_array($claims) || ($header['alg'] ?? '') !== 'RS256') {
            return null;
        }

        $cert = $this->certs()[$header['kid'] ?? ''] ?? null;
        if (! $cert || openssl_verify("{$h}.{$p}", $this->b64($s), $cert, OPENSSL_ALGO_SHA256) !== 1) {
            return null;
        }

        $team = (string) config('najva.access.team_domain');
        $aud = (array) ($claims['aud'] ?? []);
        $now = time();
        if (($claims['iss'] ?? '') !== "https://{$team}"
            || ! in_array(config('najva.access.aud'), $aud, true)
            || ($claims['exp'] ?? 0) < $now
            || ($claims['nbf'] ?? 0) > $now + 60) {
            return null;
        }

        $email = strtolower((string) ($claims['email'] ?? ''));

        return in_array($email, config('najva.admins'), true) ? $email : null;
    }

    /** Access signing certificates by key id, cached for an hour. */
    private function certs(): array
    {
        $team = (string) config('najva.access.team_domain');

        return Cache::remember("cf-access-certs:{$team}", 3600, function () use ($team) {
            $list = Http::timeout(10)->get("https://{$team}/cdn-cgi/access/certs")->json('public_certs') ?? [];

            return collect($list)->mapWithKeys(fn ($c) => [$c['kid'] => $c['cert']])->all();
        });
    }

    private function b64(string $s): string
    {
        return (string) base64_decode(strtr($s, '-_', '+/').str_repeat('=', (4 - strlen($s) % 4) % 4));
    }
}
