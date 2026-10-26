#!/bin/bash
# Nightly logical dump into the library folder, so Time Machine covers the database and the photos.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -f "$root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$root/.env"
  set +a
fi

if [[ -z "${LIBRARY_DIR:-}" ]]; then
  LIBRARY_DIR="$root/data/library"
elif [[ "$LIBRARY_DIR" != /* ]]; then
  LIBRARY_DIR="$root/${LIBRARY_DIR#./}"
fi

if [[ ! -d "$LIBRARY_DIR" ]]; then
  echo "Library folder $LIBRARY_DIR is not available; skipping the database backup." >&2
  exit 1
fi

mkdir -p "$LIBRARY_DIR/backups"
stamp="$(date +%F)"
out="$LIBRARY_DIR/backups/ngp-${stamp}.sql.gz"

compose=(docker compose -f "$root/infra/docker-compose.yml")
if [[ -f "$root/.env" ]]; then
  compose+=(--env-file "$root/.env")
fi

"${compose[@]}" exec -T db pg_dump -U "${POSTGRES_USER:-ngp}" -d "${POSTGRES_DB:-ngp}" --no-owner | gzip >"$out"
find "$LIBRARY_DIR/backups" -name 'ngp-*.sql.gz' -mtime +14 -delete
echo "Wrote $out"
