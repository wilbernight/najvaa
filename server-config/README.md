# Server configuration (live copy, secrets removed)

Copied from the production server. Every secret is replaced with `<REDACTED>`
(and the origin IP / LAN IP with placeholders); the real values live only on
the server. `install.sh` writes all of these itself on a fresh server.

| File here | Path on the server |
|---|---|
| `nginx/sites-available/najvaa.xyz` | `/etc/nginx/sites-available/najvaa.xyz` (chat; CSP, COOP/COEP, `/ai/` cache) |
| `nginx/sites-available/mod.najvaa.xyz` | `/etc/nginx/sites-available/mod.najvaa.xyz` (admin panel) |
| `nginx/snippets/najvaa-origin.conf` | `/etc/nginx/snippets/najvaa-origin.conf` (Cloudflare Origin cert paths) |
| `systemd/s1-relay.service` | `/etc/systemd/system/s1-relay.service` (relay, env `/etc/s1-relay.env`) |
| `systemd/najva-ddns.{service,timer}` | `/etc/systemd/system/` (DNS updater, env `/etc/najva-cf.env`) |
| `systemd/najva-panel-scheduler.{service,timer}` | `/etc/systemd/system/` (Laravel scheduler) |
| `php-fpm/najva-panel.conf` | `/etc/php/8.x/fpm/pool.d/najva-panel.conf` |
| `env/s1-relay.env.example` | `/etc/s1-relay.env` (mode 600) |
| `env/najva-cf.env.example` | `/etc/najva-cf.env` (mode 600) |
| `coturn/turnserver.conf` | `/etc/turnserver.conf` (coturn is installed but disabled) |
| `usr-local-lib-najva/najva-ddns.py` | `/usr/local/lib/najva/najva-ddns.py` |

Not in the repository: TLS keys (`/etc/ssl/cloudflare/`), the panel `.env`,
the encrypted chat store (`/var/lib/najva`).
