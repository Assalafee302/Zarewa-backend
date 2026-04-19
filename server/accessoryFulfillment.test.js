/**
 * Accessories at production completion: usage rows, optional stock deduction, refund shortfall preview.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const openDbs = [];

function makeApp() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  return createApp(db);
}

async function loginAs(agent, username = 'admin', password = 'Admin@123') {
  const res = await agent.post('/api/session/login').send({ username, password });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
}

async function freshPaidQuotationWithAccessory(agent) {
  const q = await agent.post('/api/quotations').send({
    customerID: 'CUS-001',
    projectName: `Accessory test ${Date.now()}`,
    dateISO: '2026-03-29',
    lines: {
      products: [{ name: 'Roof line', qty: '10', unitPrice: '50000' }],
      accessories: [{ id: 'SQI-005', name: 'Tapping Screw', qty: '17', unitPrice: '1000' }],
      services: [],
    },
  });
  expect(q.status).toBe(201);
  const qid = q.body.quotationId;
  const total = q.body.quotation.totalNgn;
  const boot = await agent.get('/api/bootstrap');
  const treasuryAccountId = boot.body.treasuryAccounts[0].id;
  const payNgn = Math.max(Math.ceil(total * 0.71), 1);
  const rcpt = await agent.post('/api/ledger/receipt').send({
    customerID: 'CUS-001',
    quotationId: qid,
    amountNgn: payNgn,
    paymentMethod: 'Cash',
    dateISO: '2026-03-29',
    paymentLines: [{ treasuryAccountId, amountNgn: payNgn, reference: `ACC-${Date.now()}` }],
  });
  expect(rcpt.status).toBe(201);
  return qid;
}

async function seedOneCoil(agent, coilNo, kg) {
  const sup = await agent.post('/api/suppliers').send({ name: 'Acc Supplier', city: 'Kano' });
  expect(sup.status).toBe(201);
  const po = await agent.post('/api/purchase-orders').send({
    supplierID: sup.body.supplierID,
    supplierName: 'Acc Supplier',
    orderDateISO: '2026-04-01',
    status: 'Approved',
    lines: [
      {
        lineKey: 'L-A',
        productID: 'COIL-ALU',
        productName: 'Aluminium coil',
        color: 'IV',
        gauge: '0.24',
        metersOffered: 1000,
        conversionKgPerM: kg / 1000,
        qtyOrdered: kg * 2,
        unitPricePerKgNgn: 100,
        unitPriceNgn: 100,
        qtyReceived: 0,
      },
    ],
  });
  expect(po.status).toBe(201);
  const grn = await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
    entries: [
      {
        lineKey: 'L-A',
        productID: 'COIL-ALU',
        qtyReceived: kg,
        weightKg: kg,
        coilNo,
        location: 'Bay',
        gaugeLabel: '0.24mm',
        materialTypeName: 'Aluminium',
        supplierExpectedMeters: 1000,
        supplierConversionKgPerM: kg / 1000,
      },
    ],
    supplierID: sup.body.supplierID,
    supplierName: 'Acc Supplier',
  });
  expect(grn.status).toBe(200);
}

describe('Accessory fulfillment', () => {
  afterAll(() => {
    for (const db of openDbs) db.close();
    openDbs.length = 0;
  });

  it('production complete posts usage, deducts mapped stock, refund preview shows shortfall', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);

    const mapSqi = await agent.patch('/api/setup/quote-items/SQI-005').send({
      itemType: 'accessory',
      name: 'Tapping Screw',
      unit: 'box',
      defaultUnitPriceNgn: 0,
      active: true,
      sortOrder: 10,
      inventoryProductId: 'FG-101',
    });
    expect(mapSqi.status).toBe(200);

    const adj = await agent.post('/api/inventory/adjust').send({
      productID: 'FG-101',
      type: 'Increase',
      qty: 500,
      reasonCode: 'TEST',
      note: 'accessory test seed',
      dateISO: '2026-04-01',
    });
    expect(adj.status).toBe(200);

    const boot0 = await agent.get('/api/bootstrap');
    const fg0 = boot0.body.products.find((p) => p.productID === 'FG-101').stockLevel;

    await seedOneCoil(agent, 'CL-ACC-1', 2000);
    const qref = await freshPaidQuotationWithAccessory(agent);

    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: qref,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-04-01',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 10 }],
    });
    expect(cutting.status).toBe(201);

    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 50,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;

    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-ACC-1', openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-04-01' });

    const complete = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-04-01',
      allocations: [
        {
          allocationId: alloc.body.allocations?.[0]?.id,
          coilNo: 'CL-ACC-1',
          closingWeightKg: 400,
          metersProduced: 100,
          note: '',
        },
      ],
      accessoriesSupplied: [{ quoteLineId: 'SQI-005', name: 'Tapping Screw', suppliedQty: 15 }],
    });
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);

    const boot1 = await agent.get('/api/bootstrap');
    const fg1 = boot1.body.products.find((p) => p.productID === 'FG-101').stockLevel;
    expect(fg1).toBeCloseTo(fg0 + 100 - 15, 2);

    const usage = boot1.body.productionJobAccessoryUsage.filter((u) => u.jobID === jobId);
    expect(usage.length).toBe(1);
    expect(usage[0].suppliedQty).toBe(15);
    expect(usage[0].quoteLineId).toBe('SQI-005');

    const mov = boot1.body.movements.filter(
      (m) => m.type === 'ACCESSORY_ISSUE' && String(m.ref) === jobId
    );
    expect(mov.length).toBeGreaterThanOrEqual(1);

    const prev = await agent.post('/api/refunds/preview').send({ quotationRef: qref, reasonCategory: [] });
    expect(prev.status).toBe(200);
    const accLines = (prev.body.preview.suggestedLines || []).filter(
      (l) => l.category === 'Accessory shortfall'
    );
    expect(accLines.some((l) => l.amountNgn === 2000)).toBe(true);

    const intel = await agent.get(`/api/refunds/intelligence?quotationRef=${encodeURIComponent(qref)}`);
    expect(intel.status).toBe(200);
    const lines = intel.body.summary?.accessoriesSummary?.lines || [];
    const screw = lines.find((l) => String(l.name).includes('Tapping'));
    expect(screw).toBeDefined();
    expect(screw.ordered).toBe(17);
    expect(screw.supplied).toBe(15);
    expect(screw.shortfall).toBe(2);
  });

  it('rejects accessory supplied above remaining for the quotation line', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);

    await agent.patch('/api/setup/quote-items/SQI-005').send({
      itemType: 'accessory',
      name: 'Tapping Screw',
      unit: 'box',
      defaultUnitPriceNgn: 0,
      active: true,
      sortOrder: 10,
    });

    await seedOneCoil(agent, 'CL-ACC-2', 2000);
    const qref = await freshPaidQuotationWithAccessory(agent);

    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: qref,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-04-01',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 20,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-ACC-2', openingWeightKg: 600 }],
    });
    expect(alloc.status).toBe(200);
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-04-01' });

    const bad = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-04-01',
      allocations: [
        {
          allocationId: alloc.body.allocations?.[0]?.id,
          coilNo: 'CL-ACC-2',
          closingWeightKg: 200,
          metersProduced: 50,
          note: '',
        },
      ],
      accessoriesSupplied: [{ quoteLineId: 'SQI-005', suppliedQty: 20 }],
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error || '')).toMatch(/exceeds remaining/i);
  });
});
