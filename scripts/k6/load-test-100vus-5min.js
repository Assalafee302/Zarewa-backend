/**
 * k6 load test — 100 VUs, 30s ramp, 5 minute total duration.
 *
 * Install k6: https://k6.io/docs/get-started/installation/
 *   Windows (choco): choco install k6
 *   macOS: brew install k6
 *
 * Start API first: npm run server
 *
 * Run from repo root:
 *   k6 run scripts/k6/load-test-100vus-5min.js
 *
 * Override:
 *   k6 run -e LOAD_BASE_URL=http://127.0.0.1:8787 -e LOAD_ENDPOINT=/api/bootstrap scripts/k6/load-test-100vus-5min.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE = (__ENV.LOAD_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const ENDPOINT = __ENV.LOAD_ENDPOINT || '/api/bootstrap';
const QUERY = String(__ENV.LOAD_QUERY || '').replace(/^\?/, '');
const USERNAME = __ENV.LOAD_USERNAME || 'admin';
const PASSWORD = __ENV.LOAD_PASSWORD || 'Admin@123';
const THINK_SEC = Number(__ENV.LOAD_THINK_SEC || 0);

const latency = new Trend('zarewa_request_duration', true);
const failRate = new Rate('zarewa_fail_rate');
const bytes = new Counter('zarewa_response_bytes');

export const options = {
  scenarios: {
    ramp_hold: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '4m30s', target: 100 },
        { duration: '0s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    zarewa_fail_rate: ['rate<0.05'],
    http_req_duration: ['p(95)<8000'],
  },
};

function targetUrl() {
  const path = ENDPOINT.startsWith('/') ? ENDPOINT : `/${ENDPOINT}`;
  return QUERY ? `${BASE}${path}?${QUERY}` : `${BASE}${path}`;
}

function needsAuth() {
  return ENDPOINT !== '/api/health' && !ENDPOINT.startsWith('/health');
}

export function setup() {
  const health = http.get(`${BASE}/api/health`);
  if (health.status !== 200) {
    throw new Error(`API health check failed: ${health.status} ${health.body}`);
  }
  if (!needsAuth()) return { cookie: '' };

  const loginRes = http.post(
    `${BASE}/api/session/login`,
    JSON.stringify({ username: USERNAME, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (loginRes.status !== 200) {
    throw new Error(`login failed: ${loginRes.status} ${loginRes.body}`);
  }
  const cookies = loginRes.cookies || {};
  const session = cookies.zarewa_session?.[0]?.value;
  const csrf = cookies.zarewa_csrf?.[0]?.value;
  if (!session) throw new Error('missing zarewa_session cookie after login');
  return { cookie: `zarewa_session=${session}; zarewa_csrf=${csrf || ''}` };
}

export default function (data) {
  const headers = {};
  if (needsAuth() && data.cookie) headers.Cookie = data.cookie;

  const res = http.get(targetUrl(), { headers, tags: { endpoint: ENDPOINT } });
  latency.add(res.timings.duration);
  bytes.add(res.body?.length || 0);

  const ok = check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  failRate.add(!ok);

  if (THINK_SEC > 0) sleep(THINK_SEC);
}
