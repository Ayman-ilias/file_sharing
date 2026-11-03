#!/bin/sh
# Writes the nginx allowlist from TRUSTED_PROXIES (space-separated IPs or CIDRs).
# A bad entry stops the container with a message naming it, instead of a cryptic nginx error.
set -eu
out=/tmp/trusted.geo

valid() {  # IPv4[/0-32] with octets <= 255, or IPv6[/0-128] with at least one hex digit
  echo "$1" | awk -F/ '
    NF > 2 { exit 1 }
    {
      addr = $1; bits = (NF == 2) ? $2 : ""
      if (NF == 2 && bits !~ /^[0-9]+$/) exit 1
      if (addr ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
        n = split(addr, o, ".")
        for (i = 1; i <= n; i++) if (o[i] + 0 > 255) exit 1
        if (bits != "" && bits + 0 > 32) exit 1
        exit 0
      }
      if (addr ~ /^[0-9A-Fa-f:]+$/ && addr ~ /:/ && addr ~ /[0-9A-Fa-f]/ && addr !~ /:::/) {
        if (bits != "" && bits + 0 > 128) exit 1
        exit 0
      }
      exit 1
    }'
}

: > "$out"
for entry in ${TRUSTED_PROXIES:-10.10.8.100}; do
  if valid "$entry"; then
    echo "$entry 1;" >> "$out"
  else
    echo "TRUSTED_PROXIES: not an IP or CIDR: $entry" >&2
    exit 1
  fi
done
echo "trusted proxies: ${TRUSTED_PROXIES:-10.10.8.100}"
