/**
 * Quick benchmark for GET /api/dashboard/summary.
 *
 * Usage:
 *   node scripts/bench-dashboard-summary.mjs
 *
 * Env:
 *   BENCH_BASE=http://localhost:3001
 *   BENCH_USER=admin
 *   BENCH_PASS=Admin@123
 *   BENCH_CONCURRENCY=50
 *   BENCH_REQUESTS=200
 */

const BASE = process.env.BENCH_BASE || 'http://localhost:3001';
const USER = process.env.BENCH_USER || 'admin';
const PASS = process.env.BENCH_PASS || 'Admin@123';
const CONCURRENCY = Math.max(1, Number(process.env.BENCH_CONCURRENCY || 50));
const REQUESTS = Math.max(1, Number(process.env.BENCH_REQUESTS || 200));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function parseSetCookie(setCookieHeaders, name) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  const row = list.find((c) => String(c).startsWith(`${name}=`));
  if (!row) return '';
  return String(row).split(';')[0];
}

async function login() {
  const r = await fetch(`${BASE}/api/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`login failed: ${r.status} ${text}`);
  const cookies = r.headers.getSetCookie?.() || r.headers.raw?.()['set-cookie'] || [];
  const session = parseSetCookie(cookies, 'zarewa_session');
  const csrf = parseSetCookie(cookies, 'zarewa_csrf');
  if (!session || !csrf) throw new Error('login missing cookies');
  return { cookie: `${session}; ${csrf}` };
}

async function one(cookie, etag) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/dashboard/summary`, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
  });
  const t1 = performance.now();
  const ms = t1 - t0;
  const nextEtag = r.headers.get('etag') || etag || '';
  if (r.status !== 200 && r.status !== 304) {
    const body = await r.text().catch(() => '');
    throw new Error(`summary bad status=${r.status} body=${body.slice(0, 200)}`);
  }
  return { ms, etag: nextEtag, status: r.status };
}

async function main() {
  const { cookie } = await login();
  let etag = '';
  const times = [];
  const statuses = { 200: 0, 304: 0 };

  const queue = Array.from({ length: REQUESTS }, (_, i) => i);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      queue.pop();
      const r = await one(cookie, etag);
      etag = r.etag || etag;
      times.push(r.ms);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
  });
  await Promise.all(workers);

  const sorted = times.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  console.log(
    JSON.stringify(
      {
        endpoint: '/api/dashboard/summary',
        base: BASE,
        requests: REQUESTS,
        concurrency: CONCURRENCY,
        statuses,
        ms: {
          min: sorted[0],
          p50: pct(sorted, 50),
          p95: pct(sorted, 95),
          p99: pct(sorted, 99),
          max: sorted[sorted.length - 1],
          avg,
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

