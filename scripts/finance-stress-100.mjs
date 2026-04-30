#!/usr/bin/env node
/**
 * FIN100: Finance stress & performance test (100 live-ish scenarios).
 *
 * What it does:
 * - Phase A: generate 100 finance scenarios (customers + optional quote, receipts, advances, refunds,
 *   internal transfers, expenses, payment-requests, payable creation) while timing each API call.
 * - Phase B: ramp concurrency on key finance reads/writes to find breaking point.
 *
 * Prerequisites: API server running (e.g. npm run server).
 *
 * Usage:
 *   node scripts/finance-stress-100.mjs
 *
 * Env knobs:
 * - STRESS_API_URL=http://127.0.0.1:8787
 * - STRESS_UI_URL=http://127.0.0.1:5173 (links in report only)
 * - STRESS_FROM=0 STRESS_TO=99 (subset)
 * - STRESS_SCALE_AMOUNTS=1.0 (multiplies all amounts)
 * - STRESS_RAMP=1 (enable ramp), STRESS_RAMP_STEPS=6, STRESS_RAMP_START=10, STRESS_RAMP_MULT=2
 * - STRESS_RAMP_TARGETS=bootstrap,customers,ledger,finance (comma separated)
 *
 * Output:
 * - scripts/output/finance-100-report.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFinanceScenarios, FINANCE_SCENARIO_COUNT } from './data/hundredFinanceScenarios.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = (process.env.STRESS_API_URL || process.env.STRESS_BASE_URL || 'http://127.0.0.1:8787').replace(
  /\/$/,
  ''
);
const UI_BASE = (process.env.STRESS_UI_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const FROM = Math.max(0, Math.min(FINANCE_SCENARIO_COUNT - 1, Number(process.env.STRESS_FROM) || 0));
const TO_RAW = process.env.STRESS_TO;
const TO = Math.max(
  FROM,
  Math.min(FINANCE_SCENARIO_COUNT - 1, TO_RAW !== undefined && TO_RAW !== '' ? Number(TO_RAW) : FINANCE_SCENARIO_COUNT - 1)
);
const SCALE = Math.max(0.01, Math.min(50, Number(process.env.STRESS_SCALE_AMOUNTS) || 1));

const RAMP_ENABLED = process.env.STRESS_RAMP === '1' || process.env.STRESS_RAMP === 'true';
const RAMP_STEPS = Math.max(1, Math.min(12, Number(process.env.STRESS_RAMP_STEPS) || 6));
const RAMP_START = Math.max(1, Math.min(2000, Number(process.env.STRESS_RAMP_START) || 10));
const RAMP_MULT = Math.max(1.1, Math.min(8, Number(process.env.STRESS_RAMP_MULT) || 2));
const RAMP_TARGETS = String(process.env.STRESS_RAMP_TARGETS || 'bootstrap,customers,ledger,finance')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function hashToInt(value) {
  let h = 0;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function statsFromTimes(ms) {
  if (!ms.length) return { n: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    p99_ms: pick(0.99),
    max_ms: s[s.length - 1],
    mean_ms: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const RUN_KEY_RAW = process.env.STRESS_RUN_KEY || `FIN100RUN-${Date.now().toString(36)}`;
const RUN_KEY = String(RUN_KEY_RAW).replace(/[^A-Za-z0-9_-]/g, '');
const RUN_PHONE_SUFFIX = String(hashToInt(RUN_KEY) % 100000).padStart(5, '0');

async function login() {
  const r = await fetch(`${API_BASE}/api/session/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.STRESS_USERNAME || 'admin',
      password: process.env.STRESS_PASSWORD || 'Admin@123',
    }),
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

async function api(path, { method = 'GET', sessionCookie, csrfToken, body, timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const isWrite = String(method || 'GET').toUpperCase() !== 'GET';
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        ...(isWrite && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { _raw: text };
    }
    return { ok: r.ok, status: r.status, data, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message || e) }, ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

function linkForCustomer(customerID) {
  return `${UI_BASE}/customers/${encodeURIComponent(customerID)}`;
}

function scaled(n) {
  return Math.round((Number(n) || 0) * SCALE);
}

async function ensureFinancePrereqs(session) {
  const boot = await api('/api/bootstrap', { sessionCookie: session.cookie, csrfToken: session.csrfToken });
  if (!boot.ok) throw new Error(`bootstrap: ${boot.status} ${JSON.stringify(boot.data).slice(0, 300)}`);
  const accounts = boot.data?.treasuryAccounts || [];
  if (!accounts.length) throw new Error('no treasury accounts in bootstrap');
  return { boot, accounts };
}

async function runScenario(session, scenario, telemetry) {
  const n = scenario.index;
  const slug = scenario.slug;
  const customerID = `${RUN_KEY}-C-${slug}`;
  // Identity dedupe uses normalized "last 10 digits", so embed the run key in those digits.
  const phoneDigits = `${RUN_PHONE_SUFFIX}${String(n).padStart(5, '0')}`; // 10 digits total
  const phoneNumber = `+234${phoneDigits}`;
  const email = `fin100.${RUN_KEY}.${slug.toLowerCase()}@stress.zarewa.test`;

  const ids = {
    customerID,
    quotationId: null,
    receiptLedgerEntryId: null,
    refundId: null,
    expenseId: `EXP-${RUN_KEY}-${slug}`,
    paymentRequestId: `PREQ-${RUN_KEY}-${slug}`,
    apId: `AP-${RUN_KEY}-${slug}`,
  };

  const row = {
    slug,
    ok: true,
    errors: [],
    ids,
    links: { ui: { customer: linkForCustomer(customerID), finance: `${UI_BASE}/accounts` } },
    amounts: {
      invoiceNgn: scaled(scenario.invoiceNgn),
      receiptNgn: scaled(scenario.receiptNgn),
      advanceNgn: scaled(scenario.advanceNgn),
      refundNgn: scaled(scenario.refundNgn),
      expenseNgn: scaled(scenario.expenseNgn),
      payableNgn: scaled(scenario.payableNgn),
    },
  };

  const fail = (step, err) => {
    row.ok = false;
    row.errors.push({ step, error: String(err?.message || err) });
  };

  const call = async (name, path, opts) => {
    const r = await api(path, { sessionCookie: session.cookie, csrfToken: session.csrfToken, ...opts });
    if (!telemetry.calls[name]) telemetry.calls[name] = { ok: 0, fail: 0, times_ms: [], samples: [] };
    telemetry.calls[name].times_ms.push(r.ms);
    if (r.ok) telemetry.calls[name].ok += 1;
    else {
      telemetry.calls[name].fail += 1;
      if (telemetry.calls[name].samples.length < 5) {
        telemetry.calls[name].samples.push({ status: r.status, data: r.data });
      }
    }
    return r;
  };

  try {
    // Step 1: create customer
    const c = await call('customers.create', '/api/customers', {
      method: 'POST',
      body: {
        customerID,
        name: scenario.customerName,
        phoneNumber,
        email,
        addressShipping: `${scenario.city} — ${scenario.project}`,
        addressBilling: scenario.city,
        status: 'Active',
        tier: n % 3 === 0 ? 'Wholesale' : 'Regular',
        paymentTerms: n % 2 === 0 ? 'Net 30' : 'Due on receipt',
        createdBy: 'Stress FIN100',
        companyName: `${scenario.customerName} Ltd`,
        leadSource: 'FIN100',
        preferredContact: 'Phone',
        crmTags: ['fin100', slug],
        crmProfileNotes: scenario.label,
      },
    });
    if (!c.ok) throw new Error(`customer: ${c.status} ${JSON.stringify(c.data).slice(0, 300)}`);

    // We rely on existing products/master-data, so only create a quotation when receipt references it.
    if (row.amounts.invoiceNgn > 0) {
      const q = await call('quotations.create', '/api/quotations', {
        method: 'POST',
        body: {
          customerID,
          projectName: scenario.project,
          dateISO: scenario.dateISO,
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: String(row.amounts.invoiceNgn) }],
            accessories: [],
            services: [],
          },
        },
      });
      if (q.ok && q.data?.quotationId) {
        ids.quotationId = q.data.quotationId;
        await call('quotations.approve', `/api/quotations/${encodeURIComponent(ids.quotationId)}`, {
          method: 'PATCH',
          body: { status: 'Approved', customerFeedback: `FIN100 approved ${slug}` },
        });
      } else {
        // Quotation isn't strictly required for treasury movements, but receipts endpoint expects it.
        throw new Error(`quotation: ${q.status} ${JSON.stringify(q.data).slice(0, 300)}`);
      }
    }

    const { accounts } = await ensureFinancePrereqs(session);
    const a0 = accounts[0];
    const a1 = accounts[1];

    // Step 2: optional advance deposit (ledger + treasury inflow)
    if (scenario.doAdvance && row.amounts.advanceNgn > 0) {
      const body = {
        customerID,
        customerName: scenario.customerName,
        amountNgn: row.amounts.advanceNgn,
        paymentMethod: scenario.advanceMethod,
        dateISO: scenario.dateISO,
        bankReference: `FIN100-ADV-${RUN_KEY}-${slug}`,
        purpose: `Advance deposit ${slug}`,
        paymentLines: [
          {
            treasuryAccountId: a0.id,
            amountNgn: row.amounts.advanceNgn,
            reference: `FIN100-ADV-${RUN_KEY}-${slug}`,
          },
        ],
      };
      const adv = await call('ledger.advance', '/api/ledger/advance', { method: 'POST', body });
      if (!adv.ok) throw new Error(`advance: ${adv.status} ${JSON.stringify(adv.data).slice(0, 300)}`);
    }

    // Step 3: receipt against quotation (ledger + treasury inflow), possibly split lines
    if (row.amounts.receiptNgn > 0 && ids.quotationId) {
      const pay = row.amounts.receiptNgn;
      const lines =
        a1 && n % 4 === 0
          ? (() => {
              const p1 = Math.floor(pay * 0.55);
              return [
                { treasuryAccountId: a0.id, amountNgn: p1, reference: `FIN100-RCP-A-${RUN_KEY}-${slug}` },
                { treasuryAccountId: a1.id, amountNgn: pay - p1, reference: `FIN100-RCP-B-${RUN_KEY}-${slug}` },
              ];
            })()
          : [{ treasuryAccountId: a0.id, amountNgn: pay, reference: `FIN100-RCP-${RUN_KEY}-${slug}` }];

      const rec = await call('ledger.receipt', '/api/ledger/receipt', {
        method: 'POST',
        body: {
          customerID,
          quotationId: ids.quotationId,
          amountNgn: pay,
          paymentMethod: scenario.receiptMethod,
          dateISO: scenario.dateISO,
          bankReference: `FIN100-RCP-${RUN_KEY}-${slug}`,
          paymentLines: lines,
        },
      });
      if (!rec.ok) throw new Error(`receipt: ${rec.status} ${JSON.stringify(rec.data).slice(0, 300)}`);
      ids.receiptLedgerEntryId = rec.data?.ledgerEntry?.id || rec.data?.ledgerEntryId || null;
    }

    // Step 4: refund request/approve/pay (treasury outflow)
    if (scenario.doRefund && row.amounts.refundNgn > 0 && ids.quotationId) {
      const refundID = `RF-${RUN_KEY}-${slug}`;
      const rf = await call('refunds.request', '/api/refunds', {
        method: 'POST',
        body: {
          customerID,
          customer: scenario.customerName,
          quotationRef: ids.quotationId,
          refundID,
          reasonCategory: 'Goodwill adjustment',
          reason: `FIN100 partial reversal ${slug}`,
          amountNgn: row.amounts.refundNgn,
          calculationLines: [{ label: 'Stress reversal', amountNgn: row.amounts.refundNgn }],
        },
      });
      if (rf.ok && rf.data?.refundID) {
        ids.refundId = rf.data.refundID;
        await call('refunds.approve', `/api/refunds/${encodeURIComponent(ids.refundId)}/decision`, {
          method: 'POST',
          body: {
            status: 'Approved',
            approvalDate: scenario.dateISO,
            managerComments: 'FIN100 approved',
            approvedAmountNgn: row.amounts.refundNgn,
          },
        });
        const payBody =
          a1 && n % 3 === 0
            ? (() => {
                const p1 = Math.floor(row.amounts.refundNgn * 0.6);
                return {
                  paymentNote: `FIN100 staged payout ${RUN_KEY}-${slug}`,
                  paymentLines: [
                    { treasuryAccountId: a0.id, amountNgn: p1, reference: `FIN100-RFD-1-${RUN_KEY}-${slug}` },
                    { treasuryAccountId: a1.id, amountNgn: row.amounts.refundNgn - p1, reference: `FIN100-RFD-2-${RUN_KEY}-${slug}` },
                  ],
                };
              })()
            : { treasuryAccountId: a0.id, reference: `FIN100-RFD-${RUN_KEY}-${slug}` };
        const pay = await call('refunds.pay', `/api/refunds/${encodeURIComponent(ids.refundId)}/pay`, {
          method: 'POST',
          body: payBody,
        });
        if (!pay.ok) throw new Error(`refund-pay: ${pay.status} ${JSON.stringify(pay.data).slice(0, 300)}`);
      }
    }

    // Step 5: internal transfer between treasury accounts (movement pair)
    if (scenario.doTransfer && a1) {
      const amt = Math.max(1000, Math.round((20_000 + (n % 17) * 750) * SCALE));
      const tr = await call('treasury.transfer', '/api/treasury/transfer', {
        method: 'POST',
        body: {
          fromId: a0.id,
          toId: a1.id,
          amountNgn: amt,
          reference: `FIN100-TRF-${RUN_KEY}-${slug}`,
          dateISO: scenario.dateISO,
        },
      });
      // Some deployments may not expose this endpoint; treat as non-fatal.
      if (!tr.ok) {
        telemetry.warnings.push({ slug, step: 'treasury.transfer', status: tr.status, data: tr.data });
      }
    }

    // Step 6: expense + payment request + approve + pay (treasury outflow)
    if (scenario.doExpenseAndRequest && row.amounts.expenseNgn > 0) {
      const exp = await call('expenses.create', '/api/expenses', {
        method: 'POST',
        body: {
          expenseID: ids.expenseId,
          expenseType: `Ops — ${scenario.city} (${slug})`,
          amountNgn: row.amounts.expenseNgn,
          date: scenario.dateISO,
          category: scenario.expenseCategory,
          paymentMethod: 'Transfer',
          treasuryAccountId: a0.id,
          reference: `FIN100-EXP-${RUN_KEY}-${slug}`,
        },
      });
      if (!exp.ok) throw new Error(`expense: ${exp.status} ${JSON.stringify(exp.data).slice(0, 300)}`);

      const pr = await call('paymentRequests.create', '/api/payment-requests', {
        method: 'POST',
        body: {
          expenseID: ids.expenseId,
          requestID: ids.paymentRequestId,
          amountRequestedNgn: row.amounts.expenseNgn,
          requestDate: scenario.dateISO,
          description: `FIN100 payment request ${slug}`,
        },
      });
      if (!pr.ok) throw new Error(`payment-request: ${pr.status} ${JSON.stringify(pr.data).slice(0, 300)}`);

      await call('paymentRequests.approve', `/api/payment-requests/${encodeURIComponent(ids.paymentRequestId)}/decision`, {
        method: 'POST',
        body: { status: 'Approved', note: `FIN100 ok ${slug}` },
      });

      const payLines = a1
        ? (() => {
            const p1 = Math.floor(row.amounts.expenseNgn * 0.6);
            return [
              { treasuryAccountId: a0.id, amountNgn: p1, reference: `FIN100-P1-${RUN_KEY}-${slug}` },
              { treasuryAccountId: a1.id, amountNgn: row.amounts.expenseNgn - p1, reference: `FIN100-P2-${RUN_KEY}-${slug}` },
            ];
          })()
        : [{ treasuryAccountId: a0.id, amountNgn: row.amounts.expenseNgn, reference: `FIN100-PAY-${RUN_KEY}-${slug}` }];

      const pay = await call('paymentRequests.pay', `/api/payment-requests/${encodeURIComponent(ids.paymentRequestId)}/pay`, {
        method: 'POST',
        body: { note: `FIN100 payout ${slug}`, paymentLines: payLines },
      });
      if (!pay.ok) throw new Error(`payment-pay: ${pay.status} ${JSON.stringify(pay.data).slice(0, 300)}`);
    }

    // Step 7: create a payable (AP) record for load (may be used by Accounts UI)
    if (scenario.doPayable && row.amounts.payableNgn > 0) {
      const ap = await call('ap.create', '/api/accounts-payable', {
        method: 'POST',
        body: {
          apID: ids.apId,
          supplierName: `FIN100 Supplier ${slug}`,
          poRef: `PO-${RUN_KEY}-${slug}`,
          invoiceRef: `INV-${RUN_KEY}-${slug}`,
          amountNgn: row.amounts.payableNgn,
          paidNgn: 0,
          dueDateISO: scenario.dateISO,
          paymentMethod: 'Transfer',
        },
      });
      if (!ap.ok) {
        telemetry.warnings.push({ slug, step: 'ap.create', status: ap.status, data: ap.data });
      }
    }
  } catch (e) {
    fail('run', e);
  }

  return row;
}

async function rampPhase(session, telemetry, { targets }) {
  const results = [];

  const mkStep = (i) => Math.round(RAMP_START * Math.pow(RAMP_MULT, i));

  const callMany = async (name, count, fn) => {
    const times = [];
    let ok = 0;
    let fail = 0;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: count }, async () => {
        const t = Date.now();
        const r = await fn();
        times.push(Date.now() - t);
        if (r?.ok) ok += 1;
        else fail += 1;
      })
    );
    const batchMs = Date.now() - t0;
    const row = { name, concurrent: count, ok, fail, batch_ms: batchMs, timings_ms: statsFromTimes(times) };
    telemetry.ramp.push(row);
    results.push(row);
  };

  const { accounts } = await ensureFinancePrereqs(session);
  const a0 = accounts[0];

  for (let i = 0; i < RAMP_STEPS; i += 1) {
    const conc = mkStep(i);

    if (targets.includes('bootstrap')) {
      await callMany('ramp.bootstrap', conc, () => api('/api/bootstrap', { sessionCookie: session.cookie, csrfToken: session.csrfToken }));
    }

    if (targets.includes('customers')) {
      await callMany('ramp.customers.list', conc, () => api('/api/customers', { sessionCookie: session.cookie, csrfToken: session.csrfToken }));
    }

    if (targets.includes('ledger')) {
      await callMany('ramp.ledger.list', conc, () => api('/api/ledger', { sessionCookie: session.cookie, csrfToken: session.csrfToken }));
    }

    if (targets.includes('finance')) {
      // Light write that hits finance tables but avoids creating many new entities.
      const payload = {
        expenseID: `EXP-RAMP-${RUN_KEY}-${i}`,
        expenseType: `Ramp expense step ${i}`,
        amountNgn: scaled(2500 + i * 200),
        date: '2026-04-02',
        category: 'Other — misc operating',
        paymentMethod: 'Transfer',
        treasuryAccountId: a0.id,
        reference: `FIN100-RAMP-${RUN_KEY}-${i}`,
      };
      await callMany('ramp.expenses.create', Math.max(1, Math.floor(conc / 5)), () =>
        api('/api/expenses', {
          method: 'POST',
          sessionCookie: session.cookie,
          csrfToken: session.csrfToken,
          body: payload,
          timeoutMs: 90_000,
        })
      );
    }
  }

  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(
    JSON.stringify(
      {
        phase: 'config',
        api: API_BASE,
        ui: UI_BASE,
        runKey: RUN_KEY,
        scenarios: `${FROM}..${TO} (${TO - FROM + 1} of ${FINANCE_SCENARIO_COUNT})`,
        scaleAmounts: SCALE,
        ramp: RAMP_ENABLED
          ? {
              enabled: true,
              steps: RAMP_STEPS,
              start: RAMP_START,
              mult: RAMP_MULT,
              targets: RAMP_TARGETS,
            }
          : { enabled: false },
      },
      null,
      2
    )
  );

  const session = await login();

  const telemetry = {
    generatedAt: new Date().toISOString(),
    api: API_BASE,
    ui: UI_BASE,
    runKey: RUN_KEY,
    from: FROM,
    to: TO,
    scaleAmounts: SCALE,
    calls: {},
    warnings: [],
    ramp: [],
  };

  const scenarios = allFinanceScenarios().slice(FROM, TO + 1);
  const report = [];
  for (const sc of scenarios) {
    const row = await runScenario(session, sc, telemetry);
    report.push(row);
    const icon = row.ok ? 'ok' : 'FAIL';
    console.log(`${icon} ${sc.slug}${row.errors.length ? ` ${row.errors.map((e) => e.error).join(' | ')}` : ''}`);
  }

  const failed = report.filter((r) => !r.ok);

  // Summarize per-endpoint timings
  const callSummary = Object.fromEntries(
    Object.entries(telemetry.calls).map(([name, v]) => [
      name,
      {
        ok: v.ok,
        fail: v.fail,
        timings_ms: statsFromTimes(v.times_ms),
        samples: v.samples,
      },
    ])
  );

  if (RAMP_ENABLED) {
    await rampPhase(session, telemetry, { targets: RAMP_TARGETS });
  }

  const outPath = join(__dirname, 'output', 'finance-100-report.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: telemetry.generatedAt,
        api: API_BASE,
        ui: UI_BASE,
        runKey: RUN_KEY,
        from: FROM,
        to: TO,
        scaleAmounts: SCALE,
        passed: report.length - failed.length,
        failed: failed.length,
        callSummary,
        warnings: telemetry.warnings,
        ramp: telemetry.ramp,
        rows: report,
        total_ms: Date.now() - t0,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(JSON.stringify({ phase: 'done', ms: Date.now() - t0, reportPath: outPath }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

