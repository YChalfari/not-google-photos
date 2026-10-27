#!/usr/bin/env bash
# Starts the stack. Resolves LIBRARY_DIR from the repo-root .env to an absolute path,
# and refuses to invent a library folder on a missing external drive.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$here"

env_args=()
if [[ -f "$root/.env" ]]; then
  env_args=(--env-file "$root/.env")
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

case "$LIBRARY_DIR" in
  "$root"/*)
    mkdir -p "$LIBRARY_DIR"
    ;;
  *)
    if [[ ! -d "$LIBRARY_DIR" ]]; then
      echo "Library folder $LIBRARY_DIR is not available. Connect the drive, or point LIBRARY_DIR at a folder that exists." >&2
      exit 1
    fi
    ;;
esac
export LIBRARY_DIR

if [[ ${#env_args[@]} -gt 0 ]]; then
  exec docker compose -f "$here/docker-compose.yml" "${env_args[@]}" "$@"
fi
exec docker compose -f "$here/docker-compose.yml" "$@"
