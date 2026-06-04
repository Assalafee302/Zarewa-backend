#!/usr/bin/env bash
# Run on Hostinger SSH from backend repo root (SELECT-only profiler).
set -euo pipefail
cd "$(dirname "$0")/.."
APP_ROOT="$(pwd)"

NODE_BIN=""
for v in 22 20 18; do
  p="/opt/alt/alt-nodejs${v}/root/usr/bin/node"
  if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(find "$HOME/nodevenv" -name node -type f 2>/dev/null | head -1 || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo '{"ok":false,"error":"node_not_found","hint":"Set NODE_BIN to Hostinger Node path from hPanel"}' >&2
  exit 127
fi

echo "Using node: $NODE_BIN ($("$NODE_BIN" --version))" >&2
test -f .env || { echo '{"ok":false,"error":"missing_dotenv"}' >&2; exit 1; }
test -f scripts/finance-live-profile-readonly.mjs || { echo '{"ok":false,"error":"missing_profiler_script"}' >&2; exit 1; }

"$NODE_BIN" scripts/finance-live-profile-readonly.mjs > finance-profile.json 2> finance-profile-run.log
echo "Wrote $APP_ROOT/finance-profile.json (see finance-profile-run.log)" >&2
