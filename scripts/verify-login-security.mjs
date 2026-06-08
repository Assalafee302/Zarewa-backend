/**
 * Post-deploy smoke checks for Phase 12 login & session security.
 *
 * Usage:
 *   ZAREWA_VERIFY_API_ORIGIN=https://api.example.com node scripts/verify-login-security.mjs
 *
 * Optional successful-login check (use a dedicated smoke account, not production admin):
 *   ZAREWA_VERIFY_API_ORIGIN=https://api.example.com \
 *   ZAREWA_VERIFY_LOGIN_USER=smoke.user \
 *   ZAREWA_VERIFY_LOGIN_PASSWORD='Smoke@123456!' \
 *   node scripts/verify-login-security.mjs
 */
import process from 'node:process';

function normalizeOrigin(raw) {
  return String(raw || '').trim().replace(/\/$/, '');
}

const apiOrigin = normalizeOrigin(process.env.ZAREWA_VERIFY_API_ORIGIN);
const loginUser = String(process.env.ZAREWA_VERIFY_LOGIN_USER || '').trim();
const loginPassword = String(process.env.ZAREWA_VERIFY_LOGIN_PASSWORD || '');

if (!apiOrigin) {
  console.error(
    '[verify-login-security] Set ZAREWA_VERIFY_API_ORIGIN (no trailing slash), e.g.\n' +
      '  ZAREWA_VERIFY_API_ORIGIN=https://api.example.com node scripts/verify-login-security.mjs'
  );
  process.exit(1);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: String(text).slice(0, 300) };
  }
}

async function checkHealth() {
  const url = `${apiOrigin}/api/health`;
  console.log(`[verify-login-security] GET ${url}`);
  const res = await fetch(url);
  const json = await readJson(res);
  if (!res.ok || !json?.ok || json.service !== 'zarewa-api') {
    throw new Error(`Health check failed: status=${res.status} body=${JSON.stringify(json)}`);
  }
  console.log('[verify-login-security] OK: /api/health');
}

async function checkFirebaseRemoved() {
  const url = `${apiOrigin}/api/session/firebase`;
  console.log(`[verify-login-security] POST ${url} (Google SSO removed — expect 401 AUTH_REQUIRED)`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'smoke-test' }),
  });
  const json = await readJson(res);
  if (res.status === 401 && json?.code === 'AUTH_REQUIRED') {
    console.log('[verify-login-security] OK: Firebase route removed (falls through to requireAuth)');
    return;
  }
  if (res.status === 404) {
    console.log('[verify-login-security] OK: Firebase route not registered (404)');
    return;
  }
  if (json?.code === 'ID_TOKEN_REQUIRED' || json?.code === 'FIREBASE_NOT_CONFIGURED') {
    throw new Error(
      'Phase 12 not deployed: POST /api/session/firebase still handles Firebase tokens. ' +
        'Run git pull and restart the API on the server.'
    );
  }
  throw new Error(`Unexpected Firebase probe: status=${res.status} body=${JSON.stringify(json)}`);
}

async function checkSessionTimeoutEndpoint() {
  const url = `${apiOrigin}/api/session/timeout`;
  console.log(`[verify-login-security] POST ${url} (public inactivity logout)`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = await readJson(res);
  if (res.status !== 200 || json?.code !== 'SESSION_TIMEOUT') {
    throw new Error(`Session timeout endpoint failed: ${res.status} ${JSON.stringify(json)}`);
  }
  console.log('[verify-login-security] OK: /api/session/timeout');
}

async function checkFailedLogin() {
  const url = `${apiOrigin}/api/session/login`;
  console.log(`[verify-login-security] POST ${url} (bad credentials — expect 401)`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '__zarewa_smoke_invalid__', password: 'not-a-real-password' }),
  });
  const json = await readJson(res);
  if (res.status !== 401) {
    throw new Error(`Failed login should return 401, got ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json?.code !== 'INVALID_CREDENTIALS' && json?.code !== 'ACCOUNT_LOCKED') {
    throw new Error(`Failed login should return INVALID_CREDENTIALS, got ${JSON.stringify(json)}`);
  }
  console.log('[verify-login-security] OK: failed login returns 401', { code: json.code });
}

async function checkUnauthenticatedSession() {
  const url = `${apiOrigin}/api/session`;
  console.log(`[verify-login-security] GET ${url} (no cookie — expect 401)`);
  const res = await fetch(url);
  const json = await readJson(res);
  if (res.status !== 401 || json?.authenticated !== false) {
    throw new Error(`Unauthenticated session should return 401, got ${res.status}`);
  }
  console.log('[verify-login-security] OK: /api/session requires auth');
}

async function checkOptionalLogin() {
  if (!loginUser || !loginPassword) {
    console.log('[verify-login-security] Skipping successful login (set ZAREWA_VERIFY_LOGIN_USER/PASSWORD)');
    return;
  }
  const url = `${apiOrigin}/api/session/login`;
  console.log(`[verify-login-security] POST ${url} (smoke account)`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: loginUser, password: loginPassword }),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.ok) {
    throw new Error(`Smoke login failed: ${res.status} ${JSON.stringify(json)}`);
  }
  if (!json.sessionExpiresAtIso) {
    throw new Error('Login response missing sessionExpiresAtIso (Phase 12 session metadata)');
  }
  if (Number(json.sessionTimeoutMinutes) !== 15 && !process.env.SESSION_TIMEOUT_MINUTES) {
    console.warn('[verify-login-security] WARN: sessionTimeoutMinutes =', json.sessionTimeoutMinutes);
  }
  console.log('[verify-login-security] OK: login returns session expiry metadata', {
    sessionExpiresAtIso: json.sessionExpiresAtIso,
    sessionTimeoutMinutes: json.sessionTimeoutMinutes,
  });
}

async function main() {
  await checkHealth();
  await checkFirebaseRemoved();
  await checkFailedLogin();
  await checkSessionTimeoutEndpoint();
  await checkUnauthenticatedSession();
  await checkOptionalLogin();
  console.log('\n[verify-login-security] All automated checks passed.');
}

main().catch((e) => {
  console.error('[verify-login-security] FAIL:', e.message || e);
  process.exit(1);
});
