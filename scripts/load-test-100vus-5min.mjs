#!/usr/bin/env node
/**
 * Load test: ramp to 100 concurrent virtual users over 30s, hold for 5 minutes total.
 *
 * Prerequisites:
 *   npm run server   (API listening, default http://127.0.0.1:8787)
 *
 * Run:
 *   node scripts/load-test-100vus-5min.mjs
 *   npm run stress:load-100
 *
 * Environment:
 *   LOAD_BASE_URL=http://127.0.0.1:8787
 *   LOAD_ENDPOINT=/api/bootstrap          (default; also try /api/health, /api/dashboard/summary)
 *   LOAD_VUS=100
 *   LOAD_RAMP_SEC=30
 *   LOAD_DURATION_SEC=300                 (total wall time including ramp)
 *   LOAD_USERNAME=admin
 *   LOAD_PASSWORD=Admin@123
 *   LOAD_QUERY=poll=1                     (optional query string, e.g. poll=1 or mode=dashboard)
 *   LOAD_THINK_MS=0                       (pause between requests per VU)
 *   LOAD_REPORT=scripts/output/load-100vus-report.json
 *
 * Tip: use a dedicated DB for stress runs (see docs/STRESS-DEDICATED-DB.md).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = (process.env.LOAD_BASE_URL || process.env.STRESS_BASE_URL || 'http://127.0.0.1:8787').replace(
  /\/$/,
  ''
);
const ENDPOINT = process.env.LOAD_ENDPOINT || '/api/bootstrap';
const QUERY = String(process.env.LOAD_QUERY || '').replace(/^\?/, '');
const VUS = Math.max(1, Math.min(500, Number(process.env.LOAD_VUS) || 100));
const RAMP_SEC = Math.max(1, Math.min(600, Number(process.env.LOAD_RAMP_SEC) || 30));
const DURATION_SEC = Math.max(RAMP_SEC + 1, Math.min(3600, Number(process.env.LOAD_DURATION_SEC) || 300));
const THINK_MS = Math.max(0, Math.min(10_000, Number(process.env.LOAD_THINK_MS) || 0));
const USER_POOL = String(process.env.LOAD_USER_POOL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [username, password] = entry.split(':');
    return { username: username?.trim(), password: password?.trim() };
  })
  .filter((u) => u.username && u.password);

const DEFAULT_USER_POOL = [
  { username: 'admin', password: 'Admin@123' },
  { username: 'md', password: 'Md@1234567890!' },
  { username: 'finance.manager', password: 'Finance@123' },
  { username: 'cashier', password: 'Cashier@12345!' },
  { username: 'sales.manager', password: 'Sales@123' },
  { username: 'sales.staff', password: 'Sales@123' },
  { username: 'operations', password: 'Ops@123' },
  { username: 'ceo', password: 'Ceo@1234567890!' },
  { username: 'viewer', password: 'Viewer@123456!' },
];
const REPORT_PATH =
  process.env.LOAD_REPORT || join(__dirname, 'output', 'load-100vus-report.json');

const RAMP_MS = RAMP_SEC * 1000;
const DURATION_MS = DURATION_SEC * 1000;

function endpointUrl() {
  const path = ENDPOINT.startsWith('/') ? ENDPOINT : `/${ENDPOINT}`;
  return QUERY ? `${BASE}${path}?${QUERY}` : `${BASE}${path}`;
}

function statsFromTimes(ms) {
  if (!ms.length) return { n: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean_ms: Math.round(sum / s.length),
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    p99_ms: pick(0.99),
    max_ms: s[s.length - 1],
  };
}

async function login(credentials = null) {
  const user = credentials?.username || process.env.LOAD_USERNAME || process.env.STRESS_USERNAME || 'admin';
  const pass =
    credentials?.password || process.env.LOAD_PASSWORD || process.env.STRESS_PASSWORD || 'Admin@123';
  const r = await fetchWithTimeout(`${BASE}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`login ${r.status} ${await r.text()}`);
  const rawCookies = r.headers.getSetCookie?.() || [];
  const cookieParts =
    rawCookies.length > 0
      ? rawCookies.map((c) => String(c).split(';')[0]).filter(Boolean)
      : String(r.headers.get('set-cookie') || '')
          .split(/,(?=\s*zarewa_)/)
          .map((c) => c.trim().split(';')[0])
          .filter(Boolean);
  const cookie = cookieParts.join('; ');
  if (!cookie.includes('zarewa_session=')) throw new Error('login: missing zarewa_session cookie');
  return { cookie, username: user };
}

async function buildSessionPool() {
  const pool = USER_POOL.length ? USER_POOL : DEFAULT_USER_POOL;
  const sessions = [];
  for (const cred of pool) {
    sessions.push(await login(cred));
  }
  console.log(JSON.stringify({ phase: 'session_pool', users: sessions.length }, null, 2));
  return sessions;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function needsAuth() {
  return ENDPOINT !== '/api/health' && !ENDPOINT.startsWith('/health');
}

async function oneRequest(session) {
  const t0 = Date.now();
  const headers = {};
  if (needsAuth() && session?.cookie) headers.Cookie = session.cookie;
  const r = await fetchWithTimeout(endpointUrl(), { headers }, 180_000);
  const body = await r.text();
  return {
    ok: r.ok,
    status: r.status,
    ms: Date.now() - t0,
    bytes: body.length,
  };
}

async function virtualUser(vuId, session, startedAt, endAt, telemetry) {
  while (Date.now() < endAt) {
    try {
      const r = await oneRequest(session);
      telemetry.times.push(r.ms);
      telemetry.status[r.status] = (telemetry.status[r.status] || 0) + 1;
      if (r.ok) telemetry.ok += 1;
      else {
        telemetry.fail += 1;
        if (telemetry.errorSamples.length < 8) {
          telemetry.errorSamples.push({ vuId, status: r.status, at: new Date().toISOString() });
        }
      }
      telemetry.bytes += r.bytes;
    } catch (e) {
      telemetry.fail += 1;
      telemetry.times.push(Date.now() - (Date.now() - 1));
      if (telemetry.errorSamples.length < 8) {
        telemetry.errorSamples.push({ vuId, error: String(e?.message || e) });
      }
    }
    if (THINK_MS > 0) await new Promise((resolve) => setTimeout(resolve, THINK_MS));
    if (Date.now() - startedAt < RAMP_MS) {
      // During ramp, new VUs join; existing VUs keep firing — no extra delay.
    }
  }
}

async function waitForHealth() {
  const url = `${BASE}/api/health`;
  for (let i = 0; i < 30; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`API not reachable at ${url} — start with: npm run server`);
}

async function main() {
  const tStart = Date.now();
  const endAt = tStart + DURATION_MS;
  const url = endpointUrl();

  console.log(
    JSON.stringify(
      {
        phase: 'config',
        target: url,
        vus: VUS,
        ramp_sec: RAMP_SEC,
        duration_sec: DURATION_SEC,
        think_ms: THINK_MS,
        auth: needsAuth(),
      },
      null,
      2
    )
  );

  await waitForHealth();

  const sessionPool = needsAuth() ? await buildSessionPool() : [];

  const telemetry = {
    times: [],
    ok: 0,
    fail: 0,
    bytes: 0,
    status: {},
    errorSamples: [],
    vuStartedAt: [],
  };

  /** @type {Promise<void>[]} */
  const workers = [];

  const rampIntervalMs = Math.max(50, Math.floor(RAMP_MS / VUS));

  for (let vu = 0; vu < VUS; vu += 1) {
    const delayMs = vu * rampIntervalMs;
    workers.push(
      (async () => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const vuStart = Date.now();
        telemetry.vuStartedAt.push({ vu: vu + 1, at_ms: vuStart - tStart });
        const session = sessionPool.length ? sessionPool[vu % sessionPool.length] : null;
        await virtualUser(vu + 1, session, vuStart, endAt, telemetry);
      })()
    );
  }

  await Promise.all(workers);

  const elapsedMs = Date.now() - tStart;
  const rps = telemetry.times.length / (elapsedMs / 1000);
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      base: BASE,
      endpoint: ENDPOINT,
      query: QUERY || null,
      vus: VUS,
      ramp_sec: RAMP_SEC,
      duration_sec: DURATION_SEC,
      think_ms: THINK_MS,
    },
    summary: {
      total_requests: telemetry.times.length,
      ok: telemetry.ok,
      fail: telemetry.fail,
      error_rate_pct: telemetry.times.length
        ? Math.round((telemetry.fail / telemetry.times.length) * 1000) / 10
        : 0,
      elapsed_ms: elapsedMs,
      rps: Math.round(rps * 10) / 10,
      bytes_total: telemetry.bytes,
      status_codes: telemetry.status,
      timings_ms: statsFromTimes(telemetry.times),
      error_samples: telemetry.errorSamples,
      vu_ramp: telemetry.vuStartedAt.slice(0, 5).concat(
        telemetry.vuStartedAt.length > 10
          ? [{ note: `…${telemetry.vuStartedAt.length - 10} more…` }]
          : [],
        telemetry.vuStartedAt.slice(-5)
      ),
    },
  };

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify({ phase: 'done', reportPath: REPORT_PATH, summary: report.summary }, null, 2));
  if (telemetry.fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
