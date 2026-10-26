#!/bin/bash
# Prepares a MacBook to run Not Google Photos: library folder, Docker stack, Bonjour, nightly backup.
# Docker Desktop itself should be set to start at login (Settings → General).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
port="${PORT:-4810}"

if [[ ! -f "$root/.env" ]]; then
  cp "$root/.env.example" "$root/.env"
  echo "Wrote $root/.env — set HOME_URL to this Mac's address on your Wi-Fi."
fi

# shellcheck disable=SC1091
set -a
source "$root/.env"
set +a
port="${PORT:-4810}"

if [[ -z "${LIBRARY_DIR:-}" ]]; then
  library="$HOME/Pictures/NotGooglePhotos"
  printf '\nLIBRARY_DIR=%s\n' "$library" >>"$root/.env"
  LIBRARY_DIR="$library"
elif [[ "$LIBRARY_DIR" != /* ]]; then
  LIBRARY_DIR="$root/${LIBRARY_DIR#./}"
fi

if [[ "$LIBRARY_DIR" == /Volumes/* && ! -d "$(dirname "$LIBRARY_DIR")" ]]; then
  echo "The drive for $LIBRARY_DIR is not mounted. Plug it in and run this again." >&2
  exit 1
fi
mkdir -p "$LIBRARY_DIR"
echo "Library folder: $LIBRARY_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Install Docker Desktop, set it to start at login, then run this script again." >&2
  exit 1
fi

"$root/infra/compose.sh" up -d --build

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Bonjour and the nightly backup are installed as launchd agents on macOS. This machine is $(uname -s)."
  exit 0
fi

agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents" "$HOME/Library/Logs"
uid="$(id -u)"

install_agent() {
  local name="$1"
  local dest="$agents/photos.ngp.${name}.plist"
  sed -e "s|@REPO@|$root|g" -e "s|@HOME@|$HOME|g" -e "s|@PORT@|$port|g" \
    "$root/infra/mac/${name}.plist" >"$dest"
  launchctl bootout "gui/${uid}" "$dest" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${uid}" "$dest"
  echo "Installed $dest"
}

install_agent announce
install_agent backup
echo "The server is on port ${port}. Set HOME_URL in .env to http://<this-mac>:${port} so phones off this machine can pair."
