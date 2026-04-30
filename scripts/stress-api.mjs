/**
 * Harder API stress: many writes, concurrent reads, bootstrap hammering.
 * Run with API up: npm run server
 *   node scripts/stress-api.mjs
 * Optional: STRESS_BASE_URL=http://127.0.0.1:8787 STRESS_WRITES=5000 node scripts/stress-api.mjs
 *
 * For 50 linked business scenarios (customer → quote → receipt → coil → production → finance),
 * use `npm run stress:lifecycle` (scripts/fifty-lifecycle-stress.mjs).
 */
const base = (process.env.STRESS_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WRITE_COUNT = Math.min(20_000, Math.max(100, Number(process.env.STRESS_WRITES) || 3500));
const BOOTSTRAP_CONCURRENT = Math.min(500, Math.max(10, Number(process.env.STRESS_BOOTSTRAP_CONCURRENT) || 180));
const CUSTOMERS_CONCURRENT = Math.min(200, Math.max(10, Number(process.env.STRESS_CUSTOMERS_CONCURRENT) || 80));

function statsFromTimes(ms) {
  if (!ms.length) return { n: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
    p99_ms: pct(0.99),
    max_ms: s[s.length - 1],
  };
}

async function login() {
  const r = await fetch(`${base}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
  });
  if (!r.ok) throw new Error(`login ${r.status} ${await r.text()}`);
  const setCookie = r.headers.get('set-cookie') || '';
  const sessionCookie = (setCookie.match(/zarewa_session=[^;]+/) || [''])[0];
  const csrfCookie = (setCookie.match(/zarewa_csrf=[^;]+/) || [''])[0];
  const cookie = [sessionCookie, csrfCookie].filter(Boolean).join('; ');
  const csrfToken = (csrfCookie.split('=')[1] || '').trim();
  if (!sessionCookie) throw new Error('no session cookie');
  if (!csrfToken) throw new Error('no csrf token');
  return { cookie, csrfToken };
}

async function main() {
  const tAll = Date.now();
  console.log(`Stress target: ${base}, writes=${WRITE_COUNT}, bootstrapConcurrent=${BOOTSTRAP_CONCURRENT}`);

  const { cookie, csrfToken } = await login();

  const writeTimes = [];
  let writeFail = 0;
  const tWrites = Date.now();
  const runSuffix = String(Date.now() % 100000).padStart(5, '0');
  for (let i = 0; i < WRITE_COUNT; i++) {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        customerID: `STR-${Date.now()}-${i}`,
        name: `Stress Customer ${i}`,
        // Keep last-10 digits unique across reruns (duplicate checks normalize to last 10 digits).
        phoneNumber: `+234${runSuffix}${String(i).padStart(5, '0')}`,
        email: `stress.${runSuffix}.${i}@example.test`,
        addressShipping: `Plot ${i} stress road`,
        addressBilling: `Plot ${i} stress road`,
        status: 'Active',
        tier: i % 6 === 0 ? 'Gold' : 'Regular',
        paymentTerms: 'Due on receipt',
        createdBy: 'stress',
        companyName: `Co ${i % 50}`,
        leadSource: 'Stress',
        preferredContact: 'Phone',
        crmTags: ['stress'],
        crmProfileNotes: `row ${i}`,
      }),
    });
    writeTimes.push(Date.now() - t0);
    if (!r.ok) {
      writeFail++;
      if (writeFail <= 5) console.error('write fail', r.status, (await r.text()).slice(0, 120));
    }
  }
  console.log(
    JSON.stringify(
      {
        phase: 'sequential_customer_inserts',
        count: WRITE_COUNT,
        ok: WRITE_COUNT - writeFail,
        fail: writeFail,
        duration_ms: Date.now() - tWrites,
        rps: Math.round(WRITE_COUNT / ((Date.now() - tWrites) / 1000)),
        timings_ms: statsFromTimes(writeTimes),
      },
      null,
      2
    )
  );

  const bootTimes = [];
  let bootFail = 0;
  const tBoot = Date.now();
  const bootReqs = Array.from({ length: BOOTSTRAP_CONCURRENT }, async () => {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } });
    bootTimes.push(Date.now() - t0);
    if (!r.ok) bootFail++;
  });
  await Promise.all(bootReqs);
  console.log(
    JSON.stringify(
      {
        phase: 'concurrent_bootstrap',
        concurrent: BOOTSTRAP_CONCURRENT,
        ok: BOOTSTRAP_CONCURRENT - bootFail,
        fail: bootFail,
        batch_ms: Date.now() - tBoot,
        timings_ms: statsFromTimes(bootTimes),
      },
      null,
      2
    )
  );

  const listTimes = [];
  let listFail = 0;
  const tList = Date.now();
  const listReqs = Array.from({ length: CUSTOMERS_CONCURRENT }, async () => {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/customers`, { headers: { Cookie: cookie } });
    listTimes.push(Date.now() - t0);
    if (!r.ok) listFail++;
  });
  await Promise.all(listReqs);
  console.log(
    JSON.stringify(
      {
        phase: 'concurrent_customers_list',
        concurrent: CUSTOMERS_CONCURRENT,
        ok: CUSTOMERS_CONCURRENT - listFail,
        fail: listFail,
        batch_ms: Date.now() - tList,
        timings_ms: statsFromTimes(listTimes),
      },
      null,
      2
    )
  );

  console.log(JSON.stringify({ phase: 'total', total_ms: Date.now() - tAll }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
