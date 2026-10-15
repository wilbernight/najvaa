#!/usr/bin/env bash
# =============================================================================
#  Najva - private end-to-end encrypted chat: complete installer for Debian
#  12 (bookworm) or 13 (trixie). Run as root from the unpacked package:
#
#      bash install.sh
#
#  It asks a few questions, then sets up everything the way the original
#  server runs:
#    - the chat site and its blind relay (stores ciphertext only)
#    - nginx behind Cloudflare: the origin answers only Cloudflare's addresses
#    - a 15-year Cloudflare Origin certificate, SSL "Full (strict)", HTTPS only
#    - DNS records (proxied) and automatic updates when the IP changes (DDNS)
#    - Cloudflare Realtime TURN for voice calls (the server IP never leaks)
#    - optionally the admin panel (Laravel + Nova) behind Cloudflare Access
#      (one-time PIN to your e-mail) + its own login with 2FA / passkeys
#  Running it again is safe: it updates the code and keeps secrets and data.
# =============================================================================
set -Eeuo pipefail
umask 022

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/var/log/najva-install.log
ETC=/etc/najva
CONF="$ETC/install.conf"      # remembered answers (no secrets)
CF_ENV="$ETC/cf.env"          # Cloudflare token + DDNS settings (root only)
RELAY_ENV="$ETC/relay.env"    # relay settings and secrets (root only)
CERT_DIR=/etc/ssl/najva
LIB=/usr/local/lib/najva
PANEL_USER=najvapanel

# ---------------------------------------------------------------- output ----
B=$'\033[1m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
say()  { printf '\n%s==> %s%s\n' "$B$C" "$*" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%s✗ %s%s\n   (details: %s)\n' "$R" "$*" "$N" "$LOG" >&2; exit 1; }
trap 'die "Stopped at line $LINENO: $BASH_COMMAND"' ERR
run()  { "$@" >>"$LOG" 2>&1; }   # quiet command, output kept in the log

# ask VAR "question" [default]   (empty answer = default; no default = required)
ask() {
  local __v=$1 __q=$2 __d=${3-} __a
  while :; do
    if [ -n "$__d" ]; then read -r -p "   $__q [$__d]: " __a || true; __a=${__a:-$__d}
    else read -r -p "   $__q: " __a || true; fi
    [ -n "$__a" ] && break
  done
  printf -v "$__v" '%s' "$__a"
}
# ask_secret VAR "question" [optional|keep]   (typed text is not shown)
ask_secret() {
  local __v=$1 __q=$2 __mode=${3-} __a
  while :; do
    read -r -s -p "   $__q: " __a || true; echo
    [ -n "$__a" ] || [ -n "$__mode" ] && break
  done
  printf -v "$__v" '%s' "$__a"
}
# yesno "question" [y|n]
yesno() {
  local __d=${2:-y} __a
  read -r -p "   $1 [$([ "$__d" = y ] && echo Y/n || echo y/N)]: " __a || true
  __a=${__a:-$__d}
  [[ $__a =~ ^[Yy] ]]
}
# (no "head" in pipelines: with pipefail an early-closing reader can fail the line)
rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"${1:-40}"; }

# Render a template from stdin: @NAME@ -> value of $NAME.
render() {
  local s; s=$(cat)
  local k
  for k in DOMAIN PANEL_HOST SITE PANEL_SITE PHPV PHP_SOCK LISTEN443 LISTEN443V6 HTTP2 ZONE; do
    s=${s//@$k@/${!k-}}
  done
  printf '%s\n' "$s"
}

# ----------------------------------------------------------- Cloudflare API ---
# The token is passed to curl through a 600 file, never on the command line.
CF_HDR=""; CF_ERR=""
cf_init() {
  CF_HDR=$(mktemp); CF_ERR=$(mktemp); chmod 600 "$CF_HDR" "$CF_ERR"
  printf 'Authorization: Bearer %s\n' "$CF_TOKEN" >"$CF_HDR"
}
cleanup() { [ -n "$CF_HDR" ] && rm -f "$CF_HDR" "$CF_ERR"; return 0; }
trap cleanup EXIT
# cf METHOD /path [json]  -> prints the response; fails when success != true
cf() {
  local args=(-sS -m 60 -X "$1" -H @"$CF_HDR" -H 'Content-Type: application/json' "https://api.cloudflare.com/client/v4$2")
  [ -n "${3-}" ] && args+=(--data "$3")
  local out
  out=$(curl "${args[@]}" 2>>"$LOG") || { echo '{"errors":[{"message":"network error"}]}' >"$CF_ERR"; return 1; }
  if [ "$(jq -r '.success' <<<"$out" 2>/dev/null)" != true ]; then printf '%s' "$out" >"$CF_ERR"; return 1; fi
  printf '%s' "$out"
}
cf_err() { jq -r '[.errors[]? | "\(.code // "") \(.message)"] | join("; ")' "$CF_ERR" 2>/dev/null || cat "$CF_ERR"; }

# ===================================================================== steps ==
preflight() {
  [ "$(id -u)" -eq 0 ] || die "Run as root (for example: sudo -i, then bash install.sh)."
  [ -f /etc/debian_version ] || die "This installer is for Debian."
  . /etc/os-release
  case "${VERSION_ID:-}" in
    12|13) ;;
    *) warn "Tested on Debian 12 and 13; this is ${PRETTY_NAME:-unknown}."; yesno "Continue anyway?" n || exit 1 ;;
  esac
  for f in chat/public/index.html chat/public/app.js chat/server/relay.js system/najva-ddns.py; do
    [ -e "$PKG/$f" ] || die "The package is incomplete: $f is missing."
  done
  : >"$LOG"; chmod 600 "$LOG"
  mkdir -p "$ETC"; chmod 700 "$ETC"
  say "Installing the basic tools"
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update
  run apt-get install -y -q curl jq ca-certificates openssl python3 iproute2 rsync
  ok "curl, jq, openssl, python3"
  # shellcheck disable=SC1090
  [ -f "$CONF" ] && . "$CONF" && ok "Previous answers loaded from $CONF (press Enter to keep them)"
  return 0
}

detect_net() {
  IFACE=$(ip -6 route show default 2>/dev/null | awk '!f{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); f=1; break}}' || true)
  [ -n "$IFACE" ] || IFACE=$(ip route show default 2>/dev/null | awk '!f{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); f=1; break}}' || true)
  [ -n "$IFACE" ] || die "No default network route found."
  IP6=$(python3 - "$IFACE" <<'PY'
import json, subprocess, sys
out = subprocess.run(["ip", "-6", "-j", "addr", "show", "dev", sys.argv[1], "scope", "global"], capture_output=True, text=True).stdout or "[]"
for i in json.loads(out):
    for a in i.get("addr_info", []):
        if a.get("family") == "inet6" and not (a.get("temporary") or a.get("deprecated") or a.get("tentative")) and not a["local"].startswith(("fd", "fc", "fe80")):
            print(a["local"]); raise SystemExit
PY
)
  IP4=$(curl -4 -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)
  LOCAL4=$(ip -4 -o addr show dev "$IFACE" scope global 2>/dev/null | awk 'NR==1{split($4, a, "/"); print a[1]}' || true)
}

find_zone() {
  local name=$DOMAIN res
  while [[ $name == *.* ]]; do
    if res=$(cf GET "/zones?name=$name") && [ "$(jq -r '.result | length' <<<"$res")" -gt 0 ]; then
      ZONE=$name
      ZONE_ID=$(jq -r '.result[0].id' <<<"$res")
      ACCOUNT_ID=$(jq -r '.result[0].account.id' <<<"$res")
      ZONE_STATUS=$(jq -r '.result[0].status' <<<"$res")
      return 0
    fi
    name=${name#*.}
  done
  return 1
}

questions() {
  say "A few questions"
  echo "   The domain must already be added to your Cloudflare account, with its"
  echo "   nameservers at your registrar set to the two Cloudflare nameservers."
  ask DOMAIN "Chat domain (the chat opens at https://<this>)" "${DOMAIN-}"
  DOMAIN=$(tr 'A-Z' 'a-z' <<<"$DOMAIN" | tr -d ' /'); DOMAIN=${DOMAIN#https:}; DOMAIN=${DOMAIN#http:}
  [[ $DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "That does not look like a domain name: $DOMAIN"

  cat <<'TXT'

   Cloudflare API token: dash.cloudflare.com > My Profile > API Tokens > Create
   Token > "Create Custom Token", with these permissions:
     Zone    > Zone                 > Read
     Zone    > DNS                  > Edit
     Zone    > Zone Settings        > Edit
     Zone    > SSL and Certificates > Edit
     Account > Access: Apps and Policies                           > Edit  (panel)
     Account > Access: Organizations, Identity Providers, and Groups > Edit  (panel)
     Account > Calls (Realtime)     > Edit   (optional: creates the TURN key for calls)
   Zone Resources: your domain. Account Resources: your account.
TXT
  local saved=""
  [ -f "$CF_ENV" ] && saved=$(sed -n 's/^CF_API_TOKEN=//p' "$CF_ENV")
  if [ -n "$saved" ]; then
    ask_secret CF_TOKEN "Cloudflare API token (Enter = keep the saved one)" keep
    CF_TOKEN=${CF_TOKEN:-$saved}
  else
    ask_secret CF_TOKEN "Cloudflare API token"
  fi
  cf_init
  if cf GET /user/tokens/verify >/dev/null; then ok "Token is valid"; else warn "Token check: $(cf_err) (trying anyway)"; fi
  find_zone || die "No Cloudflare zone found for $DOMAIN with this token ($(cf_err)). Add the domain to Cloudflare and give the token access to it."
  ok "Cloudflare zone: $ZONE ($ZONE_STATUS)"
  [ "$ZONE_STATUS" = active ] || warn "The zone is not active yet: set the Cloudflare nameservers at your registrar. DNS will work once it is active."
  APEX=no; [ "$DOMAIN" = "$ZONE" ] && APEX=yes

  say "Network"
  detect_net
  echo "   Interface: $IFACE"
  echo "   IPv6: ${IP6:-none}"
  echo "   IPv4 (public, as Cloudflare sees it): ${IP4:-none}${LOCAL4:+  (this server: $LOCAL4)}"
  USE_V6=0; USE_V4=0
  if [ -n "$IP6" ] && yesno "Publish the IPv6 address (AAAA records)? Recommended" y; then USE_V6=1; fi
  if [ -n "$IP4" ]; then
    local d=y
    [ "$USE_V6" = 1 ] && d=n
    if [ -n "$LOCAL4" ] && [ "$LOCAL4" != "$IP4" ]; then
      echo "   This server sits behind NAT for IPv4: an A record only works if your"
      echo "   router forwards TCP port 443 (and 80) to $LOCAL4. Behind CGNAT"
      echo "   (Starlink, many mobile/fibre ISPs) IPv4 cannot work; use IPv6."
    fi
    if yesno "Publish the IPv4 address (A records)?" "$d"; then USE_V4=1; fi
  fi
  [ "$USE_V6" = 1 ] || [ "$USE_V4" = 1 ] || die "At least one address (IPv6 or IPv4) is needed for Cloudflare to reach this server."

  say "Voice calls"
  echo "   Calls go through Cloudflare Realtime TURN, so neither side (nor the server)"
  echo "   ever learns the other's IP address. Without it, calls may fail on mobile networks."
  TURN_ID=""; TURN_TOKEN=""
  if [ -f "$RELAY_ENV" ]; then
    TURN_ID=$(sed -n 's/^CF_TURN_KEY_ID=//p' "$RELAY_ENV"); TURN_TOKEN=$(sed -n 's/^CF_TURN_API_TOKEN=//p' "$RELAY_ENV")
  fi
  if [ -n "$TURN_ID" ] && [ -n "$TURN_TOKEN" ] && yesno "Keep the TURN key already configured?" y; then
    ok "TURN key kept"
  elif yesno "Set up Cloudflare TURN for calls?" y; then
    if yesno "Create the TURN key automatically (needs the Calls permission)?" y; then
      local r
      if r=$(cf POST "/accounts/$ACCOUNT_ID/calls/turn_keys" '{"name":"najva-chat"}'); then
        TURN_ID=$(jq -r '.result.uid' <<<"$r"); TURN_TOKEN=$(jq -r '.result.key' <<<"$r")
        ok "TURN key created"
      else
        warn "Could not create it ($(cf_err))."
      fi
    fi
    if [ -z "$TURN_ID" ] || [ "$TURN_ID" = null ]; then
      echo "   Create one at dash.cloudflare.com > Realtime > TURN Server > Create, then paste:"
      ask TURN_ID "Turn Token ID" ""
      ask_secret TURN_TOKEN "API Token of that TURN key"
    fi
  else
    warn "No TURN: calls may not connect between some networks."
  fi

  say "Chat storage"
  ask STORE_CAP_GB "Maximum space for encrypted chat history (GB)" "${STORE_CAP_GB:-50}"
  ask STORE_MAX_DAYS "Delete history older than (days)" "${STORE_MAX_DAYS:-90}"
  [[ $STORE_CAP_GB =~ ^[0-9]+$ && $STORE_MAX_DAYS =~ ^[0-9]+$ ]] || die "Please enter whole numbers."

  say "Admin panel"
  echo "   A web panel for rooms, storage, domains, features and the security log."
  echo "   It never sees chat content. It sits behind Cloudflare Access (a one-time"
  echo "   code to your e-mail) and its own login with two-factor authentication."
  INSTALL_PANEL=no
  local pdef=y; [ -d "$PKG/panel" ] || pdef=n
  if [ -d "$PKG/panel/vendor" ] && yesno "Install the admin panel?" "${INSTALL_PANEL_DEFAULT:-$pdef}"; then
    INSTALL_PANEL=yes
    ask PANEL_HOST "Panel address" "${PANEL_HOST:-mod.$ZONE}"
    PANEL_HOST=$(tr 'A-Z' 'a-z' <<<"$PANEL_HOST" | tr -d ' /')
    [[ $PANEL_HOST == *".$ZONE" ]] || die "The panel address must be inside $ZONE."
    ask ADMIN_EMAIL "Admin e-mail (receives the Cloudflare login codes)" "${ADMIN_EMAIL-}"
    [[ $ADMIN_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "That does not look like an e-mail address."
    ADMIN_EMAIL=$(tr 'A-Z' 'a-z' <<<"$ADMIN_EMAIL")
    ask_secret NOVA_LICENSE "Laravel Nova license key (Enter to skip)" optional
  fi

  SITE=/var/www/$DOMAIN
  PANEL_SITE=/var/www/${PANEL_HOST:-panel}

  say "Summary"
  echo "   Chat:        https://$DOMAIN   (files in $SITE)"
  [ "$APEX" = yes ] && echo "   Also:        https://www.$DOMAIN -> https://$DOMAIN"
  echo "   DNS:         $( [ "$USE_V6" = 1 ] && echo "AAAA $IP6 " )$( [ "$USE_V4" = 1 ] && echo "A $IP4" ) (proxied through Cloudflare)"
  echo "   Calls:       $( [ -n "$TURN_ID" ] && echo "Cloudflare TURN" || echo "no TURN" )"
  echo "   Storage:     ${STORE_CAP_GB} GB, ${STORE_MAX_DAYS} days"
  [ "$INSTALL_PANEL" = yes ] && echo "   Panel:       https://$PANEL_HOST  (admin: $ADMIN_EMAIL)"
  yesno "Start the installation?" y || exit 0

  cat >"$CONF" <<EOF
DOMAIN=$DOMAIN
PANEL_HOST=${PANEL_HOST-}
ADMIN_EMAIL=${ADMIN_EMAIL-}
STORE_CAP_GB=$STORE_CAP_GB
STORE_MAX_DAYS=$STORE_MAX_DAYS
INSTALL_PANEL_DEFAULT=$( [ "$INSTALL_PANEL" = yes ] && echo y || echo n )
EOF
  chmod 600 "$CONF"
}

install_packages() {
  say "Installing packages"
  run apt-get install -y -q nginx nodejs node-ws
  ok "nginx $(nginx -v 2>&1 | sed 's#.*/##'), Node.js $(node --version)"
  if [ "$INSTALL_PANEL" = yes ]; then
    run apt-get install -y -q php-fpm php-cli php-sqlite3 php-mbstring php-xml php-curl php-intl php-bcmath php-gd php-zip sqlite3 sudo
    PHPV=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')
    PHP_SOCK=/run/php/najva-panel.sock
    ok "PHP $PHPV"
  fi
  # nginx >= 1.25.1 uses "http2 on;", older versions "listen ... http2".
  local v; v=$(nginx -v 2>&1 | sed 's#.*/##')
  if [ "$(printf '%s\n1.25.1\n' "$v" | sort -V | sed -n 1p)" = 1.25.1 ]; then
    LISTEN443="listen 443 ssl;"; LISTEN443V6="listen [::]:443 ssl;"; HTTP2="http2 on;"
  else
    LISTEN443="listen 443 ssl http2;"; LISTEN443V6="listen [::]:443 ssl http2;"; HTTP2=""
  fi
}

install_chat() {
  say "Chat site and relay"
  if ss -ltnH 'sport = :8787' 2>/dev/null | grep -q . && ! systemctl is-active --quiet najva-relay; then
    die "Port 8787 is already used by another program (an older relay?). Stop it first."
  fi
  mkdir -p "$SITE/public" "$SITE/server"
  # /emoji/ is built and uploaded separately (chat/emoji-src); keep it.
  rsync -a --delete --exclude /emoji/ "$PKG/chat/public/" "$SITE/public/"
  install -m 644 "$PKG/chat/server/relay.js" "$SITE/server/relay.js"
  chown -R root:root "$SITE"
  find "$SITE" -type d -exec chmod 755 {} +
  find "$SITE" -type f -exec chmod 644 {} +
  ok "Files in $SITE"

  # Keep existing secrets on re-runs.
  local admin_secret turn_secret
  admin_secret=$( [ -f "$RELAY_ENV" ] && sed -n 's/^ADMIN_SECRET=//p' "$RELAY_ENV" || true)
  turn_secret=$( [ -f "$RELAY_ENV" ] && sed -n 's/^TURN_SECRET=//p' "$RELAY_ENV" || true)
  admin_secret=${admin_secret:-$(rand 44)}
  turn_secret=${turn_secret:-$(rand 44)}
  ( umask 077; cat >"$RELAY_ENV" <<EOF
PORT=8787
HOST=127.0.0.1
ORIGIN=https://$DOMAIN
ORIGINS=https://$DOMAIN
# Never list this server's own address here: the site stays behind Cloudflare.
STUN_URLS=stun:stun.cloudflare.com:3478
TURN_URLS=
TURN_SECRET=$turn_secret
# Cloudflare Realtime TURN key for calls.
CF_TURN_KEY_ID=$TURN_ID
CF_TURN_API_TOKEN=$TURN_TOKEN
STORE_CAP_GB=$STORE_CAP_GB
STORE_MAX_DAYS=$STORE_MAX_DAYS
# Admin API for the panel (127.0.0.1 only).
ADMIN_PORT=8788
ADMIN_SECRET=$admin_secret
EOF
  )
  RELAY_ADMIN_SECRET=$admin_secret

  render >/etc/systemd/system/najva-relay.service <<'EOF'
[Unit]
Description=Najva E2EE chat relay (blind: stores ciphertext only)
After=network.target

[Service]
ExecStart=/usr/bin/node @SITE@/server/relay.js
EnvironmentFile=/etc/najva/relay.env
DynamicUser=yes
# Encrypted room history lives here (ciphertext only).
StateDirectory=najva
StateDirectoryMode=0700
Restart=always
RestartSec=2
StandardOutput=null
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
MemoryMax=768M

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  run systemctl enable najva-relay
  run systemctl restart najva-relay
  sleep 2
  systemctl is-active --quiet najva-relay || die "The relay did not start (journalctl -u najva-relay)."
  ok "Relay running (127.0.0.1:8787, history in /var/lib/najva)"
}

origin_cert() {
  say "Cloudflare Origin certificate"
  mkdir -p "$CERT_DIR"; chmod 700 "$CERT_DIR"
  local pem=$CERT_DIR/origin.pem key=$CERT_DIR/origin.key
  local hosts=("$ZONE" "*.$ZONE")
  [ "$APEX" = no ] && hosts+=("$DOMAIN")
  if [ -s "$pem" ] && [ -s "$key" ] && openssl x509 -in "$pem" -noout -checkend $((30*86400)) >/dev/null 2>&1; then
    local san; san=$(openssl x509 -in "$pem" -noout -ext subjectAltName 2>/dev/null || true)
    local h missing=0
    for h in "${hosts[@]}"; do grep -qF "DNS:$h" <<<"$san" || missing=1; done
    if [ "$missing" = 0 ]; then ok "Existing certificate still valid, kept"; return 0; fi
  fi
  local tmp; tmp=$(mktemp -d)
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key" 2>>"$LOG"
  openssl req -new -key "$tmp/key" -subj "/CN=$ZONE" -out "$tmp/csr" 2>>"$LOG"
  local body r
  body=$(jq -n --rawfile csr "$tmp/csr" --argjson hosts "$(printf '%s\n' "${hosts[@]}" | jq -R . | jq -s .)" \
    '{hostnames: $hosts, requested_validity: 5475, request_type: "origin-ecc", csr: $csr}')
  r=$(cf POST /certificates "$body") || { rm -rf "$tmp"; die "Could not create the Origin certificate: $(cf_err). Does the token have Zone > SSL and Certificates > Edit?"; }
  jq -r '.result.certificate' <<<"$r" >"$tmp/pem"
  install -m 644 "$tmp/pem" "$pem"
  install -m 600 "$tmp/key" "$key"
  rm -rf "$tmp"
  ok "Certificate for ${hosts[*]} (valid 15 years) in $CERT_DIR"
}

nginx_config() {
  say "nginx"
  # Cloudflare's address ranges: real visitor IPs, and "is this request from Cloudflare?".
  local ips v4 v6 cidr
  ips=$(curl -s -m 20 https://api.cloudflare.com/client/v4/ips) && [ "$(jq -r .success <<<"$ips")" = true ] || die "Could not fetch Cloudflare's IP ranges."
  v4=$(jq -r '.result.ipv4_cidrs[]' <<<"$ips"); v6=$(jq -r '.result.ipv6_cidrs[]' <<<"$ips")
  {
    echo "# Generated by Najva install.sh from https://api.cloudflare.com/client/v4/ips"
    if ! grep -rqs --exclude=najva-cloudflare.conf 'real_ip_header' /etc/nginx/nginx.conf /etc/nginx/conf.d/; then
      for cidr in $v4 $v6; do echo "set_real_ip_from $cidr;"; done
      echo "real_ip_header CF-Connecting-IP;"
      echo "real_ip_recursive on;"
    fi
    echo
    echo "# The original peer (before the real-IP module) must be Cloudflare."
    echo 'geo $realip_remote_addr $najva_from_cf {'
    echo "    default 0;"
    for cidr in $v4 $v6; do echo "    $cidr 1;"; done
    echo "}"
    echo
    echo 'map $http_upgrade $najva_connection_upgrade {'
    echo "    default upgrade;"
    echo "    ''      close;"
    echo "}"
  } >/etc/nginx/conf.d/najva-cloudflare.conf

  # Per-client limits for the two endpoints that fetch from the internet for a
  # client (Instagram previews, GIF search). Counters are in memory only.
  cat >/etc/nginx/conf.d/najva-limits.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=najva_fetch:10m rate=30r/m;
limit_req_status 429;
EOF

  cat >/etc/nginx/snippets/najva-origin.conf <<EOF
ssl_certificate     $CERT_DIR/origin.pem;
ssl_certificate_key $CERT_DIR/origin.key;
ssl_protocols       TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_tickets off;
EOF

  local www_names="" www_block=""
  if [ "$APEX" = yes ]; then
    www_names=" www.$DOMAIN"
    www_block=$(render <<'EOF'

# www -> the bare domain
server {
    @LISTEN443@
    @LISTEN443V6@
    @HTTP2@
    include snippets/najva-origin.conf;
    server_name www.@DOMAIN@;
    access_log off;
    if ($najva_from_cf = 0) { return 444; }
    return 301 https://@DOMAIN@$request_uri;
}
EOF
)
  fi

  { render <<'EOF'
# Najva chat. Plain HTTP only redirects; HTTPS answers Cloudflare only.
server {
    listen 80;
    listen [::]:80;
    server_name @DOMAIN@ WWWNAMES;
    access_log off;
    return 301 https://@DOMAIN@$request_uri;
}

server {
    @LISTEN443@
    @LISTEN443V6@
    @HTTP2@
    include snippets/najva-origin.conf;
    server_name @DOMAIN@;

    # Only Cloudflare may talk to the origin; its address stays hidden.
    if ($najva_from_cf = 0) { return 444; }

    root @SITE@/public;
    index index.html;

    # Privacy: no access log for the chat (no IPs, no timestamps).
    access_log off;
    error_log  /var/log/nginx/najva-chat-error.log crit;
    server_tokens off;
    client_max_body_size 1M;

    add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://@DOMAIN@; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "microphone=(self), camera=(), geolocation=(), payment=(), usb=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-store" always;

    location = /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $najva_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location = /preview {
        limit_except POST { deny all; }
        client_max_body_size 8k;
        limit_req zone=najva_fetch burst=10 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Origin $http_origin;
        proxy_read_timeout 30s;
    }

    # Encrypted room history (ciphertext only).
    location ^~ /h/ {
        limit_except GET POST PUT { deny all; }
        client_max_body_size 1m;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Origin $http_origin;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    # GIF search reads Giphy/Tenor on the server, so it is limited per client;
    # the media files are not (a result page loads dozens).
    location = /gif/search {
        limit_except POST { deny all; }
        client_max_body_size 4k;
        limit_req zone=najva_fetch burst=10 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Origin $http_origin;
        proxy_set_header Sec-Fetch-Site $http_sec_fetch_site;
        proxy_read_timeout 20s;
    }

    location ^~ /gif/ {
        limit_except GET POST { deny all; }
        client_max_body_size 4k;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Origin $http_origin;
        proxy_set_header Sec-Fetch-Site $http_sec_fetch_site;
        proxy_read_timeout 20s;
    }

    # The female-voice filter module: every client fetches it once at start and
    # keeps it cached, so loading it never marks who uses the feature.
    location = /voicefx-worklet.js {
        add_header Cache-Control "public, max-age=86400" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cross-Origin-Resource-Policy "same-origin" always;
        try_files $uri =404;
    }

    # On-device AI voice models; versioned path, cached for a year.
    location ^~ /ai/ {
        types {
            application/wasm wasm;
            text/javascript js mjs;
            application/json json;
            application/octet-stream onnx gz;
        }
        gzip off;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cross-Origin-Resource-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        try_files $uri =404;
    }

    # Animated emoji (built by chat/emoji-src, uploaded separately). Not a
    # versioned path, so a week for the images and an hour for the index.
    location ^~ /emoji/ {
        gzip_types application/json;
        add_header Cache-Control "public, max-age=604800" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cross-Origin-Resource-Policy "same-origin" always;
        location = /emoji/index.json {
            add_header Cache-Control "public, max-age=3600" always;
            add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header Cross-Origin-Resource-Policy "same-origin" always;
            try_files $uri =404;
        }
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ /\. {
        deny all;
    }
}
EOF
    printf '%s\n' "$www_block"
  } | sed "s| WWWNAMES|$www_names|" >/etc/nginx/sites-available/najva-chat.conf
  ln -sf /etc/nginx/sites-available/najva-chat.conf /etc/nginx/sites-enabled/najva-chat.conf
  nginx -t >>"$LOG" 2>&1 || die "nginx rejected the configuration (nginx -t)."
  run systemctl enable nginx
  run systemctl reload-or-restart nginx
  ok "Chat vhost ($DOMAIN), only reachable through Cloudflare"
}

# dns_upsert TYPE FQDN ADDRESS
dns_upsert() {
  local t=$1 n=$2 c=$3 cur id old body cn
  cur=$(cf GET "/zones/$ZONE_ID/dns_records?type=$t&name=$n") || die "DNS lookup failed: $(cf_err)"
  id=$(jq -r '.result[0].id // empty' <<<"$cur"); old=$(jq -r '.result[0].content // empty' <<<"$cur")
  body=$(jq -n --arg t "$t" --arg n "$n" --arg c "$c" '{type: $t, name: $n, content: $c, proxied: true, ttl: 1, comment: "Najva (install.sh)"}')
  if [ -n "$id" ]; then
    if [ "$old" != "$c" ]; then
      warn "$t $n currently points to $old"
      yesno "Point it at this server instead?" y || return 0
    fi
    cf PUT "/zones/$ZONE_ID/dns_records/$id" "$body" >/dev/null || die "Could not update $t $n: $(cf_err)"
  else
    cn=$(cf GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$n" | jq -r '.result[0].id // empty') || true
    if [ -n "$cn" ]; then
      warn "$n is a CNAME record now"
      yesno "Replace the CNAME with this server's address?" n || return 0
      cf DELETE "/zones/$ZONE_ID/dns_records/$cn" >/dev/null || die "Could not delete the CNAME: $(cf_err)"
    fi
    cf POST "/zones/$ZONE_ID/dns_records" "$body" >/dev/null || die "Could not create $t $n: $(cf_err)"
  fi
  ok "$t $n -> this server (proxied)"
}

# dns_host FQDN: the chosen address families, and no stale record of the other one.
dns_host() {
  local n=$1 t other ip
  for t in AAAA A; do
    if [ "$t" = AAAA ]; then [ "$USE_V6" = 1 ] || continue; ip=$IP6; else [ "$USE_V4" = 1 ] || continue; ip=$IP4; fi
    dns_upsert "$t" "$n" "$ip"
  done
  for t in AAAA A; do
    if { [ "$t" = AAAA ] && [ "$USE_V6" = 0 ]; } || { [ "$t" = A ] && [ "$USE_V4" = 0 ]; }; then
      other=$(cf GET "/zones/$ZONE_ID/dns_records?type=$t&name=$n" | jq -r '.result[0] | select(.) | "\(.id) \(.content)"') || true
      if [ -n "$other" ]; then
        warn "$t $n also exists (${other#* }); visitors could be sent there instead."
        yesno "Delete that $t record?" y && cf DELETE "/zones/$ZONE_ID/dns_records/${other%% *}" >/dev/null && ok "Deleted $t $n"
      fi
    fi
  done
  return 0
}

zone_settings() {
  say "Cloudflare security settings for $ZONE"
  local s
  for s in 'ssl "strict"' 'always_use_https "on"' 'min_tls_version "1.2"' 'tls_1_3 "on"' 'websockets "on"' 'automatic_https_rewrites "on"'; do
    local k=${s%% *} v=${s#* }
    if cf PATCH "/zones/$ZONE_ID/settings/$k" "{\"value\":$v}" >/dev/null; then ok "$k = ${v//\"/}"
    else warn "Could not set $k ($(cf_err)). Set it in the dashboard (Zone Settings > Edit permission)."; fi
  done
}

ddns() {
  say "Automatic IP updates (DDNS)"
  ( umask 077; cat >"$CF_ENV" <<EOF
CF_API_TOKEN=$CF_TOKEN
DDNS_IFACE=$IFACE
DDNS_V6=$USE_V6
DDNS_V4=$USE_V4
EOF
  )
  mkdir -p "$LIB"
  install -m 755 "$PKG/system/najva-ddns.py" "$LIB/najva-ddns.py"
  cat >/etc/systemd/system/najva-ddns.service <<'EOF'
[Unit]
Description=Keep Cloudflare DNS records on this server's current address
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/najva/cf.env
ExecStart=/usr/bin/python3 /usr/local/lib/najva/najva-ddns.py
# Readable copy of the status for the admin panel (the state dir is under
# /var/lib/private, which only root can enter). Runs as root, also on failure.
ExecStopPost=+/bin/sh -c 'install -m 644 /var/lib/private/najva-ddns/status.json /run/najva-ddns-status.json 2>/dev/null || true'
DynamicUser=yes
StateDirectory=najva-ddns
StateDirectoryMode=0755
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
EOF
  cat >/etc/systemd/system/najva-ddns.timer <<'EOF'
[Unit]
Description=Check this server's address for Cloudflare every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  run systemctl enable --now najva-ddns.timer
  run systemctl start najva-ddns.service || true
  if [ -s /run/najva-ddns-status.json ] && [ "$(jq -r .ok /run/najva-ddns-status.json)" = true ]; then ok "DDNS checks every 5 minutes"
  else warn "DDNS first run reported a problem: $(jq -r '.error // "unknown"' /run/najva-ddns-status.json 2>/dev/null)"; fi
}

access_app() {
  # Cloudflare Access in front of the panel: one-time PIN to the admin e-mail.
  local org idps otp apps app_id r
  while :; do
    if org=$(cf GET "/accounts/$ACCOUNT_ID/access/organizations") && [ -n "$(jq -r '.result.auth_domain // empty' <<<"$org")" ]; then
      TEAM_DOMAIN=$(jq -r '.result.auth_domain' <<<"$org"); break
    fi
    warn "Cloudflare Zero Trust is not set up for this account yet ($(cf_err))."
    echo "   Open https://one.dash.cloudflare.com , pick a team name and the Free plan,"
    echo "   then come back here."
    yesno "Done - check again?" y || die "The panel needs Cloudflare Access. Re-run the installer when Zero Trust is ready."
  done
  ok "Zero Trust team: $TEAM_DOMAIN"
  idps=$(cf GET "/accounts/$ACCOUNT_ID/access/identity_providers") || die "Cannot read Access login methods: $(cf_err)"
  otp=$(jq -r '[.result[] | select(.type == "onetimepin") | .id][0] // empty' <<<"$idps")
  if [ -z "$otp" ]; then
    r=$(cf POST "/accounts/$ACCOUNT_ID/access/identity_providers" '{"name":"One-time PIN","type":"onetimepin","config":{}}') || die "Cannot enable the one-time PIN login: $(cf_err)"
    otp=$(jq -r '.result.id' <<<"$r")
  fi
  apps=$(cf GET "/accounts/$ACCOUNT_ID/access/apps") || die "Cannot read Access applications: $(cf_err)"
  app_id=$(jq -r --arg d "$PANEL_HOST" '[.result[] | select(.domain == $d) | .id][0] // empty' <<<"$apps")
  local body
  body=$(jq -n --arg d "$PANEL_HOST" --arg idp "$otp" '{
    name: "Najva admin panel", type: "self_hosted", domain: $d, session_duration: "8h",
    allowed_idps: [$idp], auto_redirect_to_identity: true, app_launcher_visible: false,
    http_only_cookie_attribute: true, same_site_cookie_attribute: "lax", enable_binding_cookie: true,
    skip_interstitial: true }')
  if [ -n "$app_id" ]; then
    r=$(cf PUT "/accounts/$ACCOUNT_ID/access/apps/$app_id" "$body") || die "Cannot update the Access application: $(cf_err)"
  else
    r=$(cf POST "/accounts/$ACCOUNT_ID/access/apps" "$body") || die "Cannot create the Access application: $(cf_err)"
    app_id=$(jq -r '.result.id' <<<"$r")
  fi
  ACCESS_AUD=$(jq -r '.result.aud' <<<"$r")
  local pols pid pbody
  pbody=$(jq -n --arg e "$ADMIN_EMAIL" '{name: "Admin only", decision: "allow", include: [{email: {email: $e}}], precedence: 1, session_duration: "8h"}')
  pols=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$app_id/policies") || die "Cannot read the Access policy: $(cf_err)"
  pid=$(jq -r '[.result[] | select(.name == "Admin only") | .id][0] // empty' <<<"$pols")
  if [ -n "$pid" ]; then cf PUT "/accounts/$ACCOUNT_ID/access/apps/$app_id/policies/$pid" "$pbody" >/dev/null || die "Cannot update the Access policy: $(cf_err)"
  else cf POST "/accounts/$ACCOUNT_ID/access/apps/$app_id/policies" "$pbody" >/dev/null || die "Cannot create the Access policy: $(cf_err)"; fi
  ok "Cloudflare Access: only $ADMIN_EMAIL can reach $PANEL_HOST (one-time code by e-mail)"
}

# set_env FILE KEY VALUE (adds or replaces a line)
set_env() {
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then
    local esc; esc=$(printf '%s' "$v" | sed 's/[\/&|]/\\&/g')
    sed -i "s|^$k=.*|$k=$esc|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

install_panel() {
  say "Admin panel ($PANEL_HOST)"
  access_app
  id "$PANEL_USER" >/dev/null 2>&1 || useradd --system --home-dir "$PANEL_SITE" --no-create-home --shell /usr/sbin/nologin "$PANEL_USER"
  mkdir -p "$PANEL_SITE"
  rsync -a --delete --exclude /.env --exclude /storage/ --exclude /database/database.sqlite --exclude /bootstrap/cache/ "$PKG/panel/" "$PANEL_SITE/"
  mkdir -p "$PANEL_SITE"/storage/app/public "$PANEL_SITE"/storage/framework/{cache/data,sessions,views} "$PANEL_SITE"/storage/logs "$PANEL_SITE"/bootstrap/cache
  touch "$PANEL_SITE/database/database.sqlite"

  local envf=$PANEL_SITE/.env
  if [ ! -f "$envf" ]; then
    ( umask 077; cat >"$envf" <<EOF
APP_NAME="نجوا · مدیریت"
APP_ENV=production
APP_KEY=base64:$(openssl rand -base64 32)
APP_DEBUG=false
APP_URL=https://$PANEL_HOST
APP_LOCALE=fa
APP_FALLBACK_LOCALE=en
NOVA_PATH=/console
NOVA_LICENSE_KEY=
LOG_CHANNEL=daily
LOG_LEVEL=warning
LOG_DAILY_DAYS=14
DB_CONNECTION=sqlite
DB_DATABASE=$PANEL_SITE/database/database.sqlite
SESSION_DRIVER=database
SESSION_LIFETIME=30
SESSION_EXPIRE_ON_CLOSE=true
SESSION_ENCRYPT=true
SESSION_SECURE_COOKIE=true
SESSION_HTTP_ONLY=true
SESSION_SAME_SITE=strict
SESSION_PATH=/
SESSION_DOMAIN=null
CACHE_STORE=file
QUEUE_CONNECTION=sync
MAIL_MAILER=log
BCRYPT_ROUNDS=12
NAJVA_RELAY_URL=http://127.0.0.1:8788
NAJVA_DDNS_STATUS=/run/najva-ddns-status.json
NAJVA_ORIGIN_TLS=127.0.0.1:443
CF_ACCESS_ENABLED=true
EOF
    )
  fi
  set_env "$envf" APP_URL "https://$PANEL_HOST"
  set_env "$envf" NAJVA_CHAT_URL "https://$DOMAIN"
  set_env "$envf" NAJVA_ADMINS "$ADMIN_EMAIL"
  set_env "$envf" NAJVA_RELAY_SECRET "$RELAY_ADMIN_SECRET"
  set_env "$envf" CLOUDFLARE_API_TOKEN "$CF_TOKEN"
  set_env "$envf" CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN"
  set_env "$envf" CF_ACCESS_AUD "$ACCESS_AUD"
  [ -n "${NOVA_LICENSE-}" ] && set_env "$envf" NOVA_LICENSE_KEY "$NOVA_LICENSE"

  # Code: root-owned, readable by the panel user only; nginx may only enter public/.
  chown -R root:"$PANEL_USER" "$PANEL_SITE"
  find "$PANEL_SITE" -type d -exec chmod 750 {} +
  find "$PANEL_SITE" -type f -exec chmod 640 {} +
  chmod 751 "$PANEL_SITE"
  find "$PANEL_SITE/public" -type d -exec chmod 755 {} +
  find "$PANEL_SITE/public" -type f -exec chmod 644 {} +
  chown root:"$PANEL_USER" "$envf"; chmod 640 "$envf"
  chown -R "$PANEL_USER:$PANEL_USER" "$PANEL_SITE/storage" "$PANEL_SITE/bootstrap/cache" "$PANEL_SITE/database"
  chmod 750 "$PANEL_SITE/database"; chmod 600 "$PANEL_SITE/database/database.sqlite"

  ( cd "$PANEL_SITE"
    run runuser -u "$PANEL_USER" -- php artisan migrate --force --no-interaction || die "Database setup failed."
    run runuser -u "$PANEL_USER" -- php artisan optimize --no-interaction || die "Laravel optimize failed."
  )
  ok "Panel files in $PANEL_SITE (database: SQLite)"

  render >"/etc/php/$PHPV/fpm/pool.d/najva-panel.conf" <<'EOF'
; Dedicated pool for the Najva admin panel: its own unix user, so the panel's
; .env (relay admin secret, Cloudflare token) is readable by nothing else.
[najva-panel]
user = najvapanel
group = najvapanel
listen = @PHP_SOCK@
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 6
pm.process_idle_timeout = 30s
pm.max_requests = 500
security.limit_extensions = .php
clear_env = yes
php_admin_flag[expose_php] = off
php_admin_flag[display_errors] = off
php_admin_flag[allow_url_include] = off
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,popen,pcntl_exec
php_admin_value[upload_max_filesize] = 2M
php_admin_value[post_max_size] = 2M
php_admin_value[memory_limit] = 256M
php_admin_value[session.cookie_secure] = 1
php_admin_value[error_log] = @PANEL_SITE@/storage/logs/php-fpm.log
EOF
  php-fpm"$PHPV" -t >>"$LOG" 2>&1 || die "php-fpm rejected the pool configuration."
  run systemctl enable "php$PHPV-fpm"
  run systemctl reload-or-restart "php$PHPV-fpm"

  render >/etc/nginx/sites-available/najva-panel.conf <<'EOF'
# Najva admin panel: only through Cloudflare, and Cloudflare Access in front.
server {
    listen 80;
    listen [::]:80;
    server_name @PANEL_HOST@;
    access_log off;
    return 301 https://@PANEL_HOST@$request_uri;
}

server {
    @LISTEN443@
    @LISTEN443V6@
    @HTTP2@
    include snippets/najva-origin.conf;
    server_name @PANEL_HOST@;

    if ($najva_from_cf = 0) { return 444; }
    # Cloudflare Access adds this header to every request it lets through.
    if ($http_cf_access_jwt_assertion = "") { return 403; }

    root @PANEL_SITE@/public;
    index index.php;

    access_log off;
    error_log  /var/log/nginx/najva-panel-error.log error;
    server_tokens off;
    client_max_body_size 2M;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /index.php {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:@PHP_SOCK@;
        fastcgi_param HTTPS on;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ \.php$ { return 404; }
    location ~ /\.(?!well-known) { deny all; }
}
EOF
  ln -sf /etc/nginx/sites-available/najva-panel.conf /etc/nginx/sites-enabled/najva-panel.conf
  nginx -t >>"$LOG" 2>&1 || die "nginx rejected the panel configuration."
  run systemctl reload nginx

  render >/etc/systemd/system/najva-panel-scheduler.service <<'EOF'
[Unit]
Description=Najva admin panel scheduler (sync, health, domains)

[Service]
Type=oneshot
User=najvapanel
Group=najvapanel
WorkingDirectory=@PANEL_SITE@
ExecStart=/usr/bin/php artisan schedule:run --no-interaction
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=@PANEL_SITE@/storage @PANEL_SITE@/database @PANEL_SITE@/bootstrap/cache
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
EOF
  cat >/etc/systemd/system/najva-panel-scheduler.timer <<'EOF'
[Unit]
Description=Run the Najva admin panel scheduler every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  run systemctl enable --now najva-panel-scheduler.timer
  ok "Panel web server, PHP pool and scheduler"
}

verify() {
  say "Checking"
  local svc
  for svc in najva-relay nginx najva-ddns.timer $( [ "$INSTALL_PANEL" = yes ] && echo "php$PHPV-fpm najva-panel-scheduler.timer" ); do
    if systemctl is-active --quiet "$svc"; then ok "$svc running"; else warn "$svc is not running"; fi
  done
  local code="" i
  for i in $(seq 1 12); do
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$DOMAIN/" || true)
    [ "$code" = 200 ] && break
    sleep 10
  done
  if [ "$code" = 200 ]; then ok "https://$DOMAIN answers through Cloudflare"
  else warn "https://$DOMAIN is not answering yet (HTTP ${code:-none}). If the zone was just added, wait for DNS / the Cloudflare edge certificate, then open it again."; fi
  if [ "$INSTALL_PANEL" = yes ]; then
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$PANEL_HOST/" || true)
    case "$code" in
      302|403) ok "https://$PANEL_HOST is behind Cloudflare Access" ;;
      *) warn "https://$PANEL_HOST answered HTTP ${code:-none}; it may need a few minutes." ;;
    esac
  fi
}

panel_admin() {
  [ "$INSTALL_PANEL" = yes ] || return 0
  local users
  users=$(cd "$PANEL_SITE" && runuser -u "$PANEL_USER" -- php artisan tinker --execute='echo \App\Models\User::count();' 2>/dev/null | tail -1 || echo 0)
  [ "${users:-0}" -gt 0 ] 2>/dev/null && { ok "Panel admin account already exists"; return 0; }
  say "Create the panel admin account"
  echo "   Use exactly this e-mail: $ADMIN_EMAIL"
  echo "   Password: at least 14 characters with upper/lower case, a digit and a symbol."
  ( cd "$PANEL_SITE" && runuser -u "$PANEL_USER" -- php artisan nova:user ) || warn "Not created. Later: cd $PANEL_SITE && sudo -u $PANEL_USER php artisan nova:user"
}

finish() {
  say "Done"
  cat <<EOF
   Chat:   https://$DOMAIN
EOF
  if [ "$INSTALL_PANEL" = yes ]; then
    cat <<EOF
   Panel:  https://$PANEL_HOST
           1) Cloudflare asks for $ADMIN_EMAIL and e-mails a one-time code.
           2) Log in with the panel account, then open "حساب من" and turn on
              two-factor authentication or a passkey (required).
           Forgotten password:  cd $PANEL_SITE && sudo -u $PANEL_USER php artisan najva:password $ADMIN_EMAIL
EOF
  fi
  cat <<EOF

   Secrets (root only):  $RELAY_ENV, $CF_ENV$( [ "$INSTALL_PANEL" = yes ] && echo ", $PANEL_SITE/.env" )
   Origin certificate:   $CERT_DIR
   Encrypted history:    /var/lib/najva   (ciphertext only)
   Install log:          $LOG
   Run this installer again any time to update; secrets and data are kept.
EOF
}

main() {
  preflight
  questions
  install_packages
  install_chat
  origin_cert
  nginx_config
  say "DNS records"
  dns_host "$DOMAIN"
  [ "$APEX" = yes ] && dns_host "www.$DOMAIN"
  zone_settings
  ddns
  if [ "$INSTALL_PANEL" = yes ]; then
    install_panel
    say "Panel DNS (after Access protects it)"
    dns_host "$PANEL_HOST"
  fi
  verify
  panel_admin
  finish
}

main "$@"
