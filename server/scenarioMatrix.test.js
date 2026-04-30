import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const openDbs = [];

async function loginAs(agent, username = 'admin', password = 'Admin@123') {
  const res = await agent.post('/api/session/login').send({ username, password });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function createSession() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  const app = createApp(db);
  const agent = request.agent(app);
  await loginAs(agent);
  return { app, agent };
}

function mulberry32(seed) {
  return function rng() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
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

/** Meter total after rounding to decimeters (matches `buildExactLengths` line sum). */
function metersQuantizedToDecimeters(totalMeters) {
  return Math.round(Number(totalMeters) * 10) / 10;
}

async function bootstrap(agent) {
  const res = await agent.get('/api/bootstrap');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function ensureTreasuryAccounts(agent, count, scenarioKey) {
  const createdIds = [];
  for (let i = 0; i < count; i += 1) {
    const nextIndex = i + 1;
    const create = await agent.post('/api/treasury/accounts').send({
      name: `Scenario ${scenarioKey} Account ${nextIndex}`,
      bankName: `Scenario Bank ${nextIndex}`,
      type: nextIndex === 1 ? 'Cash' : 'Bank',
      accNo: `SCN-${scenarioKey}-${nextIndex}`,
      balance: 50_000_000,
    });
    expect(create.status).toBe(201);
    createdIds.push(create.body.id);
  }
  const snap = await bootstrap(agent);
  return snap.treasuryAccounts.filter((account) => createdIds.includes(account.id));
}

async function createCustomer(agent, scenarioKey, name) {
  const customerID = `CUS-${scenarioKey}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const salted = `${customerID}:${attempt}`;
    const phoneNumber = `080${String(Math.abs(hashCode(salted))).slice(0, 8).padEnd(8, '0')}`;
    const res = await agent.post('/api/customers').send({
      customerID,
      name,
      phoneNumber,
      email: `${customerID.toLowerCase()}@example.com`,
      addressShipping: `${scenarioKey} yard`,
      addressBilling: `${scenarioKey} billing`,
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

async function createQuotation(agent, customerID, scenarioKey, lines, projectName = scenarioKey) {
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

async function postReceipt(agent, payload) {
  const res = await agent.post('/api/ledger/receipt').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function postAdvance(agent, payload) {
  const res = await agent.post('/api/ledger/advance').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function applyAdvance(agent, payload) {
  const res = await agent.post('/api/ledger/apply-advance').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
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
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function createProductionJob(agent, payload) {
  const res = await agent.post('/api/production-jobs').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

/** Cancel a planned job so POST /api/refunds eligibility (Completed or Cancelled) is satisfied. */
async function cancelPlannedJobForRefundEligibility(agent, jobID) {
  const res = await agent.post(`/api/production-jobs/${encodeURIComponent(jobID)}/cancel`).send({
    reason: 'Scenario — close production for refund eligibility',
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function createExpense(agent, payload) {
  const res = await agent.post('/api/expenses').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function createPaymentRequest(agent, payload) {
  const res = await agent.post('/api/payment-requests').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function approvePaymentRequest(agent, requestID, note = 'Approved for payout.') {
  const res = await agent
    .post(`/api/payment-requests/${encodeURIComponent(requestID)}/decision`)
    .send({ status: 'Approved', note });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function payPaymentRequest(agent, requestID, payload) {
  const res = await agent.post(`/api/payment-requests/${encodeURIComponent(requestID)}/pay`).send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function createRefund(agent, payload) {
  const res = await agent.post('/api/refunds').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function approveRefund(agent, refundID, note = 'Approved after review.') {
  const res = await agent.post(`/api/refunds/${encodeURIComponent(refundID)}/decision`).send({
    status: 'Approved',
    managerComments: note,
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function payRefund(agent, refundID, payload) {
  const res = await agent.post(`/api/refunds/${encodeURIComponent(refundID)}/pay`).send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
}

async function payRefundStage(agent, refundID, payload) {
  const res = await agent.post(`/api/refunds/${encodeURIComponent(refundID)}/pay`).send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function saveJobAllocations(agent, jobId, allocations) {
  const res = await agent
    .post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`)
    .send({ allocations });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function startProductionJobApi(agent, jobId, body = {}) {
  const res = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send(body);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function assertProductionStartBlocked(agent, jobId) {
  const res = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({});
  expect(res.status).toBe(400);
  expect(res.body.ok).toBe(false);
}

async function conversionPreview(agent, jobId, body) {
  const res = await agent
    .post(`/api/production-jobs/${encodeURIComponent(jobId)}/conversion-preview`)
    .send(body);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function postRefundPreview(agent, payload) {
  const res = await agent.post('/api/refunds/preview').send(payload);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function createSupplier(agent, scenarioKey, city) {
  const res = await agent.post('/api/suppliers').send({
    name: `Supplier ${scenarioKey}`,
    city,
    paymentTerms: 'Cash',
    qualityScore: 85,
    notes: `Scenario ${scenarioKey}`,
  });
  expect(res.status).toBe(201);
  return { supplierID: res.body.supplierID, supplierName: `Supplier ${scenarioKey}` };
}

async function createPurchaseOrder(agent, payload) {
  const res = await agent.post('/api/purchase-orders').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  return res.body;
}

async function paySupplier(agent, poID, payload) {
  const res = await agent.post(`/api/purchase-orders/${encodeURIComponent(poID)}/supplier-payment`).send(payload);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function confirmGrn(agent, poID, payload) {
  const res = await agent.post(`/api/purchase-orders/${encodeURIComponent(poID)}/grn`).send(payload);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body;
}

function splitAmounts(total, pieces) {
  const rows = [];
  let remaining = total;
  for (let i = 0; i < pieces; i += 1) {
    if (i === pieces - 1) {
      rows.push(remaining);
    } else {
      const amount = Math.floor(remaining / (pieces - i));
      rows.push(amount);
      remaining -= amount;
    }
  }
  return rows;
}

function hashCode(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return h;
}

function buildScenarioMatrix() {
  const scenarios = [];
  const rng = mulberry32(20260329);

  scenarios.push({
    id: 'SCN-001',
    name: 'First-time customer with 50 cutting lengths totaling 1245.4 meters',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const fgProduct = snap.products[0];
      const customerID = await createCustomer(agent, 'SCN001', 'First Time Roofing Client');
      const quote = await createQuotation(
        agent,
        customerID,
        'SCN001',
        {
          products: [{ name: 'Longspan Roofing Sheet', qty: '1245.4', unitPrice: '4000' }],
          accessories: [],
          services: [],
        },
        '50-length roof order'
      );
      const lengths = buildExactLengths(50, 1245.4);
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Machine 01',
        operatorName: 'Estimator A',
        lines: lengths,
      });
      expect(cutting.cuttingList.totalMeters).toBeCloseTo(1245.4, 6);
    },
  });

  scenarios.push({
    id: 'SCN-002',
    name: 'Customer wants only 10 meter flatsheet',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const fgProduct = snap.products[0];
      const customerID = await createCustomer(agent, 'SCN002', 'Small Flatsheet Buyer');
      const quote = await createQuotation(agent, customerID, 'SCN002', {
        products: [{ name: 'Flat Sheet', qty: '10', unitPrice: '15000' }],
        accessories: [],
        services: [],
      });
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Machine 02',
        operatorName: 'Operator B',
        lines: [{ sheets: 1, lengthM: 10 }],
      });
      expect(cutting.cuttingList.totalMeters).toBe(10);
    },
  });

  scenarios.push({
    id: 'SCN-003',
    name: 'Split receipt of 3,000,000 across cash POS and transfer',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 3, 'SCN003');
      const customerID = await createCustomer(agent, 'SCN003', 'Split Tender Customer');
      const quote = await createQuotation(agent, customerID, 'SCN003', {
        products: [{ name: 'Roofing Sheet', qty: '600', unitPrice: '5000' }],
        accessories: [],
        services: [],
      });
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 3_000_000,
        paymentMethod: 'Split',
        dateISO: '2026-03-29',
        paymentLines: [
          { treasuryAccountId: accounts[0].id, amountNgn: 1_300_000, reference: 'CASH-1300' },
          { treasuryAccountId: accounts[1].id, amountNgn: 700_000, reference: 'POS-700' },
          { treasuryAccountId: accounts[2].id, amountNgn: 1_000_000, reference: 'TRF-1000' },
        ],
      });
      const summary = await customerSummary(agent, customerID);
      expect(amountDueFor(summary, quote.quotationId)).toBe(0);
      const snap = await bootstrap(agent);
      expect(
        snap.treasuryMovements.filter((m) => m.sourceKind === 'LEDGER_RECEIPT' && m.reference).length
      ).toBeGreaterThanOrEqual(3);
    },
  });

  scenarios.push({
    id: 'SCN-004',
    name: 'Underpayment of 299,500 against 300,000 quotation leaves 500 outstanding',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 1, 'SCN004');
      const customerID = await createCustomer(agent, 'SCN004', 'Underpayment Customer');
      const quote = await createQuotation(agent, customerID, 'SCN004', {
        products: [{ name: 'Roofing Sheet', qty: '60', unitPrice: '5000' }],
        accessories: [],
        services: [],
      });
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 299_500,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 299_500, reference: 'UF-299500' }],
      });
      const summary = await customerSummary(agent, customerID);
      expect(amountDueFor(summary, quote.quotationId)).toBe(500);
    },
  });

  scenarios.push({
    id: 'SCN-005',
    name: 'Deposit before exact meter is known then apply advance to final quotation',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 1, 'SCN005');
      const customerID = await createCustomer(agent, 'SCN005', 'Deposit First Customer');
      await postAdvance(agent, {
        customerID,
        amountNgn: 500_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 500_000, reference: 'DEP-500' }],
      });
      const quote = await createQuotation(agent, customerID, 'SCN005', {
        products: [{ name: 'Roofing Sheet', qty: '92', unitPrice: '5000' }],
        accessories: [],
        services: [],
      });
      await applyAdvance(agent, {
        customerID,
        quotationRef: quote.quotationId,
        amountNgn: 460_000,
      });
      const summary = await customerSummary(agent, customerID);
      expect(summary.advanceNgn).toBe(40_000);
      expect(amountDueFor(summary, quote.quotationId)).toBe(0);
    },
  });

  scenarios.push({
    id: 'SCN-006',
    name: 'Large quotation overpaid then corrected by approved refund workflow',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 2, 'SCN006');
      const snap = await bootstrap(agent);
      const fgProduct = snap.products[0];
      const customerID = await createCustomer(agent, 'SCN006', 'Major Project Client');
      const quote = await createQuotation(agent, customerID, 'SCN006', {
        products: [{ name: 'Roofing Sheet 0.24', qty: '2000', unitPrice: '4000' }],
        accessories: [{ name: 'Accessories pack', qty: '1', unitPrice: '1000000' }],
        services: [{ name: 'Transport and installation', qty: '1', unitPrice: '1000000' }],
      });
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 5_000_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 5_000_000, reference: 'MAJOR-5M' }],
      });
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 6_000_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[1].id, amountNgn: 6_000_000, reference: 'MAJOR-6M' }],
      });
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Machine 03',
        operatorName: 'Estimator C',
        lines: buildExactLengths(19, 1900),
      });
      expect(cutting.cuttingList.totalMeters).toBe(1900);
      const jobScn6 = await createProductionJob(agent, {
        cuttingListId: cutting.id,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        plannedMeters: 100,
        plannedSheets: 10,
      });
      await cancelPlannedJobForRefundEligibility(agent, jobScn6.jobID);
      const refund = await createRefund(agent, {
        customerID,
        customer: 'Major Project Client',
        quotationRef: quote.quotationId,
        cuttingListRef: cutting.id,
        reasonCategory: 'Overpayment',
        reason: 'Correct excess payment and actual meter shortfall.',
        amountNgn: 1_000_000,
        calculationLines: [{ label: 'Advance to refund', amountNgn: 1_000_000 }],
      });
      await approveRefund(agent, refund.refundID, 'Approved after site measurement correction.');
      await payRefund(agent, refund.refundID, {
        treasuryAccountId: accounts[0].id,
        reference: 'RF-SCN006',
      });
      const after = await bootstrap(agent);
      const row = after.refunds.find((item) => item.refundID === refund.refundID);
      expect(row.status).toBe('Paid');
    },
  });

  for (let i = 0; i < 18; i += 1) {
    const scenarioNumber = i + 7;
    const totalNgn = randInt(rng, 150, 3000) * 1000;
    const splitCount = i % 3 === 0 ? 2 : 1;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `First-time customer quote settled in full ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, splitCount, `N${i + 1}`);
        const customerID = await createCustomer(agent, `NEW${i + 1}`, `New Customer ${i + 1}`);
        const quote = await createQuotation(agent, customerID, `NEW${i + 1}`, {
          products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: String(totalNgn) }],
          accessories: [],
          services: [],
        });
        const splitValues = splitAmounts(totalNgn, splitCount);
        await postReceipt(agent, {
          customerID,
          quotationId: quote.quotationId,
          amountNgn: totalNgn,
          paymentMethod: splitCount > 1 ? 'Split' : 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: splitValues.map((amount, idx) => ({
            treasuryAccountId: accounts[idx].id,
            amountNgn: amount,
            reference: `NEW-${i + 1}-${idx + 1}`,
          })),
        });
        const summary = await customerSummary(agent, customerID);
        expect(amountDueFor(summary, quote.quotationId)).toBe(0);
      },
    });
  }

  for (let i = 0; i < 14; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const firstQuoteTotal = randInt(rng, 250, 1500) * 1000;
    const secondQuoteTotal = randInt(rng, 300, 2500) * 1000;
    const delta = randInt(rng, 1, 50) * 1000;
    const overpay = i % 2 === 1;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `Returning customer ${overpay ? 'overpay' : 'underpay'} scenario ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, 2, `RET${i + 1}`);
        const customerID = await createCustomer(agent, `RET${i + 1}`, `Returning Customer ${i + 1}`);
        const firstQuote = await createQuotation(agent, customerID, `RET${i + 1}-A`, {
          products: [{ name: 'Starter Order', qty: '1', unitPrice: String(firstQuoteTotal) }],
          accessories: [],
          services: [],
        });
        await postReceipt(agent, {
          customerID,
          quotationId: firstQuote.quotationId,
          amountNgn: firstQuoteTotal,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: firstQuoteTotal, reference: `RET-A-${i + 1}` }],
        });

        const secondQuote = await createQuotation(agent, customerID, `RET${i + 1}-B`, {
          products: [{ name: 'Repeat Order', qty: '1', unitPrice: String(secondQuoteTotal) }],
          accessories: [],
          services: [],
        });
        const amountPaid = overpay ? secondQuoteTotal + delta : secondQuoteTotal - delta;
        await postReceipt(agent, {
          customerID,
          quotationId: secondQuote.quotationId,
          amountNgn: amountPaid,
          paymentMethod: 'Split',
          dateISO: '2026-03-29',
          paymentLines: [
            { treasuryAccountId: accounts[0].id, amountNgn: Math.floor(amountPaid / 2), reference: `RET-B1-${i + 1}` },
            { treasuryAccountId: accounts[1].id, amountNgn: amountPaid - Math.floor(amountPaid / 2), reference: `RET-B2-${i + 1}` },
          ],
        });
        const summary = await customerSummary(agent, customerID);
        if (overpay) {
          expect(summary.advanceNgn).toBe(delta);
          expect(amountDueFor(summary, secondQuote.quotationId)).toBe(0);
        } else {
          expect(amountDueFor(summary, secondQuote.quotationId)).toBe(delta);
        }
      },
    });
  }

  for (let i = 0; i < 12; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const deposit = randInt(rng, 200, 2000) * 1000;
    const quoteTotal = randInt(rng, 150, 2200) * 1000;
    const applyAmount = Math.min(deposit, quoteTotal);
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `Advance deposit then quote application ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, 1, `ADV${i + 1}`);
        const customerID = await createCustomer(agent, `ADV${i + 1}`, `Advance Customer ${i + 1}`);
        await postAdvance(agent, {
          customerID,
          amountNgn: deposit,
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: deposit, reference: `ADV-${i + 1}` }],
        });
        const quote = await createQuotation(agent, customerID, `ADV${i + 1}`, {
          products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: String(quoteTotal) }],
          accessories: [],
          services: [],
        });
        await applyAdvance(agent, {
          customerID,
          quotationRef: quote.quotationId,
          amountNgn: applyAmount,
        });
        const summary = await customerSummary(agent, customerID);
        expect(summary.advanceNgn).toBe(deposit - applyAmount);
        expect(amountDueFor(summary, quote.quotationId)).toBe(quoteTotal - applyAmount);
      },
    });
  }

  for (let i = 0; i < 15; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const lineCount = randInt(rng, 5, 20);
    const totalMeters = randInt(rng, 800, 15000) / 10;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `Cutting list registration and production job ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const snap = await bootstrap(agent);
        const fgProduct = snap.products[0];
        const customerID = await createCustomer(agent, `CUT${i + 1}`, `Cutting Customer ${i + 1}`);
        const quote = await createQuotation(agent, customerID, `CUT${i + 1}`, {
          products: [{ name: 'Roofing Sheet', qty: String(totalMeters), unitPrice: '4000' }],
          accessories: [],
          services: [],
        });
        const cutting = await createCuttingList(agent, {
          quotationRef: quote.quotationId,
          customerID,
          productID: fgProduct.productID,
          productName: fgProduct.name,
          dateISO: '2026-03-29',
          machineName: 'Machine 04',
          operatorName: 'Operator D',
          lines: buildExactLengths(lineCount, totalMeters),
        });
        expect(cutting.cuttingList.totalMeters).toBeCloseTo(totalMeters, 6);
        const job = await createProductionJob(agent, {
          cuttingListId: cutting.id,
          productID: fgProduct.productID,
          productName: fgProduct.name,
          plannedMeters: totalMeters,
          plannedSheets: lineCount,
          status: 'Planned',
        });
        const after = await bootstrap(agent);
        const row = after.cuttingLists.find((item) => item.id === cutting.id);
        expect(row.productionRegistered).toBe(true);
        expect(row.productionRegisterRef).toBe(job.jobID);
      },
    });
  }

  for (let i = 0; i < 15; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const amount = randInt(rng, 100, 1200) * 1000;
    const partialFirst = i % 3 === 0;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `Expense request approval and treasury payout ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, 2, `REQ${i + 1}`);
        const expense = await createExpense(agent, {
          expenseType: 'Operational support',
          amountNgn: amount,
          date: '2026-03-29',
          category: i % 2 === 0 ? 'Operational — rent & utilities' : 'Maintenance — plant & equipment',
          paymentMethod: 'Mixed',
          reference: `EXP-REQ-${i + 1}`,
        });
        const reqRow = await createPaymentRequest(agent, {
          expenseID: expense.expenseID,
          amountRequestedNgn: amount,
          requestDate: '2026-03-29',
          description: `Scenario request ${i + 1}`,
        });
        await approvePaymentRequest(agent, reqRow.requestID);

        if (partialFirst) {
          const firstPart = Math.floor(amount * 0.6);
          await payPaymentRequest(agent, reqRow.requestID, {
            note: 'Initial payout tranche',
            paymentLines: [
              { treasuryAccountId: accounts[0].id, amountNgn: firstPart, reference: `REQ-P1-${i + 1}` },
            ],
          });
          await payPaymentRequest(agent, reqRow.requestID, {
            note: 'Final payout tranche',
            paymentLines: [
              { treasuryAccountId: accounts[1].id, amountNgn: amount - firstPart, reference: `REQ-P2-${i + 1}` },
            ],
          });
        } else {
          const firstLeg = Math.floor(amount * 0.5);
          await payPaymentRequest(agent, reqRow.requestID, {
            note: 'Split treasury payout',
            paymentLines: [
              { treasuryAccountId: accounts[0].id, amountNgn: firstLeg, reference: `REQ-S1-${i + 1}` },
              { treasuryAccountId: accounts[1].id, amountNgn: amount - firstLeg, reference: `REQ-S2-${i + 1}` },
            ],
          });
        }

        const after = await bootstrap(agent);
        const paid = after.paymentRequests.find((row) => row.requestID === reqRow.requestID);
        expect(paid.paidAmountNgn).toBe(amount);
        expect(paid.paidAtISO).toBeTruthy();
      },
    });
  }

  for (let i = 0; i < 10; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const amount = randInt(rng, 50, 900) * 1000;
    const assertBlocked = i % 2 === 0;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name: `Refund request lifecycle ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, 1, `RF${i + 1}`);
        const snap = await bootstrap(agent);
        const fgProduct = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
        const customerID = await createCustomer(agent, `RF${i + 1}`, `Refund Customer ${i + 1}`);
        const quote = await createQuotation(agent, customerID, `RF${i + 1}`, {
          products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: String(amount) }],
          accessories: [],
          services: [],
        });
        await postReceipt(agent, {
          customerID,
          quotationId: quote.quotationId,
          amountNgn: amount,
          paymentMethod: 'Cash',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: amount, reference: `RF-RCPT-${i + 1}` }],
        });
        const clRf = await createCuttingList(agent, {
          quotationRef: quote.quotationId,
          customerID,
          productID: fgProduct.productID,
          productName: fgProduct.name,
          dateISO: '2026-03-29',
          machineName: 'RF matrix',
          operatorName: 'QA',
          lines: [{ sheets: 1, lengthM: 5 }],
        });
        const pjRf = await createProductionJob(agent, {
          cuttingListId: clRf.id,
          productID: fgProduct.productID,
          productName: fgProduct.name,
          plannedMeters: 5,
          plannedSheets: 1,
        });
        await cancelPlannedJobForRefundEligibility(agent, pjRf.jobID);
        const refund = await createRefund(agent, {
          customerID,
          customer: `Refund Customer ${i + 1}`,
          quotationRef: quote.quotationId,
          reasonCategory: 'Adjustment',
          reason: `Scenario refund ${i + 1}`,
          amountNgn: amount,
          calculationLines: [{ label: 'Manual correction', amountNgn: amount }],
        });

        if (assertBlocked) {
          const blocked = await agent.post(`/api/refunds/${encodeURIComponent(refund.refundID)}/pay`).send({
            treasuryAccountId: accounts[0].id,
            reference: `RF-BLOCK-${i + 1}`,
          });
          expect(blocked.status).toBe(400);
        }

        await approveRefund(agent, refund.refundID);
        await payRefund(agent, refund.refundID, {
          treasuryAccountId: accounts[0].id,
          reference: `RF-PAY-${i + 1}`,
        });

        const after = await bootstrap(agent);
        const row = after.refunds.find((item) => item.refundID === refund.refundID);
        expect(row.status).toBe('Paid');
      },
    });
  }

  for (let i = 0; i < 10; i += 1) {
    const scenarioNumber = scenarios.length + 1;
    const qtyOrdered = randInt(rng, 800, 5000);
    const unitPrice = randInt(rng, 1750, 1900);
    const partialPay = i % 2 === 0 ? Math.floor(qtyOrdered * unitPrice * 0.3) : qtyOrdered * unitPrice;
    scenarios.push({
      id: `SCN-${String(scenarioNumber).padStart(3, '0')}`,
      name:
        i === 0
          ? 'Restock sourcing across Kano and Abuja suppliers with GRN receiving'
          : `Procurement, supplier settlement, and GRN ${i + 1}`,
      run: async () => {
        const { agent } = await createSession();
        const accounts = await ensureTreasuryAccounts(agent, 1, `PO${i + 1}`);
        const snap = await bootstrap(agent);
        const products = snap.products.slice(0, 3);

        if (i === 0) {
          const kano = await createSupplier(agent, 'PO-KANO', 'Kano');
          const abuja2 = await createSupplier(agent, 'PO-ABJ2', 'Abuja');
          const abuja3 = await createSupplier(agent, 'PO-ABJ3', 'Abuja');

          const poKano = await createPurchaseOrder(agent, {
            supplierID: kano.supplierID,
            supplierName: kano.supplierName,
            orderDateISO: '2026-03-29',
            expectedDeliveryISO: '2026-04-02',
            status: 'Approved',
            lines: [
              {
                lineKey: 'GB20',
                productID: products[0].productID,
                productName: products[0].name,
                qtyOrdered: 3000,
                unitPricePerKgNgn: 1800,
                unitPriceNgn: 1800,
                qtyReceived: 0,
              },
            ],
          });
          const poAbuja2 = await createPurchaseOrder(agent, {
            supplierID: abuja2.supplierID,
            supplierName: abuja2.supplierName,
            orderDateISO: '2026-03-29',
            expectedDeliveryISO: '2026-04-02',
            status: 'Approved',
            lines: [
              {
                lineKey: 'HM22',
                productID: products[1].productID,
                productName: products[1].name,
                qtyOrdered: 4200,
                unitPricePerKgNgn: 1850,
                unitPriceNgn: 1850,
                qtyReceived: 0,
              },
            ],
          });
          const poAbuja3 = await createPurchaseOrder(agent, {
            supplierID: abuja3.supplierID,
            supplierName: abuja3.supplierName,
            orderDateISO: '2026-03-29',
            expectedDeliveryISO: '2026-04-02',
            status: 'Approved',
            lines: [
              {
                lineKey: 'PG22',
                productID: products[2].productID,
                productName: products[2].name,
                qtyOrdered: 1800,
                unitPricePerKgNgn: 1820,
                unitPriceNgn: 1820,
                qtyReceived: 0,
              },
            ],
          });

          await paySupplier(agent, poKano.poID, {
            amountNgn: Math.floor(3000 * 1800 * 0.3),
            note: '30 percent paid before pickup',
            treasuryAccountId: accounts[0].id,
            reference: 'KANO-30PCT',
            dateISO: '2026-03-29',
          });
          await paySupplier(agent, poAbuja2.poID, {
            amountNgn: 4200 * 1850,
            note: 'Paid in full',
            treasuryAccountId: accounts[0].id,
            reference: 'ABJ2-FULL',
            dateISO: '2026-03-29',
          });
          await paySupplier(agent, poAbuja3.poID, {
            amountNgn: 1800 * 1820,
            note: 'Paid in full',
            treasuryAccountId: accounts[0].id,
            reference: 'ABJ3-FULL',
            dateISO: '2026-03-29',
          });

          await confirmGrn(agent, poKano.poID, {
            entries: [
              {
                lineKey: 'GB20',
                productID: products[0].productID,
                qtyReceived: 3000,
                weightKg: 2988,
                coilNo: 'CL-KANO-0001',
                location: 'Transit bay',
              },
            ],
            supplierID: kano.supplierID,
            supplierName: kano.supplierName,
          });
          await confirmGrn(agent, poAbuja2.poID, {
            entries: [
              {
                lineKey: 'HM22',
                productID: products[1].productID,
                qtyReceived: 4200,
                weightKg: 4187,
                coilNo: 'CL-ABJ2-0001',
                location: 'Main store',
              },
            ],
            supplierID: abuja2.supplierID,
            supplierName: abuja2.supplierName,
          });
          await confirmGrn(agent, poAbuja3.poID, {
            entries: [
              {
                lineKey: 'PG22',
                productID: products[2].productID,
                qtyReceived: 1800,
                weightKg: 1792,
                coilNo: 'CL-ABJ3-0001',
                location: 'Main store',
              },
            ],
            supplierID: abuja3.supplierID,
            supplierName: abuja3.supplierName,
          });

          const after = await bootstrap(agent);
          expect(after.purchaseOrders.find((row) => row.poID === poKano.poID)?.status).toBe('Received');
          expect(after.purchaseOrders.find((row) => row.poID === poAbuja2.poID)?.status).toBe('Received');
          expect(after.purchaseOrders.find((row) => row.poID === poAbuja3.poID)?.status).toBe('Received');
          expect(after.coilLots.some((row) => row.coilNo === 'CL-KANO-0001')).toBe(true);
          expect(after.coilLots.some((row) => row.coilNo === 'CL-ABJ2-0001')).toBe(true);
          expect(after.coilLots.some((row) => row.coilNo === 'CL-ABJ3-0001')).toBe(true);
          return;
        }

        const product = products[0];
        const supplier = await createSupplier(agent, `PO${i + 1}`, i % 2 === 0 ? 'Kano' : 'Abuja');
        const po = await createPurchaseOrder(agent, {
          supplierID: supplier.supplierID,
          supplierName: supplier.supplierName,
          orderDateISO: '2026-03-29',
          expectedDeliveryISO: '2026-03-31',
          status: 'Approved',
          lines: [
            {
              lineKey: `L-${i + 1}`,
              productID: product.productID,
              productName: product.name,
              qtyOrdered,
              unitPricePerKgNgn: unitPrice,
              unitPriceNgn: unitPrice,
              qtyReceived: 0,
            },
          ],
        });
        await paySupplier(agent, po.poID, {
          amountNgn: partialPay,
          note: `Scenario settlement ${i + 1}`,
          treasuryAccountId: accounts[0].id,
          reference: `PO-PAY-${i + 1}`,
          dateISO: '2026-03-29',
        });
        const beforeStock = (await bootstrap(agent)).products.find((row) => row.productID === product.productID).stockLevel;
        const receivedQty = qtyOrdered;
        const grn = await confirmGrn(agent, po.poID, {
          entries: [
            {
              lineKey: `L-${i + 1}`,
              productID: product.productID,
              qtyReceived: receivedQty,
              weightKg: receivedQty,
              coilNo: `CL-SCN-${i + 1}`,
              location: 'Main store',
            },
          ],
          supplierID: supplier.supplierID,
          supplierName: supplier.supplierName,
        });
        expect(grn.coilNos).toContain(`CL-SCN-${i + 1}`);
        const after = await bootstrap(agent);
        const poRow = after.purchaseOrders.find((row) => row.poID === po.poID);
        const productRow = after.products.find((row) => row.productID === product.productID);
        expect(poRow.status).toBe('Received');
        expect(productRow.stockLevel).toBe(beforeStock + receivedQty);
      },
    });
  }

  scenarios.push({
    id: 'SCN-VAL-01',
    name: 'Multi-coil allocation on one job and conversion preview',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const supplier = await createSupplier(agent, 'VAL01', 'Kano');
      const product = snap.products.find((p) => p.productID === 'COIL-ALU') || snap.products[0];
      const po = await createPurchaseOrder(agent, {
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '2026-04-01',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-VAL01',
            productID: product.productID,
            productName: product.name,
            qtyOrdered: 6000,
            unitPricePerKgNgn: 1800,
            unitPriceNgn: 1800,
            qtyReceived: 0,
          },
        ],
      });
      await confirmGrn(agent, po.poID, {
        entries: [
          {
            lineKey: 'L-VAL01',
            productID: product.productID,
            qtyReceived: 3000,
            weightKg: 3000,
            coilNo: 'CL-SCN-VAL01-A',
            location: 'Bay',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
          },
          {
            lineKey: 'L-VAL01',
            productID: product.productID,
            qtyReceived: 3000,
            weightKg: 3000,
            coilNo: 'CL-SCN-VAL01-B',
            location: 'Bay',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
          },
        ],
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
      });
      const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
      const customerID = await createCustomer(agent, 'VAL01', 'Val Customer 01');
      const quote = await createQuotation(agent, customerID, 'VAL01', {
        products: [{ name: 'Roofing Sheet', qty: '20', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'Machine VAL',
        operatorName: 'Op',
        lines: [{ sheets: 4, lengthM: 5 }],
      });
      const job = await createProductionJob(agent, {
        cuttingListId: cutting.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 20,
        plannedSheets: 4,
        status: 'Planned',
      });
      await saveJobAllocations(agent, job.jobID, [
        { coilNo: 'CL-SCN-VAL01-A', openingWeightKg: 1500 },
        { coilNo: 'CL-SCN-VAL01-B', openingWeightKg: 1500 },
      ]);
      await startProductionJobApi(agent, job.jobID, { startedAtISO: '2026-03-29' });
      const preview = await conversionPreview(agent, job.jobID, {
        allocations: [
          { coilNo: 'CL-SCN-VAL01-A', closingWeightKg: 520, metersProduced: 433 },
          { coilNo: 'CL-SCN-VAL01-B', closingWeightKg: 520, metersProduced: 433 },
        ],
      });
      expect(preview.rows).toHaveLength(2);
      expect(preview.rows[0].standardConversionKgPerM).toBeGreaterThan(0);
      expect(preview.rows[0].supplierConversionKgPerM).toBeGreaterThan(0);
    },
  });

  scenarios.push({
    id: 'SCN-VAL-02',
    name: 'Single coil serves two production jobs',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const supplier = await createSupplier(agent, 'VAL02', 'Abuja');
      const product = snap.products.find((p) => p.productID === 'COIL-ALU') || snap.products[0];
      const po = await createPurchaseOrder(agent, {
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '2026-04-01',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-VAL02',
            productID: product.productID,
            productName: product.name,
            qtyOrdered: 12000,
            unitPricePerKgNgn: 1800,
            unitPriceNgn: 1800,
            qtyReceived: 0,
          },
        ],
      });
      await confirmGrn(agent, po.poID, {
        entries: [
          {
            lineKey: 'L-VAL02',
            productID: product.productID,
            qtyReceived: 12000,
            weightKg: 12000,
            coilNo: 'CL-SCN-VAL02-SHARED',
            location: 'Store',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 5300,
          },
        ],
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
      });
      const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
      const customerID = await createCustomer(agent, 'VAL02', 'Val Customer 02');
      const quoteA = await createQuotation(agent, customerID, 'VAL02A', {
        products: [{ name: 'Roofing Sheet', qty: '25', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const quoteB = await createQuotation(agent, customerID, 'VAL02B', {
        products: [{ name: 'Roofing Sheet', qty: '25', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const cutting1 = await createCuttingList(agent, {
        quotationRef: quoteA.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 15 }],
      });
      const cutting2 = await createCuttingList(agent, {
        quotationRef: quoteB.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M2',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 10 }],
      });
      const job1 = await createProductionJob(agent, {
        cuttingListId: cutting1.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 15,
        plannedSheets: 1,
        status: 'Planned',
      });
      const job2 = await createProductionJob(agent, {
        cuttingListId: cutting2.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 10,
        plannedSheets: 1,
        status: 'Planned',
      });
      await saveJobAllocations(agent, job1.jobID, [{ coilNo: 'CL-SCN-VAL02-SHARED', openingWeightKg: 5000 }]);
      await saveJobAllocations(agent, job2.jobID, [{ coilNo: 'CL-SCN-VAL02-SHARED', openingWeightKg: 4000 }]);
      const after = await bootstrap(agent);
      const links = after.productionJobCoils.filter((c) => c.coilNo === 'CL-SCN-VAL02-SHARED');
      expect(links.length).toBe(2);
    },
  });

  scenarios.push({
    id: 'SCN-VAL-03',
    name: 'Production start blocked without coil allocation',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
      const customerID = await createCustomer(agent, 'VAL03', 'Val Customer 03');
      const quote = await createQuotation(agent, customerID, 'VAL03', {
        products: [{ name: 'Roofing Sheet', qty: '8', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 8 }],
      });
      const job = await createProductionJob(agent, {
        cuttingListId: cutting.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 8,
        plannedSheets: 1,
        status: 'Planned',
      });
      await assertProductionStartBlocked(agent, job.jobID);
    },
  });

  scenarios.push({
    id: 'SCN-VAL-04',
    name: 'Conversion preview escalates when yield breaches multiple references',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const supplier = await createSupplier(agent, 'VAL04', 'Kano');
      const product = snap.products.find((p) => p.productID === 'COIL-ALU') || snap.products[0];
      const po = await createPurchaseOrder(agent, {
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '2026-04-01',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-VAL04',
            productID: product.productID,
            productName: product.name,
            qtyOrdered: 8000,
            unitPricePerKgNgn: 1800,
            unitPriceNgn: 1800,
            qtyReceived: 0,
          },
        ],
      });
      await confirmGrn(agent, po.poID, {
        entries: [
          {
            lineKey: 'L-VAL04',
            productID: product.productID,
            qtyReceived: 8000,
            weightKg: 8000,
            coilNo: 'CL-SCN-VAL04-ALERT',
            location: 'Bay',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 3500,
          },
        ],
        supplierID: supplier.supplierID,
        supplierName: supplier.supplierName,
      });
      const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
      const customerID = await createCustomer(agent, 'VAL04', 'Val Customer 04');
      const quote = await createQuotation(agent, customerID, 'VAL04', {
        products: [{ name: 'Roofing Sheet', qty: '6', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 1, lengthM: 6 }],
      });
      const job = await createProductionJob(agent, {
        cuttingListId: cutting.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 6,
        plannedSheets: 1,
        status: 'Planned',
      });
      await saveJobAllocations(agent, job.jobID, [{ coilNo: 'CL-SCN-VAL04-ALERT', openingWeightKg: 6000 }]);
      await startProductionJobApi(agent, job.jobID, { startedAtISO: '2026-03-29' });
      const preview = await conversionPreview(agent, job.jobID, {
        allocations: [{ coilNo: 'CL-SCN-VAL04-ALERT', closingWeightKg: 0, metersProduced: 60 }],
      });
      expect(preview.managerReviewRequired).toBe(true);
      expect(['High', 'Low']).toContain(preview.aggregatedAlertState);
    },
  });

  scenarios.push({
    id: 'SCN-VAL-05',
    name: 'Approved refund settled with staged split treasury payout',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 2, 'VAL05');
      const snap = await bootstrap(agent);
      const fg = snap.products.find((p) => p.productID === 'FG-101') || snap.products[0];
      const customerID = await createCustomer(agent, 'VAL05', 'Val Customer 05');
      const quote = await createQuotation(agent, customerID, 'VAL05', {
        products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '450000' }],
        accessories: [],
        services: [],
      });
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 450_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 450_000, reference: 'VAL05-PAY' }],
      });
      const clV5 = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'QA',
        lines: [{ sheets: 1, lengthM: 5 }],
      });
      const pjV5 = await createProductionJob(agent, {
        cuttingListId: clV5.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 5,
        plannedSheets: 1,
      });
      await cancelPlannedJobForRefundEligibility(agent, pjV5.jobID);
      const refund = await createRefund(agent, {
        customerID,
        customer: 'Val Customer 05',
        quotationRef: quote.quotationId,
        reasonCategory: 'Adjustment',
        reason: 'Staged refund scenario',
        amountNgn: 450_000,
        calculationLines: [
          { label: 'Part one', amountNgn: 200_000 },
          { label: 'Part two', amountNgn: 250_000 },
        ],
      });
      await approveRefund(agent, refund.refundID, 'OK for staged pay');
      const pay1 = await payRefundStage(agent, refund.refundID, {
        paymentLines: [
          { treasuryAccountId: accounts[0].id, amountNgn: 200_000, reference: 'RF-V5-1' },
          { treasuryAccountId: accounts[1].id, amountNgn: 100_000, reference: 'RF-V5-2' },
        ],
      });
      expect(pay1.fullyPaid).toBe(false);
      const pay2 = await payRefundStage(agent, refund.refundID, {
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 150_000, reference: 'RF-V5-3' }],
      });
      expect(pay2.fullyPaid).toBe(true);
      const after = await bootstrap(agent);
      const row = after.refunds.find((r) => r.refundID === refund.refundID);
      expect(row.status).toBe('Paid');
      expect(row.paidAmountNgn).toBe(450_000);
    },
  });

  scenarios.push({
    id: 'SCN-VAL-06',
    name: 'Master data CRUD and refund preview from setup-backed inputs',
    run: async () => {
      const { agent } = await createSession();
      const before = await agent.get('/api/setup');
      expect(before.status).toBe(200);
      const colourCount = before.body.masterData.colours.length;
      const created = await agent.post('/api/setup/colours').send({
        name: 'Scenario Matrix Teal',
        abbreviation: 'SMT',
        sortOrder: 200,
        active: true,
      });
      expect(created.status).toBe(201);
      const colourId = created.body.id;
      const mid = await agent.get('/api/setup');
      expect(mid.body.masterData.colours.length).toBe(colourCount + 1);
      const patch = await agent.patch(`/api/setup/colours/${encodeURIComponent(colourId)}`).send({
        name: 'Scenario Matrix Teal Renamed',
        abbreviation: 'SMX',
        sortOrder: 201,
        active: true,
      });
      expect(patch.status).toBe(200);
      const preview = await postRefundPreview(agent, {
        customerID: 'CUS-001',
        quotationRef: 'QT-2026-001',
        manualAdjustmentNgn: 15_000,
      });
      const manualLine = preview.preview.suggestedLines.find(
        (l) => l.category === 'Adjustment' && String(l.label || '').toLowerCase().includes('manual')
      );
      expect(manualLine?.amountNgn).toBe(15_000);
      expect(preview.preview.suggestedAmountNgn).toBeGreaterThanOrEqual(15_000);
      const del = await agent.delete(`/api/setup/colours/${encodeURIComponent(colourId)}`);
      expect(del.status).toBe(200);
      const after = await agent.get('/api/setup');
      expect(after.body.masterData.colours.length).toBe(colourCount);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-01',
    name: '100 cutting lines totaling 123.45 meters',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const fgProduct = snap.products[0];
      const customerID = await createCustomer(agent, 'HSH01', 'Harsh Dense Cutting');
      const quote = await createQuotation(agent, customerID, 'HSH01', {
        products: [{ name: 'Roofing Sheet', qty: '123.45', unitPrice: '4000' }],
        accessories: [],
        services: [],
      });
      const lengths = buildExactLengths(100, 123.45);
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Machine H1',
        operatorName: 'Op',
        lines: lengths,
      });
      expect(cutting.cuttingList.totalMeters).toBeCloseTo(metersQuantizedToDecimeters(123.45), 5);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-02',
    name: 'Five-way split receipt with awkward primes summing to total',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 5, 'HSH02');
      const customerID = await createCustomer(agent, 'HSH02', 'Five Split Customer');
      const quote = await createQuotation(agent, customerID, 'HSH02', {
        products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '1234567' }],
        accessories: [],
        services: [],
      });
      const total = 1_234_567;
      const parts = [100_003, 200_009, 300_017, 400_023, 234_515];
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: total,
        paymentMethod: 'Split',
        dateISO: '2026-03-29',
        paymentLines: parts.map((amountNgn, idx) => ({
          treasuryAccountId: accounts[idx].id,
          amountNgn,
          reference: `H5-${idx + 1}`,
        })),
      });
      const summary = await customerSummary(agent, customerID);
      expect(amountDueFor(summary, quote.quotationId)).toBe(0);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-03',
    name: 'Receipt rejects treasury lines that do not match header amount',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 2, 'HSH03');
      const customerID = await createCustomer(agent, 'HSH03', 'Mismatch Customer');
      const quote = await createQuotation(agent, customerID, 'HSH03', {
        products: [{ name: 'Line item', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      });
      const res = await agent.post('/api/ledger/receipt').send({
        customerID,
        quotationId: quote.quotationId,
        amountNgn: 100_000,
        paymentMethod: 'Split',
        dateISO: '2026-03-29',
        paymentLines: [
          { treasuryAccountId: accounts[0].id, amountNgn: 40_000, reference: 'A' },
          { treasuryAccountId: accounts[1].id, amountNgn: 50_000, reference: 'B' },
        ],
      });
      expect(res.status).toBe(400);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-04',
    name: 'Apply advance rejects one naira over available then succeeds at limit',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 1, 'HSH04');
      const customerID = await createCustomer(agent, 'HSH04', 'Advance Edge');
      await postAdvance(agent, {
        customerID,
        amountNgn: 50_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 50_000, reference: 'D' }],
      });
      const quote = await createQuotation(agent, customerID, 'HSH04', {
        products: [{ name: 'Order', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      });
      const bad = await agent.post('/api/ledger/apply-advance').send({
        customerID,
        quotationRef: quote.quotationId,
        amountNgn: 50_001,
      });
      expect(bad.status).toBe(400);
      await applyAdvance(agent, {
        customerID,
        quotationRef: quote.quotationId,
        amountNgn: 50_000,
      });
      const summary = await customerSummary(agent, customerID);
      expect(summary.advanceNgn).toBe(0);
      expect(amountDueFor(summary, quote.quotationId)).toBe(50_000);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-05',
    name: 'Four staggered partial receipts then final clearance on large quote',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 2, 'HSH05');
      const customerID = await createCustomer(agent, 'HSH05', 'Stagger Payer');
      const quote = await createQuotation(agent, customerID, 'HSH05', {
        products: [{ name: 'Bulk roof', qty: '1', unitPrice: '7777777' }],
        accessories: [],
        services: [],
      });
      const chunks = [1_111_111, 2_222_222, 1_333_333, 2_111_111];
      const total = 7_777_777;
      let paid = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        paid += chunks[i];
        await postReceipt(agent, {
          customerID,
          quotationId: quote.quotationId,
          amountNgn: chunks[i],
          paymentMethod: 'Transfer',
          dateISO: '2026-03-29',
          paymentLines: [{ treasuryAccountId: accounts[i % 2].id, amountNgn: chunks[i], reference: `S${i}` }],
        });
        const s = await customerSummary(agent, customerID);
        expect(amountDueFor(s, quote.quotationId)).toBe(total - paid);
      }
      const last = total - paid;
      await postReceipt(agent, {
        customerID,
        quotationId: quote.quotationId,
        amountNgn: last,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: last, reference: 'S-FINAL' }],
      });
      const summary = await customerSummary(agent, customerID);
      expect(amountDueFor(summary, quote.quotationId)).toBe(0);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-06',
    name: 'Advance apply blocked when quotation belongs to another customer',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 1, 'HSH06');
      const alice = await createCustomer(agent, 'HSH06A', 'Alice Harsh');
      const bob = await createCustomer(agent, 'HSH06B', 'Bob Harsh');
      await postAdvance(agent, {
        customerID: bob,
        amountNgn: 200_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: accounts[0].id, amountNgn: 200_000, reference: 'B' }],
      });
      const quote = await createQuotation(agent, alice, 'HSH06A', {
        products: [{ name: 'Q', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      });
      const hijack = await agent.post('/api/ledger/apply-advance').send({
        customerID: bob,
        quotationRef: quote.quotationId,
        amountNgn: 100_000,
      });
      expect(hijack.status).toBe(400);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-07',
    name: 'Approved expense paid in four unequal treasury legs',
    run: async () => {
      const { agent } = await createSession();
      const accounts = await ensureTreasuryAccounts(agent, 4, 'HSH07');
      const amount = 1_000_003;
      const legs = [250_001, 250_000, 250_001, 250_001];
      const expense = await createExpense(agent, {
        expenseType: 'Harsh multi-leg',
        amountNgn: amount,
        date: '2026-03-29',
        category: 'Maintenance — plant & equipment',
        paymentMethod: 'Mixed',
        reference: 'EXP-H7',
      });
      const reqRow = await createPaymentRequest(agent, {
        expenseID: expense.expenseID,
        amountRequestedNgn: amount,
        requestDate: '2026-03-29',
        description: 'Four-way payout',
      });
      await approvePaymentRequest(agent, reqRow.requestID);
      await payPaymentRequest(agent, reqRow.requestID, {
        note: 'Four legs',
        paymentLines: legs.map((amountNgn, idx) => ({
          treasuryAccountId: accounts[idx].id,
          amountNgn,
          reference: `H7-${idx}`,
        })),
      });
      const after = await bootstrap(agent);
      const paid = after.paymentRequests.find((row) => row.requestID === reqRow.requestID);
      expect(paid.paidAmountNgn).toBe(amount);
    },
  });

  scenarios.push({
    id: 'SCN-HARSH-08',
    name: '27 micro lines totaling 3.33 meters',
    run: async () => {
      const { agent } = await createSession();
      const snap = await bootstrap(agent);
      const fgProduct = snap.products[0];
      const customerID = await createCustomer(agent, 'HSH08', 'Micro cuts');
      const quote = await createQuotation(agent, customerID, 'HSH08', {
        products: [{ name: 'Roofing Sheet', qty: '3.33', unitPrice: '9000' }],
        accessories: [],
        services: [],
      });
      const lengths = buildExactLengths(27, 3.33);
      const cutting = await createCuttingList(agent, {
        quotationRef: quote.quotationId,
        customerID,
        productID: fgProduct.productID,
        productName: fgProduct.name,
        dateISO: '2026-03-29',
        machineName: 'Micro',
        operatorName: 'Op',
        lines: lengths,
      });
      expect(cutting.cuttingList.totalMeters).toBeCloseTo(metersQuantizedToDecimeters(3.33), 5);
    },
  });

  expect(scenarios).toHaveLength(114);
  return scenarios;
}

describe('Scenario matrix', () => {
  it(
    'executes 114 live-like transactional scenarios',
    { timeout: 720_000 },
    async () => {
      const scenarios = buildScenarioMatrix();
      const failures = [];

      for (const scenario of scenarios) {
        const dbCountBefore = openDbs.length;
        try {
          await scenario.run();
        } catch (error) {
          const msg = String(error?.message || error);
          const top = String(error?.stack || '').split('\n').slice(0, 2).join('\n');
          failures.push(`${scenario.id} ${scenario.name}: ${msg}${top ? `\n${top}` : ''}`);
        } finally {
          while (openDbs.length > dbCountBefore) {
            try {
              openDbs.pop()?.close();
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(`Scenario matrix failures (${failures.length}/${scenarios.length})\n${failures.join('\n')}`);
      }
    }
  );
});
