/**
 * Inventory scenario simulations — chained operations and integrity checks.
 *
 * Documented lapses (remaining risks — not all are bugs):
 * - `products.stock_level` for kg coil SKUs is a roll-up: GRN, scrap/return APIs, production completion (raw),
 *   and `/api/inventory/adjust` all touch it, but adjust does not reconcile individual `coil_lots` rows — operators
 *   can create drift if they post arbitrary SKU adjustments while coils are the operational truth.
 * - `transfer-to-production` / WIP / manual FG is a parallel path to coil traceability; using both for the same
 *   physical mass without discipline can double-count or confuse WIP vs coil remaining.
 * - `adjustProductStockTx` clamps at zero — severe negative deltas wipe to 0 instead of failing loudly.
 * - Multi-branch: coil ops enforce branch; older flows may differ — always confirm workspace branch matches coil.
 * - Cutting lists require ≥70% paid toward the quote: the gate uses `quotations.paid_ngn`, rolled up from
 *   **sales_receipts** (+ ADVANCE_APPLIED on the ledger) when receipts are posted or reversed.
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

function sumCoilKgRemainingForProduct(bootstrap, productID) {
  const coils = (bootstrap.coilLots || []).filter((c) => c.productID === productID);
  return coils.reduce((s, c) => s + (Number(c.qtyRemaining) || Number(c.currentWeightKg) || 0), 0);
}

/** Stone-coated quotation (MAT-005 + design/colour/gauge) with ≥70% paid — for stone production jobs. */
async function freshPaidStoneQuotationForCutting(agent, unitPriceNgn = 400_000) {
  const q = await agent.post('/api/quotations').send({
    customerID: 'CUS-001',
    projectName: `Stone scenario ${Date.now()}`,
    dateISO: '2026-03-29',
    materialTypeId: 'MAT-005',
    materialDesign: 'Milano',
    materialColor: 'Black',
    materialGauge: '0.40mm',
    lines: {
      products: [{ name: 'Scenario stone line', qty: '1', unitPrice: String(unitPriceNgn) }],
      accessories: [],
      services: [],
    },
  });
  expect(q.status).toBe(201);
  const qid = q.body.quotationId;
  const total = q.body.quotation.totalNgn;
  const boot = await agent.get('/api/bootstrap');
  const treasuryAccountId = boot.body.treasuryAccounts[0].id;
  const payNgn = Math.max(Math.ceil(total * 0.7), 1);
  const rcpt = await agent.post('/api/ledger/receipt').send({
    customerID: 'CUS-001',
    quotationId: qid,
    amountNgn: payNgn,
    paymentMethod: 'Cash',
    dateISO: '2026-03-29',
    paymentLines: [{ treasuryAccountId, amountNgn: payNgn, reference: `ST-${Date.now()}` }],
  });
  expect(rcpt.status).toBe(201);
  return qid;
}

/** Quotation with ≥70% paid via posted sales receipt (syncs `paid_ngn`; satisfies cutting-list gate). */
async function freshPaidQuotationForCutting(agent, unitPriceNgn = 400_000) {
  const q = await agent.post('/api/quotations').send({
    customerID: 'CUS-001',
    projectName: `Inventory scenario ${Date.now()}`,
    dateISO: '2026-03-29',
    lines: {
      products: [{ name: 'Scenario line', qty: '1', unitPrice: String(unitPriceNgn) }],
      accessories: [],
      services: [],
    },
  });
  expect(q.status).toBe(201);
  const qid = q.body.quotationId;
  const total = q.body.quotation.totalNgn;
  const boot = await agent.get('/api/bootstrap');
  const treasuryAccountId = boot.body.treasuryAccounts[0].id;
  const payNgn = Math.max(Math.ceil(total * 0.7), 1);
  const rcpt = await agent.post('/api/ledger/receipt').send({
    customerID: 'CUS-001',
    quotationId: qid,
    amountNgn: payNgn,
    paymentMethod: 'Cash',
    dateISO: '2026-03-29',
    paymentLines: [{ treasuryAccountId, amountNgn: payNgn, reference: `INV-${Date.now()}` }],
  });
  expect(rcpt.status).toBe(201);
  return qid;
}

async function seedOneCoil(agent, coilNo, kg, productID = 'COIL-ALU') {
  const sup = await agent.post('/api/suppliers').send({ name: 'Inv Scenario Supplier', city: 'Kano' });
  expect(sup.status).toBe(201);
  const po = await agent.post('/api/purchase-orders').send({
    supplierID: sup.body.supplierID,
    supplierName: 'Inv Scenario Supplier',
    orderDateISO: '2026-04-01',
    expectedDeliveryISO: '',
    status: 'Approved',
    lines: [
      {
        lineKey: 'L-INV',
        productID,
        productName: 'Aluminium coil (kg)',
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
        lineKey: 'L-INV',
        productID,
        qtyReceived: kg,
        weightKg: kg,
        coilNo,
        location: 'Bay INV',
        gaugeLabel: '0.24mm',
        materialTypeName: 'Aluminium',
        supplierExpectedMeters: 1000,
        supplierConversionKgPerM: kg / 1000,
      },
    ],
    supplierID: sup.body.supplierID,
    supplierName: 'Inv Scenario Supplier',
  });
  expect(grn.status).toBe(200);
  return { poID: po.body.poID, coilNo };
}

describe('Inventory scenarios (simulated flows)', () => {
  afterAll(() => {
    for (const db of openDbs) db.close();
    openDbs.length = 0;
  });

  it('S1b — GRN qty may exceed open balance on line (over-delivery)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const sup = await agent.post('/api/suppliers').send({ name: 'Over-deliver Supplier', city: 'Jos' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Over-deliver Supplier',
      orderDateISO: '2026-04-01',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-OVER',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'TB',
          gauge: '0.22',
          metersOffered: null,
          conversionKgPerM: null,
          qtyOrdered: 1000,
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
          lineKey: 'L-OVER',
          productID: 'COIL-ALU',
          qtyReceived: 1500,
          coilNo: 'CL-INV-OVER',
          location: 'Bay',
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Over-deliver Supplier',
    });
    expect(grn.status).toBe(200);
    expect(grn.body.ok).toBe(true);
    const boot = await agent.get('/api/bootstrap');
    const poRow = boot.body.purchaseOrders.find((p) => p.poID === po.body.poID);
    const line = poRow?.lines?.find((l) => l.lineKey === 'L-OVER');
    expect(Number(line?.qtyReceived)).toBe(1500);
  });

  it('S1 — GRN: coil remaining and COIL-ALU stock increase together', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const before = await agent.get('/api/bootstrap');
    const stock0 = before.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    const { poID: coilPoId } = await seedOneCoil(agent, 'CL-INV-S1', 2000);
    const after = await agent.get('/api/bootstrap');
    const coilPo = after.body.purchaseOrders.find((p) => p.poID === coilPoId);
    expect(coilPo?.procurementKind).toBe('coil');
    const stock1 = after.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    expect(stock1).toBeCloseTo(stock0 + 2000, 3);
    const coil = after.body.coilLots.find((c) => c.coilNo === 'CL-INV-S1');
    expect(coil.qtyRemaining).toBeCloseTo(2000, 3);
    /** SKU roll-up can exceed sum(coil remainings) when coils are not the only representation of that SKU. */
    const sumCoils = sumCoilKgRemainingForProduct(after.body, 'COIL-ALU');
    expect(sumCoils).toBeGreaterThanOrEqual(2000 - 0.01);
    expect(stock1 - stock0).toBeCloseTo(2000, 2);
  });

  it('S2 — Production complete: coil draw-down and COIL-ALU stock both drop by consumed kg', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S2', 1800);
    const boot0 = await agent.get('/api/bootstrap');
    const stockAfterGrn = boot0.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;

    const qref = await freshPaidQuotationForCutting(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: qref,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 2, lengthM: 10 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 50,
      plannedSheets: 2,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-INV-S2', openingWeightKg: 1200 }],
    });
    expect(alloc.status).toBe(200);
    const start = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({
      startedAtISO: '2026-04-01',
    });
    expect(start.status).toBe(200);

    const complete = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-04-01',
      allocations: [
        {
          allocationId: alloc.body.allocations?.[0]?.id,
          coilNo: 'CL-INV-S2',
          closingWeightKg: 700,
          metersProduced: 200,
          note: '',
        },
      ],
    });
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);

    const consumed = 1200 - 700;
    const boot1 = await agent.get('/api/bootstrap');
    const stockAfter = boot1.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    expect(stockAfter).toBeCloseTo(stockAfterGrn - consumed, 2);
    const coil = boot1.body.coilLots.find((c) => c.coilNo === 'CL-INV-S2');
    expect(coil.qtyRemaining).toBeCloseTo(1800 - consumed, 2);
    const fg = boot1.body.products.find((p) => p.productID === 'FG-101');
    expect(fg.stockLevel).toBeGreaterThanOrEqual(200 - 0.01);
  });

  it('S3 — Split: total kg on coils unchanged; COIL-ALU product stock unchanged', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S3', 1500);
    const b0 = await agent.get('/api/bootstrap');
    const stock0 = b0.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    const sum0 = sumCoilKgRemainingForProduct(b0.body, 'COIL-ALU');

    const split = await agent.post(`/api/coil-lots/${encodeURIComponent('CL-INV-S3')}/split`).send({
      splitKg: 400,
      dateISO: '2026-04-01',
    });
    expect(split.status).toBe(200);
    expect(split.body.ok).toBe(true);

    const b1 = await agent.get('/api/bootstrap');
    const stock1 = b1.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    expect(stock1).toBeCloseTo(stock0, 3);
    const sum1 = sumCoilKgRemainingForProduct(b1.body, 'COIL-ALU');
    expect(sum1).toBeCloseTo(sum0, 2);
    const child = b1.body.coilLots.find((c) => c.coilNo === split.body.newCoilNo);
    expect(child.parentCoilNo).toBe('CL-INV-S3');
  });

  it('S4 — Scrap: coil, raw SKU, and optional scrap SKU move consistently', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S4', 1000);
    const scrap = await agent.post(`/api/coil-lots/${encodeURIComponent('CL-INV-S4')}/scrap`).send({
      kg: 120,
      reason: 'Damage',
      dateISO: '2026-04-01',
      creditScrapInventory: true,
      scrapProductID: 'SCRAP-COIL',
    });
    expect(scrap.status).toBe(200);
    const b = await agent.get('/api/bootstrap');
    const coil = b.body.coilLots.find((c) => c.coilNo === 'CL-INV-S4');
    expect(coil.qtyRemaining).toBeCloseTo(880, 2);
    const scrapP = b.body.products.find((p) => p.productID === 'SCRAP-COIL');
    expect(Number(scrapP.stockLevel)).toBeGreaterThanOrEqual(119.9);
  });

  it('S5 — Reserved mass blocks over-split (integrity guard)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S5', 1000);
    const qref5 = await freshPaidQuotationForCutting(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: qref5,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
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
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const alloc = await agent
      .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/allocations`)
      .send({ allocations: [{ coilNo: 'CL-INV-S5', openingWeightKg: 800 }] });
    expect(alloc.status).toBe(200);

    const split = await agent.post(`/api/coil-lots/${encodeURIComponent('CL-INV-S5')}/split`).send({
      splitKg: 500,
      dateISO: '2026-04-01',
    });
    expect(split.status).toBe(400);
    expect(split.body.ok).toBe(false);
  });

  it('S6 — LAPSE: raw SKU adjust does not change coil rows (book vs floor can diverge)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S6', 900);
    const b0 = await agent.get('/api/bootstrap');
    const coilKg0 = b0.body.coilLots.find((c) => c.coilNo === 'CL-INV-S6').qtyRemaining;

    const blocked = await agent.post('/api/inventory/adjust').send({
      productID: 'COIL-ALU',
      type: 'Decrease',
      qty: 200,
      reasonCode: 'Count correction',
      note: 'Scenario: SKU-only correction',
      dateISO: '2026-04-01',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('COIL_SKU_DRIFT');

    const adj = await agent.post('/api/inventory/adjust').send({
      productID: 'COIL-ALU',
      type: 'Decrease',
      qty: 200,
      reasonCode: 'Count correction',
      note: 'Scenario: SKU-only correction',
      dateISO: '2026-04-01',
      acknowledgeCoilSkuDrift: true,
    });
    expect(adj.status).toBe(200);

    const b1 = await agent.get('/api/bootstrap');
    const coilKg1 = b1.body.coilLots.find((c) => c.coilNo === 'CL-INV-S6').qtyRemaining;
    expect(coilKg1).toBeCloseTo(coilKg0, 3);
    const stock = b1.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    const sumCoils = sumCoilKgRemainingForProduct(b1.body, 'COIL-ALU');
    expect(Math.abs(stock - sumCoils)).toBeGreaterThan(1);
  });

  it('S7 — WIP transfer + FG receipt: store down, WIP consumed, FG up', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const b0 = await agent.get('/api/bootstrap');
    const raw0 = b0.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel;
    const fg0 = b0.body.products.find((p) => p.productID === 'FG-101').stockLevel;

    const tr = await agent.post('/api/inventory/transfer-to-production').send({
      productID: 'COIL-ALU',
      qty: 100,
      productionOrderId: 'INV-S7',
      dateISO: '2026-04-01',
    });
    expect(tr.status).toBe(200);

    const fg = await agent.post('/api/inventory/finished-goods').send({
      productID: 'FG-101',
      qty: 40,
      unitPriceNgn: 0,
      productionOrderId: 'INV-S7-FG',
      dateISO: '2026-04-01',
      wipRelease: { wipSourceProductID: 'COIL-ALU', wipQtyReleased: 80 },
    });
    expect(fg.status).toBe(200);

    const b1 = await agent.get('/api/bootstrap');
    expect(b1.body.products.find((p) => p.productID === 'COIL-ALU').stockLevel).toBeCloseTo(raw0 - 100, 2);
    expect(b1.body.products.find((p) => p.productID === 'FG-101').stockLevel).toBeCloseTo(fg0 + 40, 2);
    expect(b1.body.wipByProduct['COIL-ALU'] ?? 0).toBeCloseTo((b0.body.wipByProduct['COIL-ALU'] || 0) + 20, 2);
  });

  it('S7b — Manual coil finish: closes lot and reconciles COIL-ALU (metre qty must not inflate kg stock)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    await seedOneCoil(agent, 'CL-INV-S7B', 72);
    const b0 = await agent.get('/api/bootstrap');
    const sum0 = sumCoilKgRemainingForProduct(b0.body, 'COIL-ALU');

    const fg = await agent.post('/api/inventory/finished-goods').send({
      productID: 'COIL-ALU',
      qty: 500,
      unitPriceNgn: 0,
      productionOrderId: 'CL-INV-S7B',
      dateISO: '2026-04-01',
      extras: { markSourceCoilFinished: true, sourceCoilNo: 'CL-INV-S7B', spoolKg: 40 },
    });
    expect(fg.status).toBe(200);
    expect(fg.body.ok).toBe(true);

    const b1 = await agent.get('/api/bootstrap');
    const coil = b1.body.coilLots.find((c) => c.coilNo === 'CL-INV-S7B');
    expect(coil.qtyRemaining).toBeCloseTo(0, 3);
    const sum1 = sumCoilKgRemainingForProduct(b1.body, 'COIL-ALU');
    expect(sum1).toBeCloseTo(sum0 - 72, 2);
    /** `products` may list the same SKU once per branch; roll-up stock should match coil sum. */
    const coAluStocks = b1.body.products
      .filter((p) => p.productID === 'COIL-ALU')
      .map((p) => Number(p.stockLevel) || 0);
    expect(Math.max(...coAluStocks, 0)).toBeCloseTo(sum1, 2);
  });

  it('S8 — Stone PO + GRN: procurement_kind stone, stock metres up, movements list GRN', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const ens = await agent.post('/api/inventory/ensure-stone-product').send({
      designLabel: 'InvPoStone',
      colourLabel: 'Slate',
      gaugeLabel: '0.45mm',
    });
    expect(ens.status).toBe(200);
    const stonePid = ens.body.productId;
    const b0 = await agent.get('/api/bootstrap');
    const stock0 = b0.body.products.find((p) => p.productID === stonePid)?.stockLevel ?? 0;

    const sup = await agent.post('/api/suppliers').send({ name: 'Stone PO Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Stone PO Supplier',
      orderDateISO: '2026-04-02',
      expectedDeliveryISO: '',
      status: 'In Transit',
      lines: [
        {
          lineKey: 'L-ST-PO',
          productID: stonePid,
          productName: 'InvPoStone slate',
          color: 'Slate',
          gauge: '0.45mm',
          metersOffered: 50,
          conversionKgPerM: null,
          unitPricePerKgNgn: null,
          unitPriceNgn: 2000,
          qtyOrdered: 50,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    const grn = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId)}/grn`).send({
      entries: [
        {
          lineKey: 'L-ST-PO',
          productID: stonePid,
          qtyReceived: 50,
          location: 'Stone bay',
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Stone PO Supplier',
    });
    expect(grn.status).toBe(200);
    expect(grn.body.ok).toBe(true);

    const b1 = await agent.get('/api/bootstrap');
    const poRow = b1.body.purchaseOrders.find((p) => p.poID === poId);
    expect(poRow?.procurementKind).toBe('stone');
    const stock1 = b1.body.products.find((p) => p.productID === stonePid).stockLevel;
    expect(stock1).toBeCloseTo(stock0 + 50, 2);

    const mov = await agent.get(`/api/inventory/product-movements/${encodeURIComponent(stonePid)}`);
    expect(mov.status).toBe(200);
    expect(mov.body.ok).toBe(true);
    expect(Array.isArray(mov.body.movements)).toBe(true);
    expect(mov.body.movements.some((m) => m.type === 'STORE_GRN_STONE')).toBe(true);
  });

  it('S9 — Accessory PO + GRN: procurement_kind accessory, stock units up, movements list GRN', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const accPid = 'ACC-TAPPING-SCREW-PCS';
    const b0 = await agent.get('/api/bootstrap');
    const stock0 = b0.body.products.find((p) => p.productID === accPid)?.stockLevel ?? 0;

    const sup = await agent.post('/api/suppliers').send({ name: 'Acc PO Supplier', city: 'Lagos' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Acc PO Supplier',
      orderDateISO: '2026-04-02',
      status: 'In Transit',
      lines: [
        {
          lineKey: 'L-ACC-PO',
          productID: accPid,
          productName: 'Tapping screws',
          color: '',
          gauge: '',
          metersOffered: null,
          conversionKgPerM: null,
          unitPricePerKgNgn: 25,
          unitPriceNgn: 25,
          qtyOrdered: 500,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    const grn = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId)}/grn`).send({
      entries: [{ lineKey: 'L-ACC-PO', productID: accPid, qtyReceived: 500, location: 'Parts' }],
      supplierID: sup.body.supplierID,
      supplierName: 'Acc PO Supplier',
    });
    expect(grn.status).toBe(200);

    const b1 = await agent.get('/api/bootstrap');
    expect(b1.body.purchaseOrders.find((p) => p.poID === poId)?.procurementKind).toBe('accessory');
    const stock1 = b1.body.products.find((p) => p.productID === accPid).stockLevel;
    expect(stock1).toBeCloseTo(stock0 + 500, 2);

    const mov = await agent.get(`/api/inventory/product-movements/${encodeURIComponent(accPid)}`);
    expect(mov.status).toBe(200);
    expect(mov.body.movements.some((m) => m.type === 'STORE_GRN_ACCESSORY')).toBe(true);
  });

  it('S10 — Stone production complete: STONE_CONSUMPTION draws metres; FG receipt', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await loginAs(agent);
    const sr = await agent.post('/api/inventory/stone-receipt').send({
      designLabel: 'Milano',
      colourLabel: 'Black',
      gaugeLabel: '0.40mm',
      metresReceived: 120,
    });
    expect(sr.status).toBe(200);
    const stonePid = sr.body.productId;
    const b0 = await agent.get('/api/bootstrap');
    const stone0 = b0.body.products.find((p) => p.productID === stonePid).stockLevel;
    const fg0 = b0.body.products.find((p) => p.productID === 'FG-101').stockLevel;

    const qref = await freshPaidStoneQuotationForCutting(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: qref,
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Stone finished',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 40 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Stone finished',
      plannedMeters: 40,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;

    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [],
    });
    expect(alloc.status).toBe(200);

    const start = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({
      startedAtISO: '2026-04-02',
    });
    expect(start.status).toBe(200);

    const consumedM = 38;
    const complete = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-04-02T16:00:00.000Z',
      stoneMetersConsumed: consumedM,
    });
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);

    const b1 = await agent.get('/api/bootstrap');
    const stone1 = b1.body.products.find((p) => p.productID === stonePid).stockLevel;
    const fg1 = b1.body.products.find((p) => p.productID === 'FG-101').stockLevel;
    expect(stone1).toBeCloseTo(stone0 - consumedM, 2);
    expect(fg1).toBeCloseTo(fg0 + consumedM, 2);

    const mov = await agent.get(`/api/inventory/product-movements/${encodeURIComponent(stonePid)}`);
    expect(mov.body.movements.some((m) => m.type === 'STONE_CONSUMPTION')).toBe(true);
  });
});
