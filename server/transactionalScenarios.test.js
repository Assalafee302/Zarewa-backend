/**
 * Maps the 20 end-to-end transactional scenarios (customer → quote → payment → stock → finance)
 * to automated API checks. Each scenario is one test for clear failure attribution.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const openDbs = [];

async function loginAs(agent, username = 'admin', password = 'Admin@123') {
  const res = await agent.post('/api/session/login').send({ username, password });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function adminSession() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  const app = createApp(db);
  const agent = request.agent(app);
  await loginAs(agent);
  return { app, agent };
}

function amountDueFor(summary, quotationId) {
  return Number(
    summary.outstandingByQuotation.find((row) => row.quotationId === quotationId)?.amountDueNgn || 0
  );
}

describe('Transactional scenarios (business checklist)', () => {
  beforeEach(() => {
    // These scenarios use fixed 2026 dates; freeze time so status derivations (e.g. Expired vs Pending)
    // remain stable regardless of the real current date when tests run.
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
    '1. Customer creation — persisted profile usable for quotations',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const create = await agent.post('/api/customers').send({
        customerID: 'CUS-TX-01',
        name: 'Walk-in Roofing Client',
        phoneNumber: '+234 803 111 2222',
        email: 'walkin@example.com',
        addressShipping: '12 Industrial Rd, Kano',
        addressBilling: '12 Industrial Rd, Kano',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      expect(create.status).toBe(201);
      const get = await agent.get('/api/customers/CUS-TX-01');
      expect(get.status).toBe(200);
      expect(get.body.customer.email).toBe('walkin@example.com');
      const quote = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-01',
        projectName: 'Roof package',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '5000' }],
          accessories: [],
          services: [],
        },
      });
      expect(quote.status).toBe(201);
      expect(quote.body.quotation.customerID).toBe('CUS-TX-01');
    }
  );

  it(
    '2. Quotation for new customer — totals, Pending, generated id',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      await agent.post('/api/customers').send({
        customerID: 'CUS-TX-02',
        name: 'New Roof Buyer',
        phoneNumber: '08031234567',
        email: 'newroof@example.com',
        addressShipping: 'Site A',
        addressBilling: 'Site A',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const res = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-02',
        projectName: 'Sheet + ridge',
        dateISO: '2026-03-29',
        lines: {
          products: [
            { name: 'Roofing Sheet', qty: '100', unitPrice: '4000' },
            { name: 'Ridge', qty: '20', unitPrice: '2500' },
          ],
          accessories: [],
          services: [],
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.quotationId).toMatch(/^QT-/);
      expect(res.body.quotation.totalNgn).toBe(100 * 4000 + 20 * 2500);
      const boot = await agent.get('/api/bootstrap');
      const row = boot.body.quotations.find((q) => q.id === res.body.quotationId);
      expect(row?.status).toBe('Pending');
    }
  );

  it(
    '3. Full payment against quotation — ledger balance and receipt',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      await agent.post('/api/customers').send({
        customerID: 'CUS-TX-03',
        name: 'Full Payer',
        phoneNumber: '08030000003',
        email: 'full@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const quote = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-03',
        projectName: 'Paid in full',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '20', unitPrice: '5000' }],
          accessories: [],
          services: [],
        },
      });
      expect(quote.status).toBe(201);
      const qid = quote.body.quotationId;
      const total = quote.body.quotation.totalNgn;
      await agent.post('/api/ledger/receipt').send({
        customerID: 'CUS-TX-03',
        quotationId: qid,
        amountNgn: total,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        bankReference: 'TX03-FULL',
        paymentLines: [{ treasuryAccountId, amountNgn: total, reference: 'TX03-FULL' }],
      });
      const summary = await agent.get('/api/customers/CUS-TX-03/summary');
      expect(summary.status).toBe(200);
      expect(amountDueFor(summary.body, qid)).toBe(0);
      const after = await agent.get('/api/bootstrap');
      const receipt = after.body.receipts.find((r) => r.quotationRef === qid);
      expect(receipt).toBeTruthy();
      expect(Number(receipt.amountNgn)).toBe(total);
    }
  );

  it(
    '4. Partial payment — outstanding balance and receipt method',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      await agent.post('/api/customers').send({
        customerID: 'CUS-TX-04',
        name: 'Partial Payer',
        phoneNumber: '08030000004',
        email: 'partial@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const quote = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-04',
        projectName: 'Partial',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '50', unitPrice: '6000' }],
          accessories: [],
          services: [],
        },
      });
      const qid = quote.body.quotationId;
      const total = quote.body.quotation.totalNgn;
      await agent.post('/api/ledger/receipt').send({
        customerID: 'CUS-TX-04',
        quotationId: qid,
        amountNgn: total - 75000,
        paymentMethod: 'POS',
        dateISO: '2026-03-29',
        bankReference: 'TX04-POS',
        paymentLines: [{ treasuryAccountId, amountNgn: total - 75000, reference: 'TX04-POS' }],
      });
      const summary = await agent.get('/api/customers/CUS-TX-04/summary');
      expect(amountDueFor(summary.body, qid)).toBe(75000);
      const snap = await agent.get('/api/bootstrap');
      const qRow = snap.body.quotations.find((q) => q.id === qid);
      expect(qRow?.totalNgn).toBe(total);
    }
  );

  it(
    '5. Quotation approval — status Approved and coil stock reserved for production',
    { timeout: 45_000 },
    async () => {
      const { agent } = await adminSession();
      const snap = await agent.get('/api/bootstrap');
      const fg = snap.body.products.find((p) => p.productID === 'FG-101') || snap.body.products[0];
      const raw = snap.body.products.find((p) => p.productID === 'COIL-ALU') || snap.body.products[0];

      const sup = await agent.post('/api/suppliers').send({
        name: 'Scenario 5 Supplier',
        city: 'Kano',
        paymentTerms: 'Cash',
        qualityScore: 80,
        notes: 'TX5',
      });
      expect(sup.status).toBe(201);
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'Scenario 5 Supplier',
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-TX5',
            productID: raw.productID,
            productName: raw.name,
            qtyOrdered: 5000,
            unitPricePerKgNgn: 100,
            unitPriceNgn: 100,
            qtyReceived: 0,
          },
        ],
      });
      expect(po.status).toBe(201);
      const coilNo = 'CL-TX-SCN-05';
      await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
        entries: [
          {
            lineKey: 'L-TX5',
            productID: raw.productID,
            qtyReceived: 2000,
            weightKg: 2000,
            coilNo,
            location: 'Store',
            gaugeLabel: '0.24mm',
            materialTypeName: raw.name,
            supplierExpectedMeters: 800,
          },
        ],
        supplierID: sup.body.supplierID,
        supplierName: 'Scenario 5 Supplier',
      });

      await agent.post('/api/customers').send({
        customerID: 'CUS-TX-05',
        name: 'Approved Quote Customer',
        phoneNumber: '08030000005',
        email: 'appr@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const quote = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-05',
        projectName: 'Approved roof',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '30', unitPrice: '4000' }],
          accessories: [],
          services: [],
        },
      });
      const qid = quote.body.quotationId;
      const patch = await agent.patch(`/api/quotations/${encodeURIComponent(qid)}`).send({
        status: 'Approved',
        customerFeedback: 'Manager approved',
      });
      expect(patch.status).toBe(200);
      expect(patch.body.quotation.status).toBe('Approved');
      const payHalf = await agent.patch(`/api/quotations/${encodeURIComponent(qid)}`).send({
        paidNgn: 120_000,
      });
      expect(payHalf.status).toBe(200);

      const cutting = await agent.post('/api/cutting-lists').send({
        quotationRef: qid,
        customerID: 'CUS-TX-05',
        productID: fg.productID,
        productName: fg.name,
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'Op',
        lines: [{ sheets: 2, lengthM: 15 }],
      });
      expect(cutting.status).toBe(201);
      const job = await agent.post('/api/production-jobs').send({
        cuttingListId: cutting.body.id,
        productID: fg.productID,
        productName: fg.name,
        plannedMeters: 30,
        plannedSheets: 2,
        status: 'Planned',
      });
      expect(job.status).toBe(201);
      const alloc = await agent
        .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/allocations`)
        .send({ allocations: [{ coilNo, openingWeightKg: 400 }] });
      expect(alloc.status).toBe(200);
      const after = await agent.get('/api/bootstrap');
      const coil = after.body.coilLots.find((c) => c.coilNo === coilNo);
      expect(coil?.qtyReserved).toBeGreaterThan(0);
    }
  );

  it(
    '6. GRN — coil number, weight/qty, stock up, linked PO',
    { timeout: 30_000 },
    async () => {
      const { agent } = await adminSession();
      const snap = await agent.get('/api/bootstrap');
      const product = snap.body.products.find((p) => p.productID === 'COIL-ALU');
      const before = product.stockLevel;
      const sup = await agent.post('/api/suppliers').send({ name: 'GRN Supplier', city: 'Jos' });
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'GRN Supplier',
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-GRN6',
            productID: product.productID,
            productName: product.name,
            qtyOrdered: 8000,
            unitPricePerKgNgn: 90,
            unitPriceNgn: 90,
            qtyReceived: 0,
          },
        ],
      });
      const coilNo = 'CL-TX-SCN-06';
      await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
        entries: [
          {
            lineKey: 'L-GRN6',
            productID: product.productID,
            qtyReceived: 3500,
            weightKg: 3480,
            coilNo,
            location: 'Bay 2',
          },
        ],
        supplierID: sup.body.supplierID,
        supplierName: 'GRN Supplier',
      });
      const after = await agent.get('/api/bootstrap');
      const poRow = after.body.purchaseOrders.find((p) => p.poID === po.body.poID);
      expect(poRow?.lines?.[0]?.qtyReceived).toBeGreaterThanOrEqual(3500);
      const p2 = after.body.products.find((x) => x.productID === product.productID);
      expect(p2.stockLevel).toBe(before + 3500);
      expect(after.body.coilLots.some((c) => c.coilNo === coilNo && c.poID === po.body.poID)).toBe(true);
    }
  );

  it(
    '7. Store → production transfer — store down, WIP up',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const snap = await agent.get('/api/bootstrap');
      const raw = snap.body.products.find((p) => p.productID === 'COIL-ALU');
      const beforeStock = raw.stockLevel;
      const res = await agent.post('/api/inventory/transfer-to-production').send({
        productID: 'COIL-ALU',
        qty: 250,
        productionOrderId: 'TX-SCN-07',
        dateISO: '2026-03-29',
      });
      expect(res.status).toBe(200);
      const after = await agent.get('/api/bootstrap');
      expect(after.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel).toBe(beforeStock - 250);
      expect(after.body.wipByProduct['COIL-ALU']).toBe(
        (snap.body.wipByProduct['COIL-ALU'] || 0) + 250
      );
    }
  );

  it(
    '8. Finished goods to store — FG stock increases, WIP consumed',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      await agent.post('/api/inventory/transfer-to-production').send({
        productID: 'COIL-ALU',
        qty: 300,
        productionOrderId: 'TX-SCN-08-WIP',
        dateISO: '2026-03-29',
      });
      const snap = await agent.get('/api/bootstrap');
      const fgBefore = snap.body.products.find((p) => p.productID === 'FG-101').stockLevel;
      const res = await agent.post('/api/inventory/finished-goods').send({
        productID: 'FG-101',
        qty: 120,
        unitPriceNgn: 4500,
        productionOrderId: 'TX-SCN-08-FG',
        dateISO: '2026-03-29',
        wipRelease: { wipSourceProductID: 'COIL-ALU', wipQtyReleased: 280 },
      });
      expect(res.status).toBe(200);
      const after = await agent.get('/api/bootstrap');
      expect(after.body.products.find((p) => p.productID === 'FG-101').stockLevel).toBe(fgBefore + 120);
      expect(after.body.movements.some((m) => m.type === 'FINISHED_GOODS' && m.productID === 'FG-101')).toBe(
        true
      );
    }
  );

  it(
    '9. Stock adjustment (damage) — quantity down, movement logged',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const snap = await agent.get('/api/bootstrap');
      const screws = snap.body.products.find((p) => p.productID === 'PRD-201');
      const before = screws.stockLevel;
      const res = await agent.post('/api/inventory/adjust').send({
        productID: 'PRD-201',
        type: 'Decrease',
        qty: 12,
        reasonCode: 'Damage',
        note: 'Crushed cartons on forklift',
        dateISO: '2026-03-29',
      });
      expect(res.status).toBe(200);
      const after = await agent.get('/api/bootstrap');
      expect(after.body.products.find((p) => p.productID === 'PRD-201').stockLevel).toBe(before - 12);
      const mv = after.body.movements.find(
        (m) => m.type === 'ADJUSTMENT' && m.productID === 'PRD-201' && String(m.detail).includes('Damage')
      );
      expect(mv).toBeTruthy();
    }
  );

  it(
    '10. Customer refund — overpayment / advance reduced after treasury payout',
    { timeout: 25_000 },
    async () => {
      const { app } = await adminSession();
      const admin = request.agent(app);
      await loginAs(admin);
      await admin.post('/api/customers').send({
        customerID: 'CUS-TX-10',
        name: 'Advance Refund Client',
        phoneNumber: '08030000010',
        email: 'advrf@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const bootAdmin = await admin.get('/api/bootstrap');
      const treasuryAccountId = bootAdmin.body.treasuryAccounts[0].id;
      await admin.post('/api/ledger/advance').send({
        customerID: 'CUS-TX-10',
        amountNgn: 40_000,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId, amountNgn: 40_000, reference: 'TX10-ADV' }],
      });
      const finance = request.agent(app);
      await loginAs(finance, 'finance.manager', 'Finance@123');
      const before = await finance.get('/api/customers/CUS-TX-10/summary');
      expect(before.body.advanceNgn).toBeGreaterThanOrEqual(40_000);
      const refund = await finance.post('/api/ledger/refund-advance').send({
        customerID: 'CUS-TX-10',
        amountNgn: 25_000,
        note: 'Overpayment correction TX10',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId, amountNgn: 25_000, reference: 'TX10-RF' }],
      });
      expect(refund.status).toBe(201);
      const after = await finance.get('/api/customers/CUS-TX-10/summary');
      expect(after.body.advanceNgn).toBe(before.body.advanceNgn - 25_000);
    }
  );

  it(
    '11. Cancelled order — refund matches paid quotation total',
    { timeout: 35_000 },
    async () => {
      const { app } = await adminSession();
      const admin = request.agent(app);
      await loginAs(admin);
      const boot = await admin.get('/api/bootstrap');
      const cashId = boot.body.treasuryAccounts[0].id;

      await admin.post('/api/customers').send({
        customerID: 'CUS-TX-11',
        name: 'Cancel Customer',
        phoneNumber: '08030000011',
        email: 'cancel@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const quote = await admin.post('/api/quotations').send({
        customerID: 'CUS-TX-11',
        projectName: 'Cancelled build',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '5', unitPrice: '8000' }],
          accessories: [],
          services: [],
        },
      });
      const qid = quote.body.quotationId;
      const total = quote.body.quotation.totalNgn;
      await admin.post('/api/ledger/receipt').send({
        customerID: 'CUS-TX-11',
        quotationId: qid,
        amountNgn: total,
        paymentMethod: 'Cash',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId: cashId, amountNgn: total, reference: 'TX11-PAY' }],
      });

      const cutting = await admin.post('/api/cutting-lists').send({
        quotationRef: qid,
        customerID: 'CUS-TX-11',
        productID: 'FG-101',
        productName: 'Longspan thin',
        dateISO: '2026-03-29',
        machineName: 'TX11',
        operatorName: 'QA',
        lines: [{ sheets: 1, lengthM: 5 }],
      });
      expect(cutting.status).toBe(201);
      const job = await admin.post('/api/production-jobs').send({
        cuttingListId: cutting.body.id,
        productID: 'FG-101',
        productName: 'Longspan thin',
        plannedMeters: 10,
        plannedSheets: 1,
      });
      expect(job.status).toBe(201);
      const cancel = await admin
        .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/cancel`)
        .send({ reason: 'Customer cancelled before run — TX11' });
      expect(cancel.status).toBe(200);

      const sales = request.agent(app);
      await loginAs(sales, 'sales.staff', 'Sales@123');
      const created = await sales.post('/api/refunds').send({
        customerID: 'CUS-TX-11',
        customer: 'Cancel Customer',
        quotationRef: qid,
        reasonCategory: 'Order cancellation',
        reason: 'Customer cancelled before production',
        amountNgn: total,
        calculationLines: [{ label: 'Order reversal', amountNgn: total }],
      });
      expect(created.status).toBe(201);

      const manager = request.agent(app);
      await loginAs(manager, 'sales.manager', 'Sales@123');
      await manager.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
        status: 'Approved',
        approvalDate: '2026-03-29',
        managerComments: 'Cancellation approved',
        approvedAmountNgn: total,
      });

      const finance = request.agent(app);
      await loginAs(finance, 'finance.manager', 'Finance@123');
      const pay = await finance.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`).send({
        treasuryAccountId: cashId,
        reference: 'TX11-RF',
      });
      expect(pay.status).toBe(201);
      const end = await finance.get('/api/bootstrap');
      const row = end.body.refunds.find((r) => r.refundID === created.body.refundID);
      expect(row.status).toBe('Paid');
      expect(row.paidAmountNgn).toBe(total);
    }
  );

  it(
    '12. New purchase order — Pending and supplier link',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const sup = await agent.post('/api/suppliers').send({ name: 'PO Test Vendor', city: 'Lagos' });
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'PO Test Vendor',
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '2026-04-10',
        status: 'Pending',
        lines: [
          {
            lineKey: 'L-TX12',
            productID: 'PRD-102',
            productName: 'Aluzinc coil (kg)',
            qtyOrdered: 500,
            unitPricePerKgNgn: 200,
            unitPriceNgn: 200,
            qtyReceived: 0,
          },
        ],
      });
      expect(po.status).toBe(201);
      const boot = await agent.get('/api/bootstrap');
      const row = boot.body.purchaseOrders.find((p) => p.poID === po.body.poID);
      expect(row.status).toBe('Pending');
      expect(row.supplierID).toBe(sup.body.supplierID);
    }
  );

  it(
    '13. Supplier / AP settlement — partial payment updates payable balance',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const ap = boot.body.accountsPayable.find((a) => a.apID === 'AP-2026-002');
      expect(ap).toBeTruthy();
      const outstandingBefore = ap.amountNgn - ap.paidNgn;
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      const pay = await agent.post('/api/accounts-payable/AP-2026-002/pay').send({
        amountNgn: 500_000,
        paymentMethod: 'Bank transfer',
        treasuryAccountId: treasuryAccountId,
        reference: 'TX13-AP',
        dateISO: '2026-03-29',
      });
      expect(pay.status).toBe(201);
      const after = await agent.get('/api/bootstrap');
      const ap2 = after.body.accountsPayable.find((a) => a.apID === 'AP-2026-002');
      expect(ap2.paidNgn).toBe(ap.paidNgn + pay.body.amountApplied);
      expect(ap2.amountNgn - ap2.paidNgn).toBe(outstandingBefore - pay.body.amountApplied);
    }
  );

  it(
    '14. Product availability — bootstrap lists stock for customer-facing checks',
    { timeout: 15_000 },
    async () => {
      const { agent } = await adminSession();
      const res = await agent.get('/api/bootstrap');
      expect(res.status).toBe(200);
      const fg = res.body.products.find((p) => p.productID === 'FG-101');
      expect(fg).toBeTruthy();
      expect(fg.stockLevel).toBeGreaterThan(0);
      expect(fg).toHaveProperty('lowStockThreshold');
      expect(fg).toHaveProperty('reorderQty');
    }
  );

  it(
    '15. Inventory report data — snapshot includes products and stock movements',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      await agent.post('/api/inventory/adjust').send({
        productID: 'PRD-201',
        type: 'Increase',
        qty: 3,
        reasonCode: 'Recount',
        note: 'TX15',
        dateISO: '2026-03-29',
      });
      const res = await agent.get('/api/inventory/snapshot');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.products)).toBe(true);
      expect(res.body.products.length).toBeGreaterThan(0);
      expect(Array.isArray(res.body.movements)).toBe(true);
      expect(res.body.movements.some((m) => m.type === 'ADJUSTMENT')).toBe(true);
    }
  );

  it(
    '16. Sales report data — receipts and ledger align for the period',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      await agent.post('/api/customers').send({
        customerID: 'CUS-TX-16',
        name: 'Sales Report Customer',
        phoneNumber: '08030000016',
        email: 'sr@example.com',
        addressShipping: 'X',
        addressBilling: 'X',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
      const quote = await agent.post('/api/quotations').send({
        customerID: 'CUS-TX-16',
        projectName: 'SR',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '3', unitPrice: '10000' }],
          accessories: [],
          services: [],
        },
      });
      const qid = quote.body.quotationId;
      const quoteTotal = quote.body.quotation.totalNgn;
      await agent.post('/api/ledger/receipt').send({
        customerID: 'CUS-TX-16',
        quotationId: qid,
        amountNgn: 10_000,
        paymentMethod: 'Cash',
        dateISO: '2026-03-29',
        paymentLines: [{ treasuryAccountId, amountNgn: 10_000, reference: 'TX16-A' }],
      });
      const after = await agent.get('/api/bootstrap');
      const receipts = after.body.receipts.filter((r) => r.customerID === 'CUS-TX-16');
      const sumReceipts = receipts.reduce((s, r) => s + Number(r.amountNgn), 0);
      const ledgerReceipts = after.body.ledgerEntries.filter(
        (e) => e.customerID === 'CUS-TX-16' && e.type === 'RECEIPT'
      );
      const sumLedger = ledgerReceipts.reduce((s, e) => s + Number(e.amountNgn), 0);
      expect(sumReceipts).toBe(10_000);
      expect(sumLedger).toBe(10_000);
      const summary = await agent.get('/api/customers/CUS-TX-16/summary');
      expect(amountDueFor(summary.body, qid)).toBe(quoteTotal - 10_000);
    }
  );

  it(
    '17. Operational expense — recorded with treasury movement',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      const balBefore = boot.body.treasuryAccounts.find((a) => a.id === treasuryAccountId).balance;
      const exp = await agent.post('/api/expenses').send({
        expenseType: 'Rent — March',
        amountNgn: 12_500,
        date: '2026-03-29',
        category: 'Operational — rent & utilities',
        paymentMethod: 'Transfer',
        treasuryAccountId,
        reference: 'TX17-RENT',
      });
      expect(exp.status).toBe(201);
      const after = await agent.get('/api/bootstrap');
      expect(after.body.expenses.some((e) => e.reference === 'TX17-RENT')).toBe(true);
      const acc = after.body.treasuryAccounts.find((a) => a.id === treasuryAccountId);
      expect(acc.balance).toBe(balBefore - 12_500);
    }
  );

  it(
    '18. Payment to supplier — PO supplier_paid increases',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const sup = await agent.post('/api/suppliers').send({ name: 'Pay Vendor TX18', city: 'Kano' });
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'Pay Vendor TX18',
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-TX18',
            productID: 'PRD-102',
            productName: 'Aluzinc',
            qtyOrdered: 1000,
            unitPricePerKgNgn: 150,
            unitPriceNgn: 150,
            qtyReceived: 0,
          },
        ],
      });
      const boot = await agent.get('/api/bootstrap');
      const treasuryAccountId = boot.body.treasuryAccounts[0].id;
      const pay = await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/supplier-payment`).send({
        amountNgn: 350_000,
        note: 'Deposit to supplier',
        treasuryAccountId,
        reference: 'TX18-PO',
        dateISO: '2026-03-29',
      });
      expect(pay.status).toBe(200);
      const after = await agent.get('/api/bootstrap');
      const row = after.body.purchaseOrders.find((p) => p.poID === po.body.poID);
      expect(row.supplierPaidNgn).toBe(350_000);
    }
  );

  it(
    '19. Reorder signal — product at or below threshold after adjustment',
    { timeout: 25_000 },
    async () => {
      const { agent } = await adminSession();
      const boot = await agent.get('/api/bootstrap');
      const p = boot.body.products.find((x) => x.productID === 'PRD-201');
      expect(p.stockLevel).toBeLessThanOrEqual(p.lowStockThreshold);
      await agent.post('/api/inventory/adjust').send({
        productID: 'PRD-201',
        type: 'Decrease',
        qty: 20,
        reasonCode: 'Consumption',
        note: 'TX19',
        dateISO: '2026-03-29',
      });
      const after = await agent.get('/api/bootstrap');
      const p2 = after.body.products.find((x) => x.productID === 'PRD-201');
      expect(p2.stockLevel).toBeLessThanOrEqual(p2.lowStockThreshold);
      expect(p2.reorderQty).toBeGreaterThan(0);
    }
  );

  it(
    '20. Role-based access — operations can adjust stock; sales cannot',
    { timeout: 25_000 },
    async () => {
      const { app } = await adminSession();
      const sales = request.agent(app);
      await loginAs(sales, 'sales.staff', 'Sales@123');
      const blocked = await sales.post('/api/inventory/adjust').send({
        productID: 'PRD-201',
        type: 'Decrease',
        qty: 1,
        reasonCode: 'Test',
        note: 'should fail',
        dateISO: '2026-03-29',
      });
      expect(blocked.status).toBe(403);

      const ops = request.agent(app);
      await loginAs(ops, 'operations', 'Ops@123');
      const snap = await ops.get('/api/bootstrap');
      const before = snap.body.products.find((x) => x.productID === 'PRD-201').stockLevel;
      const ok = await ops.post('/api/inventory/adjust').send({
        productID: 'PRD-201',
        type: 'Decrease',
        qty: 1,
        reasonCode: 'Test',
        note: 'RBAC TX20',
        dateISO: '2026-03-29',
      });
      expect(ok.status).toBe(200);
      const after = await ops.get('/api/bootstrap');
      expect(after.body.products.find((x) => x.productID === 'PRD-201').stockLevel).toBe(before - 1);
    }
  );
});
