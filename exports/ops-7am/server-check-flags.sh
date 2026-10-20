#!/bin/bash
# Run ON THE HOSTINGER SERVER. Read-only. Reports whether anything can make a restart reset the seeded users
# (ZAREWA_ALLOW_SEEDED_USERS=1/true, ZAREWA_LOCAL_XAMPP=1, NODE_ENV=test) and the dual-control flags — in .env,
# .env.local and the running Node process environment (hPanel variables). Values of secrets are never printed.
BACKEND="${BACKEND:-$HOME/domains/api.zarewaglobalservices.com}"
[[ -f "$BACKEND/server/index.js" ]] || BACKEND="$BACKEND/public_html"
cd "$BACKEND" || exit 1
KEYS='ZAREWA_ALLOW_SEEDED_USERS|ZAREWA_LOCAL_XAMPP|NODE_ENV|ENFORCE_DUAL_CONTROL_PAYMENTS|STRICT_CASHIER_RBAC'
echo "== files"
for f in .env .env.local; do
  [[ -f "$f" ]] && grep -nE "^\s*#?\s*($KEYS)=" "$f" | sed "s/^/  $f:/" || true
done
echo "== running node processes (environment)"
for pid in $(pgrep -u "$(id -u)" -f 'server/index.js' 2>/dev/null); do
  echo "  pid $pid"
  if [[ -r /proc/$pid/environ ]]; then
    tr '\0' '\n' < /proc/$pid/environ | grep -E "^($KEYS)=" | sed 's/^/    /' || echo "    (none of the keys set)"
  else
    echo "    environ not readable"
  fi
done
echo "Seeded-user reset is OFF when ZAREWA_ALLOW_SEEDED_USERS is not 1/true, ZAREWA_LOCAL_XAMPP is not 1 and NODE_ENV is not test."
