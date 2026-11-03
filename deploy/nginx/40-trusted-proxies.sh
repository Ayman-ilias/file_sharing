#!/bin/sh
# Writes the nginx allowlist from TRUSTED_PROXIES (space-separated IPs or CIDRs).
# A bad entry stops the container with a message naming it, instead of a cryptic nginx error.
set -eu
out=/tmp/trusted.geo
: > "$out"
for entry in ${TRUSTED_PROXIES:-10.10.8.100}; do
  if echo "$entry" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(/[0-9]{1,3})?$'; then
    echo "$entry 1;" >> "$out"
  else
    echo "TRUSTED_PROXIES: not an IP or CIDR: $entry" >&2
    exit 1
  fi
done
echo "trusted proxies: ${TRUSTED_PROXIES:-10.10.8.100}"
