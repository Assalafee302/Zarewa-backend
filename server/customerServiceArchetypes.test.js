/**
 * Thirty customer-service archetypes: different temperaments, payment habits, mistakes,
 * and internal control paths. The API models how an organization reduces fraud and error:
 *
 * - Segregation of duties: sales can request refunds; manager/finance approves; only finance pays out.
 * - Treasury discipline: split receipt lines must equal the header amount (catches typos and skimming).
 * - Quotation ownership: advance cannot be applied to another customer’s quote (blocks mis-allocation).
 * - Role boundaries: procurement cannot post expenses; sales cannot pay refunds (limits insider abuse).
 * - Approval before cash-out: payment requests and refunds must be approved before treasury debit.
 * - Period close: back-dated postings in locked months are rejected (stops backdating fraud).
 * - Privileged corrections: receipt/advance reversals require finance.reverse (not everyday cashier roles).
 * - Traceability: production start without coil allocation is blocked (material accountability).
 * - Audit trail: finance roles can read audit_log after sensitive postings.
 * - Dual control on one database: sales raises refund; branch manager, MD, finance (finance.approve), or admin approves; finance pays (staff never pays).
 * - Read-only boundary: sales cannot view audit_log; operations/procurement cannot sell or bank cash.
 * - Rejection gates: rejected refunds and payment requests cannot be paid out.
 * - Session: unauthenticated API calls are rejected before any business logic.
 *
 * These tests are live API exercises (in-memory DB each time), not UI flows.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const openDbs = [];

async function loginAs(agent, username, password) {
  const res = await agent.post('/api/session/login').send({ username, password });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function createSession() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  const app = createApp(db);
  const agent = request.agent(app);
  await loginAs(agent, 'admin', 'Admin@123');
  return { app, agent };
}

async function createSessionAs(username, password) {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  const app = createApp(db);
  const agent = request.agent(app);
  await loginAs(agent, username, password);
  return { app, agent };
}

function hashCode(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}

function buildExactLengths(count, totalMeters) {
  const totalTenths = Math.round(totalMeters * 10);
  const base = Math.floor(totalTenths / count);
  let rem = totalTenths - base * count;
  return Array.from({ length: count }, () => {
    const current = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    return { sheets: 1, lengthM: current / 10 };
  });
}

function metersQuantizedToDecimeters(totalMeters) {
  return Math.round(Number(totalMeters) * 10) / 10;
}

async function bootstrap(agent) {
  const res = await agent.get('/api/bootstrap');
  expect(res.status).toBe(200);
  return res.body;
}

async function ensureTreasuryAccounts(agent, count, key) {
  const createdIds = [];
  for (let i = 0; i < count; i += 1) {
    const create = await agent.post('/api/treasury/accounts').send({
      name: `Archetype ${key} ${i + 1}`,
      bankName: `Bank ${key} ${i + 1}`,
      type: i === 0 ? 'Cash' : 'Bank',
      accNo: `ARC-${key}-${i + 1}`,
      balance: 50_000_000,
    });
    expect(create.status).toBe(201);
    createdIds.push(create.body.id);
  }
  const snap = await bootstrap(agent);
  return snap.treasuryAccounts.filter((a) => createdIds.includes(a.id));
}

async function createCustomer(agent, key, name) {
  const customerID = `CUS-${key}`;
  // Phone numbers are derived from a hash; in rare cases the generated phone can collide
  // with seeded/demo data, causing a 409 duplicate registration. Retry with a salt.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const salted = `${customerID}:${attempt}`;
    const phoneNumber = `080${String(Math.abs(hashCode(salted))).slice(0, 8).padEnd(8, '0')}`;
    const res = await agent.post('/api/customers').send({
      customerID,
      name,
      phoneNumber,
      email: `${customerID.toLowerCase()}@example.com`,
      addressShipping: `${key} site`,
      addressBilling: `${key} bill`,
      status: 'Active',
      tier: 'Retail',
      paymentTerms: 'Cash',
    });
    if (res.status === 201) return customerID;
    if (res.status !== 409) {
      throw new Error(`createCustomer failed: status=${res.status}, body=${JSON.stringify(res.body)}`);
    }
  }
  throw new Error(`createCustomer failed after retries for ${customerID}`);
}

async function createQuotation(agent, customerID, key, lines, projectName = key) {
  const res = await agent.post('/api/quotations').send({
    customerID,
    projectName,
    dateISO: '2026-03-29',
    lines,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function customerSummary(agent, customerID) {
  const res = await agent.get(`/api/customers/${encodeURIComponent(customerID)}/summary`);
  expect(res.status).toBe(200);
  return res.body;
}

function amountDueFor(summary, quotationId) {
  return Number(summary.outstandingByQuotation.find((row) => row.quotationId === quotationId)?.amountDueNgn || 0);
}

async function ensureQuotationPaidForCuttingList(agent, quotationRef) {
  const boot = await agent.get('/api/bootstrap');
  expect(boot.status).toBe(200);
  const q = boot.body.quotations.find((x) => x.id === quotationRef);
  if (!q) throw new Error(`Quotation ${quotationRef} not found`);
  const total = Number(q.totalNgn) || 0;
  const paid = Number(q.paidNgn) || 0;
  if (total <= 0) return;
  const minPaid = total * 0.7;
  if (paid >= minPaid - 1e-6) return;
  const patch = await agent.patch(`/api/quotations/${encodeURIComponent(quotationRef)}`).send({
    paidNgn: Math.ceil(minPaid),
  });
  expect(patch.status).toBe(200);
}

async function createCuttingList(agent, payload) {
  await ensureQuotationPaidForCuttingList(agent, payload.quotationRef);
  const res = await agent.post('/api/cutting-lists').send(payload);
  expect(res.status).toBe(201);
  return res.body;
}

async function createSupplier(agent, key, city) {
  const res = await agent.post('/api/suppliers').send({
    name: `Sup ${key}`,
    city,
    paymentTerms: 'Cash',
    qualityScore: 80,
    notes: key,
  });
  expect(res.status).toBe(201);
  return { supplierID: res.body.supplierID, supplierName: `Sup ${key}` };
}

async function createPurchaseOrder(agent, payload) {
  const res = await agent.post('/api/purchase-orders').send(payload);
  expect(res.status).toBe(201);
  return res.body;
}

async function confirmGrn(agent, poID, payload) {
  const res = await agent.post(`/api/purchase-orders/${encodeURIComponent(poID)}/grn`).send(payload);
  expect(res.status).toBe(200);
  return res.body;
}

async function createProductionJob(agent, payload) {
  const res = await agent.post('/api/production-jobs').send(payload);
  expect(res.status).toBe(201);
  return res.body;
}

async function cancelProductionJobForRefundEligibility(agent, jobID) {
  const res = await agent.post(`/api/production-jobs/${encodeURIComponent(jobID)}/cancel`).send({
    reason: 'Archetype — close production for refund eligibility',
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function approvePaymentRequest(agent, requestID, note = 'Approved.') {
  const res = await agent
    .post(`/api/payment-requests/${encodeURIComponent(requestID)}/decision`)
    .send({ status: 'Approved', note });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function saveJobAllocations(agent, jobId, allocations) {
  const res = await agent
    .post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`)
    .send({ allocations });
  expect(res.status).toBe(200);
}

async function startProductionJob(agent, jobId) {
  const res = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({
    startedAtISO: '2026-03-29',
  });
  expect(res.status).toBe(200);
}

function buildArchetypes() {
  return [
    {
      id: 'ARC-01',
      title: 'Cash-only client: one leg, full settlement same day',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A01');
        const cid = await createCustomer(agent, 'ARC01', 'Mama Zainab Cash');
        const q = await createQuotation(agent, cid, 'ARC01', {
          products: [{ name: 'Roofing Sheet', qty: '20', unitPrice: '5000' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 100_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 100_000, reference: 'CASH-A01' }],
        });
        expect(res.status).toBe(201);
        const sum = await customerSummary(agent, cid);
        expect(amountDueFor(sum, q.quotationId)).toBe(0);
      },
    },
    {
      id: 'ARC-02',
      title: 'Bank-transfer purist: single reference, full pay',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A02');
        const cid = await createCustomer(agent, 'ARC02', 'Engineer Bello Transfer');
        const q = await createQuotation(agent, cid, 'ARC02', {
          products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '888888' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 888_888,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 888_888, reference: 'TRF-A02' }],
        });
        expect(res.status).toBe(201);
        expect((await customerSummary(agent, cid)).advanceNgn).toBe(0);
      },
    },
    {
      id: 'ARC-03',
      title: 'Split tender: cash + bank in one receipt',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 2, 'A03');
        const cid = await createCustomer(agent, 'ARC03', 'Split Tender Amina');
        const q = await createQuotation(agent, cid, 'ARC03', {
          products: [{ name: 'Sheet', qty: '100', unitPrice: '3000' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 300_000,
          paymentMethod: 'Split',
          dateISO: '2026-03-29',
          paymentLines: [
            { treasuryAccountId: accs[0].id, amountNgn: 120_000, reference: 'CASH-A03' },
            { treasuryAccountId: accs[1].id, amountNgn: 180_000, reference: 'BNK-A03' },
          ],
        });
        expect(res.status).toBe(201);
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBe(0);
      },
    },
    {
      id: 'ARC-04',
      title: 'Three-way split: customer insists on multiple banks',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 3, 'A04');
        const cid = await createCustomer(agent, 'ARC04', 'Multi-bank Chinedu');
        const q = await createQuotation(agent, cid, 'ARC04', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '600000' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 600_000,
          paymentMethod: 'Split',
          dateISO: '2026-03-29',
          paymentLines: [
            { treasuryAccountId: accs[0].id, amountNgn: 200_001, reference: 'A04-1' },
            { treasuryAccountId: accs[1].id, amountNgn: 199_999, reference: 'A04-2' },
            { treasuryAccountId: accs[2].id, amountNgn: 200_000, reference: 'A04-3' },
          ],
        });
        expect(res.status).toBe(201);
      },
    },
    {
      id: 'ARC-05',
      title: 'Underpays on purpose “I will balance later” — leaves exact balance',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A05');
        const cid = await createCustomer(agent, 'ARC05', 'Partial payer Yusuf');
        const q = await createQuotation(agent, cid, 'ARC05', {
          products: [{ name: 'Sheet', qty: '40', unitPrice: '5000' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 175_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 175_000, reference: 'UF-A05' }],
        });
        expect(res.status).toBe(201);
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBe(25_000);
      },
    },
    {
      id: 'ARC-06',
      title: 'Overpays slightly — excess becomes customer advance credit',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A06');
        const cid = await createCustomer(agent, 'ARC06', 'Generous tipper');
        const q = await createQuotation(agent, cid, 'ARC06', {
          products: [{ name: 'Sheet', qty: '10', unitPrice: '10000' }],
          accessories: [],
          services: [],
        });
        const res = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 125_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 125_000, reference: 'OV-A06' }],
        });
        expect(res.status).toBe(201);
        const sum = await customerSummary(agent, cid);
        expect(amountDueFor(sum, q.quotationId)).toBe(0);
        expect(sum.advanceNgn).toBe(25_000);
      },
    },
    {
      id: 'ARC-07',
      title: 'Deposit before meters known — advance then apply part of quote',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A07');
        const cid = await createCustomer(agent, 'ARC07', 'Early depositor');
        await agent.post('/api/ledger/advance').send({
          customerID: cid,
          amountNgn: 400_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 400_000, reference: 'DEP-A07' }],
        });
        const q = await createQuotation(agent, cid, 'ARC07', {
          products: [{ name: 'Sheet', qty: '100', unitPrice: '5000' }],
          accessories: [],
          services: [],
        });
        const ap = await agent.post('/api/ledger/apply-advance').send({
          customerID: cid,
          quotationRef: q.quotationId,
          amountNgn: 350_000,
        });
        expect(ap.status).toBe(201);
        const sum = await customerSummary(agent, cid);
        expect(sum.advanceNgn).toBe(50_000);
        expect(amountDueFor(sum, q.quotationId)).toBe(150_000);
      },
    },
    {
      id: 'ARC-08',
      title: 'Advance exactly clears quote — no cash second leg needed',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A08');
        const cid = await createCustomer(agent, 'ARC08', 'Exact advance match');
        await agent.post('/api/ledger/advance').send({
          customerID: cid,
          amountNgn: 240_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 240_000, reference: 'DEP-A08' }],
        });
        const q = await createQuotation(agent, cid, 'ARC08', {
          products: [{ name: 'Sheet', qty: '48', unitPrice: '5000' }],
          accessories: [],
          services: [],
        });
        expect(
          (
            await agent.post('/api/ledger/apply-advance').send({
              customerID: cid,
              quotationRef: q.quotationId,
              amountNgn: 240_000,
            })
          ).status
        ).toBe(201);
        const sum = await customerSummary(agent, cid);
        expect(sum.advanceNgn).toBe(0);
        expect(amountDueFor(sum, q.quotationId)).toBe(0);
      },
    },
    {
      id: 'ARC-09',
      title: 'Staff mistake risk: two quotes — payment hits only the selected one',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A09');
        const cid = await createCustomer(agent, 'ARC09', 'Two-site contractor');
        const qa = await createQuotation(agent, cid, 'ARC09A', {
          products: [{ name: 'Site A', qty: '1', unitPrice: '300000' }],
          accessories: [],
          services: [],
        });
        const qb = await createQuotation(agent, cid, 'ARC09B', {
          products: [{ name: 'Site B', qty: '1', unitPrice: '500000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: qa.quotationId,
          amountNgn: 300_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 300_000, reference: 'A09-A' }],
        });
        const sum = await customerSummary(agent, cid);
        expect(amountDueFor(sum, qa.quotationId)).toBe(0);
        expect(amountDueFor(sum, qb.quotationId)).toBe(500_000);
      },
    },
    {
      id: 'ARC-10',
      title: 'Customer pays same quote twice — second tranche becomes advance',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A10');
        const cid = await createCustomer(agent, 'ARC10', 'Double payer');
        const q = await createQuotation(agent, cid, 'ARC10', {
          products: [{ name: 'Sheet', qty: '10', unitPrice: '50000' }],
          accessories: [],
          services: [],
        });
        for (const ref of ['A10-1', 'A10-2']) {
          expect(
            (
              await agent.post('/api/ledger/receipt').send({
                customerID: cid,
                quotationId: q.quotationId,
                amountNgn: 500_000,
                paymentMethod: 'Transfer',
                dateISO: '2026-03-29',
                paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 500_000, reference: ref }],
              })
            ).status
          ).toBe(201);
        }
        const sum = await customerSummary(agent, cid);
        expect(amountDueFor(sum, q.quotationId)).toBe(0);
        expect(sum.advanceNgn).toBe(500_000);
      },
    },
    {
      id: 'ARC-11',
      title: 'Estimator short on meters vs quote — refund after documented short supply',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 1, 'A11');
        const snap = await bootstrap(agent);
        const fg = snap.products[0];
        const cid = await createCustomer(agent, 'ARC11', 'Short-sheet client');
        const q = await createQuotation(agent, cid, 'ARC11', {
          products: [{ name: 'Roofing Sheet', qty: '500', unitPrice: '4000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 2_000_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accs[0].id, amountNgn: 2_000_000, reference: 'PAY-A11' }],
        });
        const cl = await createCuttingList(agent, {
          quotationRef: q.quotationId,
          customerID: cid,
          productID: fg.productID,
          productName: fg.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'Estimator error',
          lines: buildExactLengths(20, 400),
        });
        const job11 = await createProductionJob(agent, {
          cuttingListId: cl.id,
          productID: fg.productID,
          productName: fg.name,
          plannedMeters: 400,
          plannedSheets: 20,
        });
        await cancelProductionJobForRefundEligibility(agent, job11.jobID);
        const rf = await agent.post('/api/refunds').send({
          customerID: cid,
          customer: 'Short-sheet client',
          quotationRef: q.quotationId,
          cuttingListRef: cl.id,
          reasonCategory: 'Short supply (quoted vs cutting list)',
          reason: 'Quoted 500m; cutting list totals 400m after re-measure.',
          amountNgn: 400_000,
          calculationLines: [{ label: '100m @ blended rate', amountNgn: 400_000 }],
        });
        expect(rf.status).toBe(201);
        await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'Verified on shop floor',
        });
        const pay = await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: accs[0].id,
          reference: 'RF-A11',
        });
        expect(pay.status).toBe(201);
      },
    },
    {
      id: 'ARC-12',
      title: 'Complex quote: accessories + services + products, one transfer',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A12');
        const cid = await createCustomer(agent, 'ARC12', 'Turnkey buyer');
        const q = await createQuotation(agent, cid, 'ARC12', {
          products: [{ name: 'Roofing Sheet', qty: '100', unitPrice: '4500' }],
          accessories: [{ name: 'Ridge pack', qty: '2', unitPrice: '25000' }],
          services: [{ name: 'Lift to roof', qty: '1', unitPrice: '80000' }],
        });
        const total = 450_000 + 50_000 + 80_000;
        expect(
          (
            await agent.post('/api/ledger/receipt').send({
              customerID: cid,
              quotationId: q.quotationId,
              amountNgn: total,
              paymentMethod: 'Transfer',
              dateISO: '2026-03-29',
              paymentLines: [{ treasuryAccountId: acc.id, amountNgn: total, reference: 'A12-FULL' }],
            })
          ).status
        ).toBe(201);
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBe(0);
      },
    },
    {
      id: 'ARC-13',
      title: '“Invoice me” personality — quote exists, nothing paid, full outstanding',
      run: async () => {
        const { agent } = await createSession();
        const cid = await createCustomer(agent, 'ARC13', 'Credit personality');
        const q = await createQuotation(agent, cid, 'ARC13', {
          products: [{ name: 'Sheet', qty: '50', unitPrice: '6000' }],
          accessories: [],
          services: [],
        });
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBe(300_000);
        expect((await customerSummary(agent, cid)).advanceNgn).toBe(0);
      },
    },
    {
      id: 'ARC-14',
      title: 'Front-desk typo: split legs do not match header — system rejects',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 2, 'A14');
        const cid = await createCustomer(agent, 'ARC14', 'Unlucky fourteen');
        const q = await createQuotation(agent, cid, 'ARC14', {
          products: [{ name: 'X', qty: '1', unitPrice: '200000' }],
          accessories: [],
          services: [],
        });
        const bad = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 200_000,
          paymentMethod: 'Split',
          dateISO: '2026-03-29',
          paymentLines: [
            { treasuryAccountId: accs[0].id, amountNgn: 90_000, reference: 'x' },
            { treasuryAccountId: accs[1].id, amountNgn: 90_000, reference: 'y' },
          ],
        });
        expect(bad.status).toBe(400);
      },
    },
    {
      id: 'ARC-15',
      title: 'Fraud control: cannot apply another customer’s deposit to someone else’s quote',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A15');
        const victim = await createCustomer(agent, 'ARC15V', 'Victim customer');
        const thief = await createCustomer(agent, 'ARC15T', 'Other party');
        await agent.post('/api/ledger/advance').send({
          customerID: thief,
          amountNgn: 500_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 500_000, reference: 'T-A15' }],
        });
        const qv = await createQuotation(agent, victim, 'ARC15V', {
          products: [{ name: 'Job', qty: '1', unitPrice: '400000' }],
          accessories: [],
          services: [],
        });
        const hijack = await agent.post('/api/ledger/apply-advance').send({
          customerID: thief,
          quotationRef: qv.quotationId,
          amountNgn: 100_000,
        });
        expect(hijack.status).toBe(400);
      },
    },
    {
      id: 'ARC-16',
      title: 'Segregation: procurement cannot post expenses (403)',
      run: async () => {
        const { agent } = await createSessionAs('procurement', 'Procure@123');
        const res = await agent.post('/api/expenses').send({
          expenseType: 'Blocked',
          amountNgn: 5000,
          date: '2026-03-29',
          category: 'Operational — rent & utilities',
          paymentMethod: 'Cash',
          treasuryAccountId: 1,
          reference: 'NOPE',
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    },
    {
      id: 'ARC-17',
      title: 'Segregation: sales officer cannot pay out refunds (403)',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const [acc] = await ensureTreasuryAccounts(admin, 1, 'A17');
        const cid = await createCustomer(admin, 'ARC17', 'Refund target');
        const q17 = await createQuotation(admin, cid, 'ARC17', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '50000' }],
          accessories: [],
          services: [],
        });
        await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q17.quotationId,
          amountNgn: 50_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 50_000, reference: 'A17-PAY' }],
        });
        const snap17 = await bootstrap(admin);
        const fg17 = snap17.products[0];
        const cl17 = await createCuttingList(admin, {
          quotationRef: q17.quotationId,
          customerID: cid,
          productID: fg17.productID,
          productName: fg17.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j17 = await createProductionJob(admin, {
          cuttingListId: cl17.id,
          productID: fg17.productID,
          productName: fg17.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(admin, j17.jobID);
        const rf = await admin.post('/api/refunds').send({
          customerID: cid,
          customer: 'Refund target',
          quotationRef: q17.quotationId,
          reasonCategory: 'Adjustment',
          reason: 'Test',
          amountNgn: 10_000,
          calculationLines: [{ label: 'Adj', amountNgn: 10_000 }],
        });
        expect(rf.status).toBe(201);
        await admin.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'ok',
        });
        const sales = request.agent(app);
        await loginAs(sales, 'sales.staff', 'Sales@123');
        const pay = await sales.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: acc.id,
          reference: 'BAD',
        });
        expect(pay.status).toBe(403);
      },
    },
    {
      id: 'ARC-18',
      title: 'Refund payout blocked until manager approval (even finance cannot skip)',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A18');
        const cid = await createCustomer(agent, 'ARC18', 'Pending approval');
        const q18 = await createQuotation(agent, cid, 'ARC18', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '100000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q18.quotationId,
          amountNgn: 100_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 100_000, reference: 'A18-PAY' }],
        });
        const snap18 = await bootstrap(agent);
        const fg18 = snap18.products[0];
        const cl18 = await createCuttingList(agent, {
          quotationRef: q18.quotationId,
          customerID: cid,
          productID: fg18.productID,
          productName: fg18.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j18 = await createProductionJob(agent, {
          cuttingListId: cl18.id,
          productID: fg18.productID,
          productName: fg18.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(agent, j18.jobID);
        const rf = await agent.post('/api/refunds').send({
          customerID: cid,
          customer: 'Pending approval',
          quotationRef: q18.quotationId,
          reasonCategory: 'Overpayment',
          reason: 'Early payout attempt',
          amountNgn: 50_000,
          calculationLines: [{ label: 'x', amountNgn: 50_000 }],
        });
        expect(rf.status).toBe(201);
        const early = await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: acc.id,
          reference: 'EARLY',
        });
        expect(early.status).toBe(400);
      },
    },
    {
      id: 'ARC-19',
      title: 'Payment request: cannot pay before finance approval',
      run: async () => {
        const { agent } = await createSession();
        const boot = await bootstrap(agent);
        const cash = boot.treasuryAccounts[0];
        const ex = await agent.post('/api/expenses').send({
          expenseType: 'Fuel',
          amountNgn: 40_000,
          date: '2026-03-29',
          category: 'Operational — rent & utilities',
          paymentMethod: 'Cash',
          reference: 'EX-A19',
        });
        expect(ex.status).toBe(201);
        const pr = await agent.post('/api/payment-requests').send({
          expenseID: ex.body.expenseID,
          amountRequestedNgn: 40_000,
          requestDate: '2026-03-29',
          description: 'Unapproved pay attempt',
        });
        expect(pr.status).toBe(201);
        const pay = await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/pay`).send({
          treasuryAccountId: cash.id,
          amountNgn: 40_000,
          reference: 'SKIP-APR',
        });
        expect(pay.status).toBe(400);
      },
    },
    {
      id: 'ARC-20',
      title: 'Period lock stops back-dated postings (month-end control)',
      run: async () => {
        const { agent } = await createSession();
        expect(
          (await agent.post('/api/controls/period-locks').send({ periodKey: '2026-04', reason: 'Close' })).status
        ).toBe(201);
        const blocked = await agent.post('/api/expenses').send({
          expenseType: 'Backdated',
          amountNgn: 3000,
          date: '2026-04-10',
          category: 'Operational — rent & utilities',
          paymentMethod: 'Cash',
          treasuryAccountId: 1,
          reference: 'BLK',
        });
        expect(blocked.status).toBe(400);
        expect(String(blocked.body.error || '')).toMatch(/locked period/i);
        expect(
          (await agent.delete('/api/controls/period-locks/2026-04').send({ reason: 'Reopen' })).status
        ).toBe(200);
        const ok = await agent.post('/api/expenses').send({
          expenseType: 'After unlock',
          amountNgn: 3000,
          date: '2026-04-10',
          category: 'Operational — rent & utilities',
          paymentMethod: 'Cash',
          treasuryAccountId: 1,
          reference: 'OK',
        });
        expect(ok.status).toBe(201);
      },
    },
    {
      id: 'ARC-21',
      title: 'Cashier correction: reverse receipt re-opens quotation balance',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A21');
        const cid = await createCustomer(agent, 'ARC21', 'Wrong quote receipt');
        const q = await createQuotation(agent, cid, 'ARC21', {
          products: [{ name: 'Sheet', qty: '10', unitPrice: '10000' }],
          accessories: [],
          services: [],
        });
        const rc = await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 100_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 100_000, reference: 'A21' }],
        });
        expect(rc.status).toBe(201);
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBe(0);
        const rev = await agent.post('/api/ledger/reverse-receipt').send({
          entryId: rc.body.receipt.id,
          note: 'Posted to wrong quote — reversing',
        });
        expect(rev.status).toBe(201);
        expect(amountDueFor(await customerSummary(agent, cid), q.quotationId)).toBeGreaterThan(0);
      },
    },
    {
      id: 'ARC-22',
      title: 'Duplicate deposit panic — reverse advance removes balance',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A22');
        const cid = await createCustomer(agent, 'ARC22', 'Dup deposit');
        const adv = await agent.post('/api/ledger/advance').send({
          customerID: cid,
          amountNgn: 80_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 80_000, reference: 'DUP' }],
        });
        expect(adv.status).toBe(201);
        expect((await customerSummary(agent, cid)).advanceNgn).toBe(80_000);
        const rev = await agent.post('/api/ledger/reverse-advance').send({
          entryId: adv.body.entry.id,
          note: 'Duplicate bank alert',
        });
        expect(rev.status).toBe(201);
        expect((await customerSummary(agent, cid)).advanceNgn).toBe(0);
      },
    },
    {
      id: 'ARC-23',
      title: 'Picky customer: 72 individual lengths — system tolerates dense cutting list',
      run: async () => {
        const { agent } = await createSession();
        const snap = await bootstrap(agent);
        const fg = snap.products[0];
        const cid = await createCustomer(agent, 'ARC23', 'Picky list');
        const q = await createQuotation(agent, cid, 'ARC23', {
          products: [{ name: 'Roofing Sheet', qty: '88.8', unitPrice: '3000' }],
          accessories: [],
          services: [],
        });
        const cl = await createCuttingList(agent, {
          quotationRef: q.quotationId,
          customerID: cid,
          productID: fg.productID,
          productName: fg.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'Op',
          lines: buildExactLengths(72, 88.8),
        });
        expect(cl.cuttingList.totalMeters).toBeCloseTo(metersQuantizedToDecimeters(88.8), 4);
      },
    },
    {
      id: 'ARC-24',
      title: 'Yard walk-in: one sheet, one length, paid immediately',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A24');
        const snap = await bootstrap(agent);
        const fg = snap.products[0];
        const cid = await createCustomer(agent, 'ARC24', 'Walk-in');
        const q = await createQuotation(agent, cid, 'ARC24', {
          products: [{ name: 'Sheet', qty: '8', unitPrice: '12000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 96_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 96_000, reference: 'A24' }],
        });
        await createCuttingList(agent, {
          quotationRef: q.quotationId,
          customerID: cid,
          productID: fg.productID,
          productName: fg.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'Op',
          lines: [{ sheets: 1, lengthM: 8 }],
        });
      },
    },
    {
      id: 'ARC-25',
      title: 'Paper trail: quotation marked Approved after customer sign-off',
      run: async () => {
        const { agent } = await createSession();
        const cid = await createCustomer(agent, 'ARC25', 'Signed off');
        const q = await createQuotation(agent, cid, 'ARC25', {
          products: [{ name: 'Sheet', qty: '5', unitPrice: '40000' }],
          accessories: [],
          services: [],
        });
        const patch = await agent.patch(`/api/quotations/${encodeURIComponent(q.quotationId)}`).send({
          status: 'Approved',
          customerFeedback: 'Customer approved verbally on site',
        });
        expect(patch.status).toBe(200);
        expect(patch.body.quotation.status).toBe('Approved');
      },
    },
    {
      id: 'ARC-26',
      title: 'Oversight: finance role reads audit log on same org session after cash posting',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const [acc] = await ensureTreasuryAccounts(admin, 1, 'A26');
        const cid = await createCustomer(admin, 'ARC26', 'Audited');
        const q = await createQuotation(admin, cid, 'ARC26', {
          products: [{ name: 'X', qty: '1', unitPrice: '50000' }],
          accessories: [],
          services: [],
        });
        await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 50_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 50_000, reference: 'A26' }],
        });
        const finance = request.agent(app);
        await loginAs(finance, 'finance.manager', 'Finance@123');
        const log = await finance.get('/api/audit-log');
        expect(log.status).toBe(200);
        expect(Array.isArray(log.body.auditLog)).toBe(true);
        expect(log.body.auditLog.length).toBeGreaterThan(0);
      },
    },
    {
      id: 'ARC-27',
      title: 'Internal control: treasury transfer leaves paired movements',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 2, 'A27');
        const tr = await agent.post('/api/treasury/transfer').send({
          fromId: accs[0].id,
          toId: accs[1].id,
          amountNgn: 333_333,
          reference: 'Float sweep A27',
        });
        expect(tr.status).toBe(201);
        const snap = await bootstrap(agent);
        const moves = snap.treasuryMovements.filter((m) => m.sourceKind === 'TREASURY_TRANSFER');
        expect(moves.length).toBeGreaterThanOrEqual(2);
      },
    },
    {
      id: 'ARC-28',
      title: 'Ops expense: request → approve → pay single leg',
      run: async () => {
        const { agent } = await createSession();
        const boot = await bootstrap(agent);
        const cash = boot.treasuryAccounts[0];
        const ex = await agent.post('/api/expenses').send({
          expenseType: 'Repairs',
          amountNgn: 22_000,
          date: '2026-03-29',
          category: 'Maintenance — plant & equipment',
          paymentMethod: 'Cash',
          reference: 'EX-A28',
        });
        expect(ex.status).toBe(201);
        const pr = await agent.post('/api/payment-requests').send({
          expenseID: ex.body.expenseID,
          amountRequestedNgn: 22_000,
          requestDate: '2026-03-29',
          description: 'Approved path',
        });
        expect(pr.status).toBe(201);
        await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/decision`).send({
          status: 'Approved',
          note: 'ok',
        });
        const pay = await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/pay`).send({
          treasuryAccountId: cash.id,
          amountNgn: 22_000,
          reference: 'PAY-A28',
        });
        expect(pay.status).toBe(201);
      },
    },
    {
      id: 'ARC-29',
      title: 'Approved refund paid in two treasury legs (staged customer service)',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 2, 'A29');
        const cid = await createCustomer(agent, 'ARC29', 'Split refund');
        const q29 = await createQuotation(agent, cid, 'ARC29', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '200000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q29.quotationId,
          amountNgn: 200_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accs[0].id, amountNgn: 200_000, reference: 'A29-PAY' }],
        });
        const snap29 = await bootstrap(agent);
        const fg29 = snap29.products[0];
        const cl29 = await createCuttingList(agent, {
          quotationRef: q29.quotationId,
          customerID: cid,
          productID: fg29.productID,
          productName: fg29.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j29 = await createProductionJob(agent, {
          cuttingListId: cl29.id,
          productID: fg29.productID,
          productName: fg29.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(agent, j29.jobID);
        const rf = await agent.post('/api/refunds').send({
          customerID: cid,
          customer: 'Split refund',
          quotationRef: q29.quotationId,
          reasonCategory: 'Adjustment',
          reason: 'Customer wants two banks',
          amountNgn: 180_000,
          calculationLines: [
            { label: 'A', amountNgn: 100_000 },
            { label: 'B', amountNgn: 80_000 },
          ],
        });
        expect(rf.status).toBe(201);
        await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'ok',
        });
        const p1 = await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          paymentLines: [{ treasuryAccountId: accs[0].id, amountNgn: 100_000, reference: 'RF29-1' }],
        });
        expect(p1.status).toBe(201);
        expect(p1.body.fullyPaid).toBe(false);
        const p2 = await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          paymentLines: [{ treasuryAccountId: accs[1].id, amountNgn: 80_000, reference: 'RF29-2' }],
        });
        expect(p2.status).toBe(201);
        expect(p2.body.fullyPaid).toBe(true);
      },
    },
    {
      id: 'ARC-30',
      title: 'Yield anomaly: production preview demands manager review (estimator vs reality)',
      run: async () => {
        const { agent } = await createSession();
        const snap = await bootstrap(agent);
        const coilProduct = snap.products.find((p) => p.productID === 'COIL-ALU') || snap.products[0];
        const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
        const sup = await createSupplier(agent, 'A30', 'Kano');
        const po = await createPurchaseOrder(agent, {
          supplierID: sup.supplierID,
          supplierName: sup.supplierName,
          orderDateISO: '2026-03-29',
          expectedDeliveryISO: '2026-04-01',
          status: 'Approved',
          lines: [
            {
              lineKey: 'L-A30',
              productID: coilProduct.productID,
              productName: coilProduct.name,
              qtyOrdered: 5000,
              unitPricePerKgNgn: 1800,
              unitPriceNgn: 1800,
              qtyReceived: 0,
            },
          ],
        });
        await confirmGrn(agent, po.poID, {
          entries: [
            {
              lineKey: 'L-A30',
              productID: coilProduct.productID,
              qtyReceived: 5000,
              weightKg: 5000,
              coilNo: 'CL-ARC30-YIELD',
              location: 'Bay',
              gaugeLabel: '0.24mm',
              materialTypeName: 'Aluminium',
              supplierExpectedMeters: 2200,
            },
          ],
          supplierID: sup.supplierID,
          supplierName: sup.supplierName,
        });
        const cid = await createCustomer(agent, 'ARC30', 'Yield check');
        const q = await createQuotation(agent, cid, 'ARC30', {
          products: [{ name: 'Sheet', qty: '4', unitPrice: '5000' }],
          accessories: [],
          services: [],
        });
        const cl = await createCuttingList(agent, {
          quotationRef: q.quotationId,
          customerID: cid,
          productID: fg.productID,
          productName: fg.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'Op',
          lines: [{ sheets: 1, lengthM: 4 }],
        });
        const job = await createProductionJob(agent, {
          cuttingListId: cl.id,
          productID: fg.productID,
          productName: fg.name,
          plannedMeters: 4,
          plannedSheets: 1,
          status: 'Planned',
        });
        await saveJobAllocations(agent, job.jobID, [{ coilNo: 'CL-ARC30-YIELD', openingWeightKg: 4000 }]);
        await startProductionJob(agent, job.jobID);
        const prev = await agent.post(`/api/production-jobs/${encodeURIComponent(job.jobID)}/conversion-preview`).send({
          allocations: [{ coilNo: 'CL-ARC30-YIELD', closingWeightKg: 0, metersProduced: 45 }],
        });
        expect(prev.status).toBe(200);
        expect(prev.body.managerReviewRequired).toBe(true);
      },
    },
    {
      id: 'ARC-31',
      title: 'Dual control: sales raises refund → sales manager approves → finance pays (one org DB)',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const snapAdm = await bootstrap(admin);
        const treasuryId = snapAdm.treasuryAccounts[0].id;
        const fg31 = snapAdm.products[0];
        const cid = await createCustomer(admin, 'ARC31', 'Walk-in refund story');
        const q31 = await createQuotation(admin, cid, 'ARC31', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '100000' }],
          accessories: [],
          services: [],
        });
        await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q31.quotationId,
          amountNgn: 100_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: treasuryId, amountNgn: 100_000, reference: 'A31-PAY' }],
        });
        const cl31 = await createCuttingList(admin, {
          quotationRef: q31.quotationId,
          customerID: cid,
          productID: fg31.productID,
          productName: fg31.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j31 = await createProductionJob(admin, {
          cuttingListId: cl31.id,
          productID: fg31.productID,
          productName: fg31.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(admin, j31.jobID);

        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const rf = await staff.post('/api/refunds').send({
          customerID: cid,
          customer: 'Walk-in refund story',
          quotationRef: q31.quotationId,
          reasonCategory: 'Overpayment',
          reason: 'Customer paid twice by mistake',
          amountNgn: 75_000,
          calculationLines: [{ label: 'Duplicate transfer', amountNgn: 75_000 }],
        });
        expect(rf.status).toBe(201);
        const mgr = request.agent(app);
        await loginAs(mgr, 'sales.manager', 'Sales@123');
        const dec = await mgr.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'Verified with bank alert',
          approvalDate: '2026-03-29',
          approvedAmountNgn: 75_000,
        });
        expect(dec.status).toBe(200);
        const fin = request.agent(app);
        await loginAs(fin, 'finance.manager', 'Finance@123');
        const pay = await fin.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: treasuryId,
          reference: 'RF-ARC31',
        });
        expect(pay.status).toBe(201);
      },
    },
    {
      id: 'ARC-32',
      title: 'Sales cannot browse audit log (403) — reduces fishing for abuse targets',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const res = await staff.get('/api/audit-log');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    },
    {
      id: 'ARC-33',
      title: 'Sales officer cannot approve refunds (403) — must escalate to manager/finance',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const [acc33] = await ensureTreasuryAccounts(admin, 1, 'A33');
        const cid = await createCustomer(admin, 'ARC33', 'No self-approval');
        const q33 = await createQuotation(admin, cid, 'ARC33', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '10000' }],
          accessories: [],
          services: [],
        });
        await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q33.quotationId,
          amountNgn: 10_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc33.id, amountNgn: 10_000, reference: 'A33-PAY' }],
        });
        const snap33 = await bootstrap(admin);
        const fg33 = snap33.products[0];
        const cl33 = await createCuttingList(admin, {
          quotationRef: q33.quotationId,
          customerID: cid,
          productID: fg33.productID,
          productName: fg33.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j33 = await createProductionJob(admin, {
          cuttingListId: cl33.id,
          productID: fg33.productID,
          productName: fg33.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(admin, j33.jobID);

        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const rf = await staff.post('/api/refunds').send({
          customerID: cid,
          customer: 'No self-approval',
          quotationRef: q33.quotationId,
          reasonCategory: 'Adjustment',
          reason: 'Try to self-approve',
          amountNgn: 5000,
          calculationLines: [{ label: 'x', amountNgn: 5000 }],
        });
        expect(rf.status).toBe(201);
        const bad = await staff.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'Self approve',
          approvalDate: '2026-03-29',
        });
        expect(bad.status).toBe(403);
      },
    },
    {
      id: 'ARC-34',
      title: 'Finance cannot invent refund requests (403) — only sales-facing roles request',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const fin = request.agent(app);
        await loginAs(fin, 'finance.manager', 'Finance@123');
        const res = await fin.post('/api/refunds').send({
          customerID: 'CUS-001',
          customer: 'Seeded',
          quotationRef: 'QT-2026-001',
          reasonCategory: 'Adjustment',
          reason: 'Finance-created (should fail)',
          amountNgn: 1000,
          calculationLines: [{ label: 'x', amountNgn: 1000 }],
        });
        expect(res.status).toBe(403);
      },
    },
    {
      id: 'ARC-35',
      title: 'Rejected refund cannot be paid — manager says no',
      run: async () => {
        const { agent } = await createSession();
        const [acc] = await ensureTreasuryAccounts(agent, 1, 'A35');
        const cid = await createCustomer(agent, 'ARC35', 'Rejected payout');
        const q35 = await createQuotation(agent, cid, 'ARC35', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '1000000' }],
          accessories: [],
          services: [],
        });
        await agent.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q35.quotationId,
          amountNgn: 1_000_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 1_000_000, reference: 'A35-PAY' }],
        });
        const snap35 = await bootstrap(agent);
        const fg35 = snap35.products[0];
        const cl35 = await createCuttingList(agent, {
          quotationRef: q35.quotationId,
          customerID: cid,
          productID: fg35.productID,
          productName: fg35.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j35 = await createProductionJob(agent, {
          cuttingListId: cl35.id,
          productID: fg35.productID,
          productName: fg35.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(agent, j35.jobID);
        const rf = await agent.post('/api/refunds').send({
          customerID: cid,
          customer: 'Rejected payout',
          quotationRef: q35.quotationId,
          reasonCategory: 'Adjustment',
          reason: 'Suspicious pattern',
          amountNgn: 900_000,
          calculationLines: [{ label: 'Claim', amountNgn: 900_000 }],
        });
        expect(rf.status).toBe(201);
        await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Rejected',
          managerComments: 'Insufficient evidence — do not pay',
          approvalDate: '2026-03-29',
        });
        const pay = await agent.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: acc.id,
          reference: 'SHOULD-FAIL',
        });
        expect(pay.status).toBe(400);
      },
    },
    {
      id: 'ARC-36',
      title: 'Rejected payment request cannot be paid — finance sends back to ops',
      run: async () => {
        const { agent } = await createSession();
        const boot = await bootstrap(agent);
        const cash = boot.treasuryAccounts[0];
        const ex = await agent.post('/api/expenses').send({
          expenseType: 'Doubtful',
          amountNgn: 99_000,
          date: '2026-03-29',
          category: 'Maintenance — plant & equipment',
          paymentMethod: 'Cash',
          reference: 'EX-A36',
        });
        expect(ex.status).toBe(201);
        const pr = await agent.post('/api/payment-requests').send({
          expenseID: ex.body.expenseID,
          amountRequestedNgn: 99_000,
          requestDate: '2026-03-29',
          description: 'Rejected later',
        });
        expect(pr.status).toBe(201);
        await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/decision`).send({
          status: 'Rejected',
          note: 'Wrong cost centre',
        });
        const pay = await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/pay`).send({
          treasuryAccountId: cash.id,
          amountNgn: 99_000,
          reference: 'NOPE-A36',
        });
        expect(pay.status).toBe(400);
      },
    },
    {
      id: 'ARC-37',
      title: 'Operations cannot post customer receipts (403) — yard ≠ cashier',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const ops = request.agent(app);
        await loginAs(ops, 'operations', 'Ops@123');
        const res = await ops.post('/api/ledger/receipt').send({
          customerID: 'CUS-001',
          quotationId: 'QT-2026-001',
          amountNgn: 1000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
        });
        expect(res.status).toBe(403);
      },
    },
    {
      id: 'ARC-38',
      title: 'Operations cannot create quotations (403) — pricing stays with sales',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const ops = request.agent(app);
        await loginAs(ops, 'operations', 'Ops@123');
        const res = await ops.post('/api/quotations').send({
          customerID: 'CUS-001',
          projectName: 'Ops tries quote',
          dateISO: '2026-03-29',
          lines: { products: [{ name: 'X', qty: '1', unitPrice: '1' }], accessories: [], services: [] },
        });
        expect(res.status).toBe(403);
      },
    },
    {
      id: 'ARC-39',
      title: 'Payment request: two payout tranches after one approval (treasury discipline)',
      run: async () => {
        const { agent } = await createSession();
        const accs = await ensureTreasuryAccounts(agent, 2, 'A39');
        const ex = await agent.post('/api/expenses').send({
          expenseType: 'Generator',
          amountNgn: 500_000,
          date: '2026-03-29',
          category: 'Maintenance — plant & equipment',
          paymentMethod: 'Mixed',
          reference: 'EX-A39',
        });
        expect(ex.status).toBe(201);
        const pr = await agent.post('/api/payment-requests').send({
          expenseID: ex.body.expenseID,
          amountRequestedNgn: 500_000,
          requestDate: '2026-03-29',
          description: 'Staged diesel payout',
        });
        expect(pr.status).toBe(201);
        await approvePaymentRequest(agent, pr.body.requestID);
        const p1 = await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/pay`).send({
          paymentLines: [{ treasuryAccountId: accs[0].id, amountNgn: 310_000, reference: 'A39-1' }],
        });
        expect(p1.status).toBe(201);
        const p2 = await agent.post(`/api/payment-requests/${encodeURIComponent(pr.body.requestID)}/pay`).send({
          paymentLines: [{ treasuryAccountId: accs[1].id, amountNgn: 190_000, reference: 'A39-2' }],
        });
        expect(p2.status).toBe(201);
        const snap = await bootstrap(agent);
        const row = snap.paymentRequests.find((r) => r.requestID === pr.body.requestID);
        expect(row.paidAmountNgn).toBe(500_000);
      },
    },
    {
      id: 'ARC-40',
      title: 'Privileged reversal: sales cannot reverse receipts (403) — only finance.reverse',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const [acc] = await ensureTreasuryAccounts(admin, 1, 'A40');
        const cid = await createCustomer(admin, 'ARC40', 'Receipt reversal RBAC');
        const q = await createQuotation(admin, cid, 'ARC40', {
          products: [{ name: 'X', qty: '1', unitPrice: '25000' }],
          accessories: [],
          services: [],
        });
        const rc = await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q.quotationId,
          amountNgn: 25_000,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: acc.id, amountNgn: 25_000, reference: 'A40' }],
        });
        expect(rc.status).toBe(201);
        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const bad = await staff.post('/api/ledger/reverse-receipt').send({
          entryId: rc.body.receipt.id,
          note: 'Try to hide cash',
        });
        expect(bad.status).toBe(403);
      },
    },
    {
      id: 'ARC-41',
      title: 'Procurement cannot lock accounting periods (403)',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const proc = request.agent(app);
        await loginAs(proc, 'procurement', 'Procure@123');
        const res = await proc.post('/api/controls/period-locks').send({
          periodKey: '2099-01',
          reason: 'Should not allow',
        });
        expect(res.status).toBe(403);
      },
    },
    {
      id: 'ARC-42',
      title: 'No session cookie → bootstrap returns 401 (stop anonymous data scrape)',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const res = await request(app).get('/api/bootstrap');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH_REQUIRED');
      },
    },
    {
      id: 'ARC-43',
      title: 'Apply advance when customer has no deposit — blocked (400)',
      run: async () => {
        const { agent } = await createSession();
        const cid = await createCustomer(agent, 'ARC43', 'No wallet');
        const q = await createQuotation(agent, cid, 'ARC43', {
          products: [{ name: 'Job', qty: '1', unitPrice: '100000' }],
          accessories: [],
          services: [],
        });
        const bad = await agent.post('/api/ledger/apply-advance').send({
          customerID: cid,
          quotationRef: q.quotationId,
          amountNgn: 1,
        });
        expect(bad.status).toBe(400);
      },
    },
    {
      id: 'ARC-44',
      title: 'Alternate line: sales requests → finance approves (no sales manager in path)',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const admin = request.agent(app);
        await loginAs(admin, 'admin', 'Admin@123');
        const snapAdm = await bootstrap(admin);
        const treasuryId = snapAdm.treasuryAccounts[0].id;
        const fg44 = snapAdm.products[0];
        const cid = await createCustomer(admin, 'ARC44', 'CFO approval line');
        const q44 = await createQuotation(admin, cid, 'ARC44', {
          products: [{ name: 'Sheet', qty: '1', unitPrice: '50000' }],
          accessories: [],
          services: [],
        });
        await admin.post('/api/ledger/receipt').send({
          customerID: cid,
          quotationId: q44.quotationId,
          amountNgn: 50_000,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: treasuryId, amountNgn: 50_000, reference: 'A44-PAY' }],
        });
        const cl44 = await createCuttingList(admin, {
          quotationRef: q44.quotationId,
          customerID: cid,
          productID: fg44.productID,
          productName: fg44.name,
          dateISO: '2026-03-29',
          machineName: 'M1',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const j44 = await createProductionJob(admin, {
          cuttingListId: cl44.id,
          productID: fg44.productID,
          productName: fg44.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelProductionJobForRefundEligibility(admin, j44.jobID);

        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const rf = await staff.post('/api/refunds').send({
          customerID: cid,
          customer: 'CFO approval line',
          quotationRef: q44.quotationId,
          reasonCategory: 'Adjustment',
          reason: 'End-of-month true-up',
          amountNgn: 42_000,
          calculationLines: [{ label: 'True-up', amountNgn: 42_000 }],
        });
        expect(rf.status).toBe(201);
        const fin = request.agent(app);
        await loginAs(fin, 'finance.manager', 'Finance@123');
        const dec = await fin.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/decision`).send({
          status: 'Approved',
          managerComments: 'Finance approval',
          approvalDate: '2026-03-29',
          approvedAmountNgn: 42_000,
        });
        expect(dec.status).toBe(200);
        const pay = await fin.post(`/api/refunds/${encodeURIComponent(rf.body.refundID)}/pay`).send({
          treasuryAccountId: treasuryId,
          reference: 'RF-ARC44',
        });
        expect(pay.status).toBe(201);
      },
    },
    {
      id: 'ARC-45',
      title: 'Sales officer cannot post expenses (403) — petty cash stays in finance',
      run: async () => {
        const app = createApp(createDatabase(':memory:'));
        const staff = request.agent(app);
        await loginAs(staff, 'sales.staff', 'Sales@123');
        const res = await staff.post('/api/expenses').send({
          expenseType: 'Fake fuel',
          amountNgn: 50_000,
          date: '2026-03-29',
          category: 'Operational — rent & utilities',
          paymentMethod: 'Cash',
          treasuryAccountId: 1,
          reference: 'BAD',
        });
        expect(res.status).toBe(403);
      },
    },
  ];
}

const ARCHETYPES = buildArchetypes();

describe('Customer service archetypes (45 personalities)', () => {
  beforeEach(() => {
    // This suite uses fixed 2026-03-29 dates; freeze time to prevent quotations drifting into Expired
    // and blocking updates (e.g. paidNgn patch used to satisfy cutting-list thresholds).
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

  it.each(ARCHETYPES)('$id — $title', async ({ run }) => {
    await run();
  }, 45_000);
});
