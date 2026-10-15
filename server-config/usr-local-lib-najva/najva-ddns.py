#!/usr/bin/env python3
"""Keep Cloudflare DNS records pointing at this server's current addresses.

Home/satellite connections can renumber. Every run reads the server's current
global IPv6 (from the network interface) and, if enabled, its public IPv4 (as
Cloudflare sees it). When an address differs from the one seen last time,
every record of that type (AAAA / A), in every zone the token can see, that
still holds the old address is moved to the new one. Records pointing anywhere
else are never touched. State and a status summary for the admin panel live in
STATE_DIR (the panel reads a copy the service writes to /run).

Environment: CF_API_TOKEN, DDNS_IFACE (default eth0), DDNS_V6 (default 1),
DDNS_V4 (default 0).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

API = "https://api.cloudflare.com/client/v4"
TOKEN = os.environ.get("CF_API_TOKEN", "")
IFACE = os.environ.get("DDNS_IFACE", "eth0")
USE_V6 = os.environ.get("DDNS_V6", "1") == "1"
USE_V4 = os.environ.get("DDNS_V4", "0") == "1"
STATE_DIR = os.environ.get("STATE_DIRECTORY", "/var/lib/najva-ddns")
STATE = os.path.join(STATE_DIR, "state.json")
STATUS = os.path.join(STATE_DIR, "status.json")


def cf(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    if not data.get("success"):
        raise RuntimeError(str(data.get("errors")))
    return data


def current_ipv6():
    out = subprocess.run(["ip", "-6", "-j", "addr", "show", "dev", IFACE, "scope", "global"], capture_output=True, text=True, check=True).stdout
    for iface in json.loads(out):
        for a in iface.get("addr_info", []):
            if a.get("family") != "inet6" or a.get("temporary") or a.get("deprecated") or a.get("tentative"):
                continue
            ip = a["local"]
            if ip.startswith(("fd", "fc", "fe80")):
                continue
            return ip
    return None


def current_ipv4():
    # The public address as Cloudflare sees it (works behind a home router's NAT).
    with urllib.request.urlopen("https://1.1.1.1/cdn-cgi/trace", timeout=15) as r:
        m = re.search(r"^ip=([0-9.]+)$", r.read().decode(), re.M)
    return m.group(1) if m else None


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def follow(rtype, key, ip, state, status):
    """Move records of rtype still holding the previous address to ip."""
    old = state.get(key)
    status[key] = ip
    if old is None:
        state[key] = ip
        status["note"] = "baseline recorded"
        return
    if old == ip:
        return
    moved = []
    for z in cf("GET", "/zones?per_page=50")["result"]:
        recs = cf("GET", f"/zones/{z['id']}/dns_records?type={rtype}&content={old}&per_page=100")["result"]
        for r in recs:
            cf("PATCH", f"/zones/{z['id']}/dns_records/{r['id']}", {"content": ip})
            moved.append(r["name"])
    state[key] = ip
    status.update(last_change=int(time.time()), **{f"previous_{key}": old}, updated=moved)
    print(f"{rtype} address changed {old} -> {ip}; updated {len(moved)} records: {', '.join(moved)}")


def main():
    status = load(STATUS, {})
    status["last_check"] = int(time.time())
    try:
        if not TOKEN:
            raise RuntimeError("CF_API_TOKEN missing")
        state = load(STATE, {})
        if USE_V6:
            ip6 = current_ipv6()
            if not ip6:
                raise RuntimeError(f"no global IPv6 on {IFACE}")
            follow("AAAA", "ip", ip6, state, status)
        if USE_V4:
            ip4 = current_ipv4()
            if not ip4:
                raise RuntimeError("public IPv4 not found")
            follow("A", "ip4", ip4, state, status)
        save(STATE, state)
        status["ok"] = True
        status.pop("error", None)
    except Exception as e:  # noqa: BLE001 - report any failure to the panel
        status["ok"] = False
        status["error"] = str(e)[:300]
        print(f"ddns error: {e}", file=sys.stderr)
    save(STATUS, status)
    return 0 if status.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
