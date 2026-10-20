#!/bin/bash
# Run ON THE HOSTINGER SERVER (interactive). Sets ZAREWA_MYSQL_PASSWORD in the backend's .env (and .env.local if it
# defines it, because .env.local overrides .env). The new password is read silently and never printed.
# Backs up each file first (chmod 600). Usage: bash server-set-db-password.sh
set -euo pipefail
BACKEND="${BACKEND:-$HOME/domains/api.zarewaglobalservices.com}"
[[ -f "$BACKEND/server/index.js" ]] || BACKEND="$BACKEND/public_html"
[[ -f "$BACKEND/server/index.js" ]] || { echo "Backend not found under ~/domains/api.zarewaglobalservices.com"; exit 1; }
cd "$BACKEND"
echo "Backend: $BACKEND"
read -r -s -p "New DB password (input hidden): " P1; echo
read -r -s -p "Type it again: " P2; echo
[[ -n "$P1" && "$P1" == "$P2" ]] || { echo "Empty or not matching — nothing changed."; exit 1; }
# The app reads .env with Node's process.loadEnvFile and .env.local with its own parser: both take a value wrapped in
# ' or " literally, with no escapes. So wrap in a quote mark the password does not contain.
if [[ "$P1" != *"'"* ]]; then Q="'"; elif [[ "$P1" != *'"'* ]]; then Q='"'; else
  echo "Password contains both ' and \" — the .env format cannot hold it. Choose another; nothing changed."; exit 1; fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
changed=0
for f in .env .env.local; do
  [[ -f "$f" ]] || continue
  if grep -qE '^\s*ZAREWA_MYSQL_PASSWORD=' "$f" || [[ "$f" == ".env" ]]; then
    cp -p "$f" "$f.bak-$stamp"; chmod 600 "$f.bak-$stamp"
    tmp="$(mktemp)"; chmod 600 "$tmp"
    # Drop the old live line, append the new one (value quoted; no shell expansion).
    grep -vE '^\s*ZAREWA_MYSQL_PASSWORD=' "$f" > "$tmp" || true
    printf 'ZAREWA_MYSQL_PASSWORD=%s%s%s\n' "$Q" "$P1" "$Q" >> "$tmp"
    cat "$tmp" > "$f"; rm -f "$tmp"; chmod 600 "$f"
    echo "Updated $f (backup $f.bak-$stamp)"; changed=1
  fi
done
unset P1 P2
[[ $changed == 1 ]] || { echo "No .env found — nothing changed."; exit 1; }
echo "Other DB settings now in effect (password not shown):"
grep -hE '^\s*ZAREWA_MYSQL_(HOST|PORT|USER|DATABASE)=' .env .env.local 2>/dev/null | sed 's/^/  /'
echo "Done. Next: stop the Node app in hPanel, wait until stopped, then Start."
