#!/usr/bin/env bash
# Publish the Endhost panel: build, then push the static site live.
#
# The panel is served in two halves and it is easy to forget the second one:
#   1. The Node service (systemd `endhost`) runs the API from dist/server.
#   2. nginx serves the actual pages/CSS/JS from /var/www/example.invalid — NOT from
#      this repo. A plain `git pull` + `systemctl restart` updates the API but
#      leaves the website on the last-published assets. That is exactly the trap
#      that shipped a stale dashboard once already.
#
# This script does both: rebuild the bundles and mirror public/ into the web root
# (with --delete, so old hashed chunks are cleaned up), then restart the service.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT="/var/www/example.invalid"

cd "$REPO"

echo "==> Building web + server bundles"
npm run build

echo "==> Publishing static site to $WEBROOT"
if [ ! -d "$WEBROOT" ]; then
  echo "!! $WEBROOT does not exist — is nginx configured for example.invalid on this host?" >&2
  exit 1
fi
rsync -a --delete "$REPO/public/" "$WEBROOT/"
echo "    synced $(find "$REPO/public" -type f | wc -l) files"

echo "==> Restarting the panel service"
if sudo -n systemctl restart endhost 2>/dev/null; then
  echo "    endhost restarted"
else
  echo "!! Could not restart without a password. Run:  sudo systemctl restart endhost" >&2
fi

echo "==> Live now at https://example.invalid/dashboard"
