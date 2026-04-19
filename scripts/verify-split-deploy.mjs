/**
 * Post-deploy smoke checks for split UI + API.
 *
 * Usage (after API is reachable):
 *   ZAREWA_VERIFY_API_ORIGIN=https://api.example.com node scripts/verify-split-deploy.mjs
 *
 * Optional CORS check (browser would send this Origin):
 *   ZAREWA_VERIFY_API_ORIGIN=https://api.example.com \
 *   ZAREWA_VERIFY_UI_ORIGIN=https://app.example.com \
 *   node scripts/verify-split-deploy.mjs
 */
import process from 'node:process';

function normalizeOrigin(raw) {
  const s = String(raw || '').trim().replace(/\/$/, '');
  return s || '';
}

const apiOrigin = normalizeOrigin(process.env.ZAREWA_VERIFY_API_ORIGIN);
const uiOrigin = normalizeOrigin(process.env.ZAREWA_VERIFY_UI_ORIGIN);

if (!apiOrigin) {
  console.error(
    '[verify-split-deploy] Set ZAREWA_VERIFY_API_ORIGIN to your public API base URL (no trailing slash), e.g.\n' +
      '  ZAREWA_VERIFY_API_ORIGIN=https://api.example.com node scripts/verify-split-deploy.mjs'
  );
  process.exit(1);
}

async function main() {
  const healthUrl = `${apiOrigin}/api/health`;
  console.log(`[verify-split-deploy] GET ${healthUrl}`);
  const res = await fetch(healthUrl, { method: 'GET' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    console.error('[verify-split-deploy] Response was not JSON:', String(text).slice(0, 200));
    process.exit(1);
  }
  if (!res.ok || !json?.ok || json.service !== 'zarewa-api') {
    console.error('[verify-split-deploy] Unexpected /api/health payload:', json);
    process.exit(1);
  }
  console.log('[verify-split-deploy] OK: /api/health', { time: json.time, capabilities: json.capabilities });

  if (uiOrigin) {
    const preUrl = `${apiOrigin}/api/health`;
    console.log(`[verify-split-deploy] OPTIONS ${preUrl} (Origin: ${uiOrigin})`);
    const pre = await fetch(preUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: uiOrigin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    const allow = pre.headers.get('access-control-allow-origin');
    if (!allow) {
      console.error(
        '[verify-split-deploy] CORS: missing Access-Control-Allow-Origin on OPTIONS. Set CORS_ORIGIN to include:',
        uiOrigin
      );
      process.exit(1);
    }
    if (allow !== uiOrigin && allow !== '*') {
      console.warn('[verify-split-deploy] CORS: allow-origin is', allow, '(expected exact', uiOrigin + ')');
    } else {
      console.log('[verify-split-deploy] OK: CORS preflight allow-origin =', allow);
    }
  } else {
    console.log(
      '[verify-split-deploy] Skipping CORS OPTIONS (set ZAREWA_VERIFY_UI_ORIGIN to your SPA origin to test)'
    );
  }

  console.log(
    '\n[verify-split-deploy] Automated checks passed. Still run the manual checklist in docs/SPLIT_DEPLOYMENT_AND_MIGRATION.md (login, POST, downloads).'
  );
}

main().catch((e) => {
  console.error('[verify-split-deploy]', e);
  process.exit(1);
});
