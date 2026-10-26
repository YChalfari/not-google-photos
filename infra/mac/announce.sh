#!/bin/bash
# Announces this server on the home network with Bonjour. Docker on a Mac cannot broadcast,
# so launchd runs this on the host. Phones browse for _ngp._tcp and match id to the paired server.
set -euo pipefail

PORT="${NGP_PORT:-4810}"
HOST="${NGP_HOST:-127.0.0.1}"
info=""
for _ in $(seq 1 60); do
  if info="$(curl -fsS "http://${HOST}:${PORT}/api/server/info" 2>/dev/null)"; then
    break
  fi
  sleep 2
done

if [[ -z "$info" ]]; then
  echo "Not Google Photos did not answer on ${HOST}:${PORT}" >&2
  exit 1
fi

server_id="$(printf '%s' "$info" | sed -n 's/.*"serverId":"\([^"]*\)".*/\1/p')"
name="$(printf '%s' "$info" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
if [[ -z "$server_id" || -z "$name" ]]; then
  echo "Could not read the server id from /api/server/info" >&2
  exit 1
fi

exec /usr/bin/dns-sd -R "$name" _ngp._tcp local "$PORT" "id=${server_id}" "name=${name}" "v=1" "api=/api"
