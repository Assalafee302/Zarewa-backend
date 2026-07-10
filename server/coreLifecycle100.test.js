/**
 * Core Lifecycle 100 — master test harness linking quotation → payment → cutting list
 * → production → stock → refund. Runs inline fraud/smoke/crash guards plus chain validation.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { REFUND_TEST_PAYEE } from './refundTestPayee.js';
import { assertSingleBranchWorkspaceForBulkWrite } from './branchScope.js';
import {
  CORE_LIFECYCLE_100,
  LIFECYCLE_100_COUNT,
  validateLifecycle100Chain,
  inlineScenarioIds,
  scenariosByType,
  scenariosByRisk,
} from '../shared/lib/coreLifecycle100Matrix.js';

import { createConnection } from 'node:net';

const openDbs = [];
let mysqlOk = false;

function probeMysqlPort(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 3306 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const MATERIAL_HEADER = {
  materialTypeId: 'MAT-002',
  materialDesign: 'Longspan (Indus6)',
  materialColor: 'IV',
  materialGauge: '0.24mm',
};

/** @param {Record<string, unknown>} [overrides] */
function quotationPayload(overrides = {}) {
  return {
    customerID: 'CUS-001',
    projectName: 'LC100 test',
    dateISO: '2026-03-29',
    ...MATERIAL_HEADER,
    lines: {
      products: [{ name: 'Roofing Sheet', qty: '20', unitPrice: '4000' }],
      accessories: [],
      services: [],
    },
    ...overrides,
  };
}

async function loginAs(agent, username = 'admin', password = 'Admin@123') {
  const res = await agent.post('/api/session/login').send({ username, password });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function postFullReceipt(agent, quotationId, amountNgn, treasuryAccountId, reference) {
  const uniqueRef = `${reference}-${Date.now()}`;
  const rcpt = await agent.post('/api/ledger/receipt').send({
    customerID: 'CUS-001',
    quotationId,
    amountNgn,
    paymentMethod: 'Cash',
    bankReference: uniqueRef,
    dateISO: '2026-03-29',
    paymentLines: [{ treasuryAccountId, amountNgn, reference: uniqueRef }],
    forceDuplicatePost: true,
    duplicateOverrideReason: 'LC100 automated integration test',
  });
  expect(rcpt.status).toBe(201);
  const receiptId = rcpt.body.receipt?.id || rcpt.body.receiptId;
  expect(receiptId).toBeTruthy();
  const settle = await agent
    .patch(`/api/sales-receipts/${encodeURIComponent(receiptId)}/finance-settlement`)
    .send({ bankReceivedAmountNgn: amountNgn });
  expect(settle.status).toBe(200);
  const sync = await agent.post(`/api/quotations/${encodeURIComponent(quotationId)}/sync-paid-from-ledger`).send({});
  expect(sync.status).toBe(200);
}

describe('Core Lifecycle 100 matrix', () => {
  it('LC100-100: validates exactly 100 linked scenarios in one chain', () => {
    expect(LIFECYCLE_100_COUNT).toBe(100);
    const chain = validateLifecycle100Chain();
    expect(chain.ok, chain.errors.join('\n')).toBe(true);
    expect(CORE_LIFECYCLE_100[0].id).toBe('LC100-001');
    expect(CORE_LIFECYCLE_100[99].id).toBe('LC100-100');
    expect(CORE_LIFECYCLE_100[0].prevId).toBeNull();
    expect(CORE_LIFECYCLE_100[99].nextId).toBeNull();
  });

  it('covers all six core modules across the matrix', () => {
    const modules = new Set(CORE_LIFECYCLE_100.flatMap((s) => s.modules));
    for (const key of ['quotation', 'payment', 'cutting_list', 'production', 'stock', 'refund']) {
      expect(modules.has(key), `missing module ${key}`).toBe(true);
    }
  });

  it('maps risk categories: fraud, financial_failure, inventory_gap', () => {
    expect(scenariosByRisk('fraud').length).toBeGreaterThanOrEqual(10);
    expect(scenariosByRisk('financial_failure').length).toBeGreaterThanOrEqual(15);
    expect(scenariosByRisk('inventory_gap').length).toBeGreaterThanOrEqual(10);
    expect(scenariosByRisk('hack').length).toBeGreaterThanOrEqual(5);
  });

  it('includes smoke, e2e, crash, and integration types', () => {
    for (const type of ['smoke', 'e2e', 'crash', 'integration', 'fraud', 'financial', 'inventory']) {
      expect(scenariosByType(type).length, `no scenarios for type ${type}`).toBeGreaterThan(0);
    }
  });

  it('declares inline API guards for fraud and gate scenarios', () => {
    const inline = inlineScenarioIds();
    expect(inline).toContain('LC100-028');
    expect(inline).toContain('LC100-036');
    expect(inline).toContain('LC100-042');
    expect(inline).toContain('LC100-054');
    expect(inline).toContain('LC100-086');
    expect(inline).toContain('LC100-088');
    expect(inline).toContain('LC100-090');
    expect(inline).toContain('LC100-100');
  });
});

describe('Core Lifecycle 100 pure guards (no DB)', () => {
  it('LC100-090: bulk write blocked in all-branches workspace view', () => {
    const gate = assertSingleBranchWorkspaceForBulkWrite({
      workspaceViewAll: true,
      workspaceBranchId: 'BR-KD',
    });
    expect(gate.ok).toBe(false);
    expect(String(gate.error || '')).toMatch(/branch/i);
  });
});

describe('Core Lifecycle 100 inline guards', () => {
  const MYSQL_TIMEOUT = 120_000;
  /** @type {ReturnType<typeof request.agent> | null} */
  let agent = null;
  /** @type {ReturnType<typeof createApp> | null} */
  let app = null;

  beforeAll(async () => {
    mysqlOk = await probeMysqlPort();
    if (!mysqlOk) return;
    const db = createDatabase(':memory:');
    openDbs.push(db);
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  }, 300_000);

  beforeEach((ctx) => {
    if (!mysqlOk || !agent) ctx.skip();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    for (const db of openDbs) db.close();
    openDbs.length = 0;
  });

  it(
    'LC100-028: period lock blocks backdated receipt posting',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const boot0 = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot0.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(quotationPayload({ projectName: 'LC100-028 lock' }));
      expect(quote.status).toBe(201);

      const lock = await agent.post('/api/controls/period-locks').send({
        periodKey: '2026-03',
        reason: 'LC100 month-end close force lock for test',
        force: true,
      });
      expect(lock.status).toBe(201);

      const blocked = await agent.post('/api/ledger/receipt').send({
        customerID: 'CUS-001',
        quotationId: quote.body.quotationId,
        amountNgn: 50_000,
        paymentMethod: 'Cash',
        dateISO: '2026-03-15',
        paymentLines: [{ treasuryAccountId, amountNgn: 50_000, reference: 'LC100-028' }],
      });
      expect(blocked.status).toBe(400);
      expect(String(blocked.body.error || '')).toMatch(/locked period/i);

      await agent.delete('/api/controls/period-locks/2026-03').send({ reason: 'LC100 unlock after test' });
    }
  );

  it(
    'LC100-036: 70% payment gate blocks cutting list creation',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const snap = await agent.get('/api/bootstrap');
      const fgProduct = snap.body.products.find((p) => p.productID === 'FG-101') || snap.body.products[0];
      const treasuryAccountId = snap.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(
        quotationPayload({
          projectName: 'LC100-036 underpaid',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '100', unitPrice: '5000' }],
            accessories: [],
            services: [],
          },
        })
      );
      expect(quote.status).toBe(201);
      const total = quote.body.quotation.totalNgn;
      const underpay = Math.floor(total * 0.1);

      const rcpt = await agent.post('/api/ledger/receipt').send({
        customerID: 'CUS-001',
        quotationId: quote.body.quotationId,
        amountNgn: underpay,
        paymentMethod: 'Cash',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId, amountNgn: underpay, reference: 'LC100-036-10pct' }],
      });
      expect(rcpt.status).toBe(201);

      const cutting = await agent.post('/api/cutting-lists').send({
        quotationRef: quote.body.quotationId,
        customerID: 'CUS-001',
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Gate test',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 10 }],
      });
      expect(cutting.status).toBe(400);
      expect(String(cutting.body.error || '')).toMatch(/70%|at least/i);
    }
  );

  it(
    'LC100-042: pending order-cancellation refund blocks production registration',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const snap = await agent.get('/api/bootstrap');
      const fgProduct = snap.body.products.find((p) => p.productID === 'FG-101') || snap.body.products[0];
      const treasuryAccountId = snap.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(
        quotationPayload({
          projectName: 'LC100-042 refund block',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '4000' }],
            accessories: [],
            services: [],
          },
        })
      );
      expect(quote.status).toBe(201);
      const qid = quote.body.quotationId;
      const total = quote.body.quotation.totalNgn;

      await postFullReceipt(agent, qid, total, treasuryAccountId, 'LC100-042-PAY');

      const cutting = await agent.post('/api/cutting-lists').send({
        quotationRef: qid,
        customerID: 'CUS-001',
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 10 }],
      });
      expect(cutting.status).toBe(201);

      const job = await agent.post('/api/production-jobs').send({
        cuttingListId: cutting.body.id,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        plannedMeters: 10,
        plannedSheets: 1,
        status: 'Planned',
      });
      expect(job.status).toBe(201);

      const cancelJob = await agent
        .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/cancel`)
        .send({ reason: 'LC100-042 cancel for order-cancellation refund' });
      expect(cancelJob.status).toBe(200);

      const refund = await agent.post('/api/refunds').send({
        ...REFUND_TEST_PAYEE,
        customerID: 'CUS-001',
        customer: 'CUS-001',
        quotationRef: qid,
        cuttingListRef: cutting.body.id,
        reasonCategory: 'Order cancellation',
        reason: 'LC100-042 cancel before production',
        amountNgn: 1_000,
        calculationLines: [
          { label: 'Partial cancel', amountNgn: 1_000, category: 'Order cancellation', include: true },
        ],
      });
      if (refund.status !== 201) {
        throw new Error(`refund failed: ${refund.status} ${JSON.stringify(refund.body)}`);
      }

      const register = await agent
        .post(`/api/cutting-lists/${encodeURIComponent(cutting.body.id)}/register-production`)
        .send({});
      expect(register.status).toBe(400);
      expect(String(register.body.error || '')).toMatch(/refund|cancellation|blocked/i);
    }
  );

  it(
    'LC100-054: production start blocked without coil allocation',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const snap = await agent.get('/api/bootstrap');
      const fgProduct = snap.body.products.find((p) => p.productID === 'FG-101') || snap.body.products[0];
      const treasuryAccountId = snap.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(
        quotationPayload({
          projectName: 'LC100-054 no coil',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '20', unitPrice: '4000' }],
            accessories: [],
            services: [],
          },
        })
      );
      expect(quote.status).toBe(201);
      const total = quote.body.quotation.totalNgn;
      await postFullReceipt(agent, quote.body.quotationId, total, treasuryAccountId, 'LC100-054');

      const cutting = await agent.post('/api/cutting-lists').send({
        quotationRef: quote.body.quotationId,
        customerID: 'CUS-001',
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 20 }],
      });
      expect(cutting.status).toBe(201);

      const job = await agent.post('/api/production-jobs').send({
        cuttingListId: cutting.body.id,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        plannedMeters: 20,
        plannedSheets: 1,
        status: 'Planned',
      });
      expect(job.status).toBe(201);

      const start = await agent.post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/start`).send({});
      expect(start.status).toBe(400);
      expect(start.body.ok).toBe(false);
    }
  );

  it('LC100-086: unauthenticated API returns 401', async () => {
    const res = await request(app).get('/api/quotations');
    expect(res.status).toBe(401);
  });

  it(
    'LC100-088: sales staff cannot pay refunds',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(
        quotationPayload({
          projectName: 'LC100-088 refund',
          lines: {
            products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '10000' }],
            accessories: [],
            services: [],
          },
        })
      );
      expect(quote.status).toBe(201);
      const total = quote.body.quotation.totalNgn;
      await postFullReceipt(agent, quote.body.quotationId, total, treasuryAccountId, 'LC100-088-PAY');

      const fg = boot.body.products.find((p) => p.productID === 'FG-101') || boot.body.products[0];
      const cutting = await agent.post('/api/cutting-lists').send({
        quotationRef: quote.body.quotationId,
        customerID: 'CUS-001',
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 5 }],
      });
      expect(cutting.status).toBe(201);

      const job = await agent.post('/api/production-jobs').send({
        cuttingListId: cutting.body.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 5,
        plannedSheets: 1,
        status: 'Planned',
      });
      expect(job.status).toBe(201);

      const cancel = await agent
        .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/cancel`)
        .send({ reason: 'LC100-088 refund eligibility' });
      expect(cancel.status).toBe(200);

      const refund = await agent.post('/api/refunds').send({
        ...REFUND_TEST_PAYEE,
        customerID: 'CUS-001',
        customer: 'John Doe',
        quotationRef: quote.body.quotationId,
        reasonCategory: 'Other',
        reason: 'LC100-088 test',
        amountNgn: 5_000,
        calculationLines: [{ label: 'Goodwill', amountNgn: 5_000, category: 'Other', include: true }],
      });
      expect(refund.status).toBe(201);

      await agent.post(`/api/refunds/${encodeURIComponent(refund.body.refundID)}/decision`).send({
        status: 'Approved',
        managerComments: 'Approved for LC100-088',
      });

      const sales = request.agent(app);
      await loginAs(sales, 'sales.staff', 'Sales@123');
      const pay = await sales.post(`/api/refunds/${encodeURIComponent(refund.body.refundID)}/pay`).send({
        treasuryAccountId,
        reference: 'LC100-088-BAD',
      });
      expect(pay.status).toBe(403);
    }
  );

  it(
    'LC100-003 smoke: full receipt clears quotation balance',
    { timeout: MYSQL_TIMEOUT },
    async () => {
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;

      const quote = await agent.post('/api/quotations').send(quotationPayload({ projectName: 'LC100 smoke pay' }));
      expect(quote.status).toBe(201);
      const total = quote.body.quotation.totalNgn;

      await postFullReceipt(agent, quote.body.quotationId, total, treasuryAccountId, 'LC100-SMOKE');

      const summary = await agent.get('/api/customers/CUS-001/summary');
      expect(summary.status).toBe(200);
      const due = summary.body.outstandingByQuotation.find(
        (row) => row.quotationId === quote.body.quotationId
      )?.amountDueNgn;
      expect(Number(due)).toBe(0);
    }
  );
});
