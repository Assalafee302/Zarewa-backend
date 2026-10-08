#!/bin/bash
# Run on Hostinger after: ssh -p 65002 u172282559@46.202.142.146
set -euo pipefail

echo "=== Zarewa deploy $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

BACKEND=""
for d in \
  "$HOME/domains/api.zarewaglobalservices.com" \
  "$HOME/domains/api.zarewaglobalservices.com/public_html"
do
  if [[ -f "$d/package.json" && -f "$d/server/index.js" ]]; then
    BACKEND="$d"
    break
  fi
done
if [[ -z "$BACKEND" ]]; then
  BACKEND="$(find "$HOME/domains" -maxdepth 4 -path '*/server/index.js' 2>/dev/null | head -1 | xargs -I{} dirname {} | xargs -I{} dirname {})"
fi
[[ -n "$BACKEND" ]] || { echo "Backend repo not found"; exit 1; }

echo "Backend: $BACKEND"
cd "$BACKEND"

# Stop the old Node process BEFORE pull/boot so MySQL GET_LOCK (zarewa_mig_<db>)
# is released. Overlapping restarts cause: Could not acquire schema lock … within 120s.
echo "Stopping existing API process (if any)…"
if command -v pkill >/dev/null 2>&1; then
  pkill -f "$BACKEND/server/index.js" 2>/dev/null || true
  pkill -f "node server/index.js" 2>/dev/null || true
  sleep 3
else
  echo "pkill not available — stop the Node app in hPanel before continuing"
fi

git pull origin main
npm ci --omit=dev
node scripts/hostinger-boot-check.mjs

FRONTEND=""
for d in \
  "$HOME/domains/erp.zarewaglobalservices.com" \
  "$HOME/domains/erp.zarewaglobalservices.com/public_html"
do
  if [[ -f "$d/package.json" && -f "$d/vite.config.js" ]]; then
    FRONTEND="$d"
    break
  fi
done
if [[ -n "$FRONTEND" ]]; then
  echo "Frontend: $FRONTEND"
  cd "$FRONTEND"
  git pull origin main
  npm ci
  export VITE_API_BASE="${VITE_API_BASE:-https://api.zarewaglobalservices.com}"
  npm run build
  if [[ -d public_html && -d dist ]]; then
    cp -r dist/. public_html/
    echo "Copied dist -> public_html"
  fi
else
  echo "Frontend repo not found (skip if API serves SPA from app/dist)"
fi

echo ""
echo "=== Start Node app in hPanel now (Websites -> Node.js -> Restart / Start) ===
echo "Prefer Stop then Start (not overlapping Restart) so only one boot holds the schema lock."
echo "If boot fails on schema lock: node scripts/diagnose-migration-lock.mjs""
echo "Then verify:"
echo "  curl -sS https://api.zarewaglobalservices.com/api/health"
echo "  open https://erp.zarewaglobalservices.com"
