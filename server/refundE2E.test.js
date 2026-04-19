import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

/**
 * HTTP-level refund journeys: eligibility after production cancel, void quotes,
 * rejection → retry, approval caps, payout guards, permission boundaries, light load.
 */
describe('Refund E2E (HTTP)', () => {
  let app;
  let agent;
  let db;

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    db?.close();
  });

  it('full lifecycle after production cancel: eligible list → create → approve → pay', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: `Refund cancel-path ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Cancel path sheet', qty: '1', unitPrice: '250000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationRef =
      q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;
    expect(String(quotationRef || '')).toBeTruthy();

    const rcpt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-001',
      quotationId: quotationRef,
      amountNgn: 250_000,
      paymentMethod: 'Transfer',
      dateISO: '2026-03-29',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 250_000, reference: 'RCP-CANCEL-PATH' }],
    });
    expect(rcpt.status).toBe(201);

    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(job.status).toBe(201);
    const cancel = await agent
      .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/cancel`)
      .send({ reason: 'Customer cancelled before run — E2E refund test' });
    expect(cancel.status).toBe(200);

    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const elig = await salesStaff.get('/api/refunds/eligible-quotations');
    expect(elig.status).toBe(200);
    expect(elig.body.quotations.some((row) => row.id === quotationRef)).toBe(true);

    const createRefund = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef,
      reasonCategory: 'Overpayment',
      reason: 'Cancel-path refund',
      amountNgn: 15_000,
      calculationLines: [{ label: 'Goodwill', amountNgn: 15_000 }],
    });
    expect(createRefund.status).toBe(201);
    const refundID = createRefund.body.refundID;

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    const approve = await managerAgent.post(`/api/refunds/${encodeURIComponent(refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      managerComments: 'OK after cancel',
    });
    expect(approve.status).toBe(200);

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const pay = await financeAgent.post(`/api/refunds/${encodeURIComponent(refundID)}/pay`).send({
      treasuryAccountId,
      reference: 'RF-CANCEL-PATH',
    });
    expect(pay.status).toBe(201);

    const boot = await financeAgent.get('/api/bootstrap');
    const row = boot.body.refunds.find((r) => r.refundID === refundID);
    expect(row?.status).toBe('Paid');
    expect(row?.paidAmountNgn).toBe(15_000);
  });

  it('paid Void quotation: eligible → refund → approve → pay', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Void paid refund ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Void item', qty: '1', unitPrice: '180000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationRef =
      q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;

    await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId: quotationRef,
      amountNgn: 180_000,
      paymentMethod: 'Cash',
      dateISO: '2026-03-29',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 180_000, reference: 'RCP-VOID-PATH' }],
    });

    const voided = await agent.patch(`/api/quotations/${encodeURIComponent(quotationRef)}`).send({
      status: 'Void',
    });
    expect(voided.status).toBe(200);

    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const elig = await salesStaff.get('/api/refunds/eligible-quotations');
    expect(elig.body.quotations.some((row) => row.id === quotationRef)).toBe(true);

    const created = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-002',
      customer: 'Test Customer',
      quotationRef,
      reasonCategory: 'Adjustment',
      reason: 'Void order settlement',
      amountNgn: 20_000,
      calculationLines: [{ label: 'Adjustment', amountNgn: 20_000 }],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      managerComments: 'Void OK',
    });

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const pay = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`)
      .send({ treasuryAccountId, reference: 'RF-VOID' });
    expect(pay.status).toBe(201);
    expect(pay.body.fullyPaid).toBe(true);
  });

  it('after rejection, same category can be requested again', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');

    const first = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Try 1',
      amountNgn: 5_000,
      calculationLines: [{ label: 'A', amountNgn: 5_000 }],
    });
    expect(first.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    const reject = await managerAgent
      .post(`/api/refunds/${encodeURIComponent(first.body.refundID)}/decision`)
      .send({
        status: 'Rejected',
        approvalDate: '2026-03-29',
        managerComments: 'Not valid',
      });
    expect(reject.status).toBe(200);

    const second = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Try 2 after reject',
      amountNgn: 5_000,
      calculationLines: [{ label: 'B', amountNgn: 5_000 }],
    });
    expect(second.status).toBe(201);
    expect(second.body.refundID).not.toBe(first.body.refundID);
  });

  it('rejected refund cannot be paid; duplicate pending still blocked', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const created = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Adjustment',
      reason: 'Will reject',
      amountNgn: 3_000,
      calculationLines: [{ label: 'X', amountNgn: 3_000 }],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Rejected',
      approvalDate: '2026-03-29',
      managerComments: 'No',
    });

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const payBlocked = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'NO' });
    expect(payBlocked.status).toBe(400);

    const dup = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Adjustment',
      reason: 'Retry adjustment',
      amountNgn: 3_000,
      calculationLines: [{ label: 'Y', amountNgn: 3_000 }],
    });
    expect(dup.status).toBe(201);

    const dup2 = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Adjustment',
      reason: 'Duplicate while pending',
      amountNgn: 1_000,
      calculationLines: [{ label: 'Z', amountNgn: 1_000 }],
    });
    expect(dup2.status).toBe(400);
  });

  it('validation and permission boundaries', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');

    const zero = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Zero',
      amountNgn: 0,
      calculationLines: [],
    });
    expect(zero.status).toBe(400);

    const financeNoRequest = request.agent(app);
    await loginAs(financeNoRequest, 'finance.manager', 'Finance@123');
    const forbidden = await financeNoRequest.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Finance should not create',
      amountNgn: 1_000,
      calculationLines: [{ label: 'x', amountNgn: 1_000 }],
    });
    expect(forbidden.status).toBe(403);

    const createRefund = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Material shortage',
      reason: 'Pay guard',
      amountNgn: 8_000,
      calculationLines: [{ label: 'm', amountNgn: 8_000 }],
    });
    expect(createRefund.status).toBe(201);

    const payEarly = await financeNoRequest
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'EARLY' });
    expect(payEarly.status).toBe(400);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      approvedAmountNgn: 8_000,
    });

    const over = await financeNoRequest
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/pay`)
      .send({
        paymentLines: [
          { treasuryAccountId: 1, amountNgn: 5_000, reference: 'a' },
          { treasuryAccountId: 1, amountNgn: 5_000, reference: 'b' },
        ],
      });
    expect(over.status).toBe(400);
  });

  it('manager-approved cap lower than requested: payout stops at approved amount', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const created = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Substitution pricing',
      reason: 'Cap test',
      amountNgn: 90_000,
      calculationLines: [{ label: 'Full ask', amountNgn: 90_000 }],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      approvedAmountNgn: 40_000,
      managerComments: 'Approved partial',
    });

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const pay = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`)
      .send({ treasuryAccountId, reference: 'CAP' });
    expect(pay.status).toBe(201);
    expect(pay.body.fullyPaid).toBe(true);
    expect(pay.body.paidAmountNgn).toBe(40_000);

    const again = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`)
      .send({ treasuryAccountId, reference: 'AGAIN' });
    expect(again.status).toBe(400);
  });

  it('multi-category reason payload is accepted end-to-end', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const created = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-2026-001',
      reasonCategory: ['Transport refund', 'Accessory refund'],
      reason: 'Combined',
      amountNgn: 12_000,
      calculationLines: [
        { label: 'Transport', amountNgn: 7_000 },
        { label: 'Accessory', amountNgn: 5_000 },
      ],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
    });

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const pay = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'MULTI' });
    expect(pay.status).toBe(201);
  });

  it('eligible list excludes paid-only quotes; POST /api/refunds is rejected (eligibility enforced)', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: `No production close ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Paid only', qty: '1', unitPrice: '99000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationRef =
      q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;

    const rcpt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-001',
      quotationId: quotationRef,
      amountNgn: 99_000,
      paymentMethod: 'Transfer',
      dateISO: '2026-03-29',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 99_000, reference: 'RCP-NO-PROD' }],
    });
    expect(rcpt.status).toBe(201);

    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const elig = await salesStaff.get('/api/refunds/eligible-quotations');
    expect(elig.body.quotations.some((row) => row.id === quotationRef)).toBe(false);

    const create = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef,
      reasonCategory: 'Overpayment',
      reason: 'Blocked without closed production',
      amountNgn: 5_000,
      calculationLines: [{ label: 'Gap demo', amountNgn: 5_000 }],
    });
    expect(create.status).toBe(400);
    expect(String(create.body.error || '')).toMatch(/completed or cancelled|void quotation/i);
  });

  it('POST /api/refunds rejects amount above remaining refundable headroom', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const res = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Transport refund',
      reason: 'Over remaining cap',
      amountNgn: 946_000,
      calculationLines: [{ label: 'Too large', amountNgn: 946_000 }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/exceeds remaining refundable balance/i);
  });

  it('rejects approval amount above requested amount', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const created = await salesStaff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Cap approval test',
      amountNgn: 5_000,
      calculationLines: [{ label: 'Line', amountNgn: 5_000 }],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    const bad = await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      approvedAmountNgn: 50_000,
      managerComments: 'Too high',
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error || '')).toMatch(/cannot exceed the requested amount/i);
  });

  it('preview includes remainingRefundableNgn for eligible quotations', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const prev = await salesStaff.post('/api/refunds/preview').send({ quotationRef: 'QT-2026-001' });
    expect(prev.status).toBe(200);
    expect(prev.body.preview.remainingRefundableNgn).toBeDefined();
    expect(Number(prev.body.preview.remainingRefundableNgn)).toBeGreaterThan(0);
  });

  it('preview endpoint tolerates many sequential calls (no crash / consistent 200)', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    for (let i = 0; i < 40; i += 1) {
      const prev = await salesStaff.post('/api/refunds/preview').send({
        quotationRef: 'QT-2026-001',
        manualAdjustmentNgn: 1000 + i,
      });
      expect(prev.status).toBe(200);
      expect(prev.body.ok).toBe(true);
    }
  });
});
