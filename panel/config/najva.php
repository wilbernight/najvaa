<?php

// Najva admin panel. Every secret here comes from the server's .env; nothing
// sensitive is committed. The panel never sees chat content: the relay only
// reports sizes, counts and times, and it holds no keys.
return [

    // Admin API of the chat relay (bound to 127.0.0.1 on the same server).
    'relay_url' => env('NAJVA_RELAY_URL', 'http://127.0.0.1:8788'),
    'relay_secret' => env('NAJVA_RELAY_SECRET'),

    // Public address of the chat, used by the health check.
    'chat_url' => env('NAJVA_CHAT_URL', 'https://najvaa.xyz'),

    // Cloudflare API token (DNS / zone settings / SSL) for the domains page.
    'cloudflare_token' => env('CLOUDFLARE_API_TOKEN'),

    // Status written by the server's DDNS timer, and where nginx serves the
    // chat's origin certificate (checked over a local TLS connection).
    'ddns_status' => env('NAJVA_DDNS_STATUS', '/run/najva-ddns-status.json'),
    'origin_tls' => env('NAJVA_ORIGIN_TLS', '127.0.0.1:443'),

    // Only these accounts may open the panel (checked in the Nova gate and
    // against the Cloudflare Access identity).
    'admins' => array_values(array_filter(array_map(
        fn ($e) => strtolower(trim($e)),
        explode(',', (string) env('NAJVA_ADMINS', ''))
    ))),

    // Cloudflare Access in front of the panel. When enabled, every request
    // must carry a valid Access JWT for this application.
    'access' => [
        'enabled' => (bool) env('CF_ACCESS_ENABLED', false),
        'team_domain' => env('CF_ACCESS_TEAM_DOMAIN'),
        'aud' => env('CF_ACCESS_AUD'),
    ],

    // How long the dashboard keeps its own storage-size history.
    'metrics_days' => (int) env('NAJVA_METRICS_DAYS', 120),
];
