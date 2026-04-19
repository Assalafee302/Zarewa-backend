import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { getEligibleRefundQuotations } from './controlOps.js';

/** Isolated quotation IDs so rows are not merged with totals from `seedEverything()`. */
function seedData(db) {
  const linesOvr = JSON.stringify({
    products: [{ name: 'Roofing', qty: 20, unitPrice: 5000 }],
    accessories: [],
    services: [],
  });
  const linesUnpr = JSON.stringify({
    products: [{ name: 'Roofing', qty: 20, unitPrice: 5000 }],
    accessories: [],
    services: [],
  });
  const linesDup = JSON.stringify({
    products: [{ name: 'X', qty: 1, unitPrice: 1000 }],
    accessories: [],
    services: [],
  });
  const linesSelf = JSON.stringify({
    products: [{ name: 'Roofing', qty: 1, unitPrice: 50000 }],
    accessories: [],
    services: [],
  });
  const linesPrice = JSON.stringify({
    products: [{ name: 'Special', qty: 1, unitPrice: 12000 }],
    accessories: [],
    services: [],
  });

  const insQ = db.prepare(
    `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  insQ.run('QT-RFS-OVR-001', 'CUS-001', 'John Doe', 100000, 120000, 'Paid', 'Finished', linesOvr);
  insQ.run('QT-RFS-UNPR-001', 'CUS-001', 'John Doe', 100000, 100000, 'Paid', 'Finished', linesUnpr);
  insQ.run('QT-RFS-DUP-001', 'CUS-001', 'John Doe', 1000, 1000, 'Paid', 'Finished', linesDup);
  insQ.run('QT-RFS-SELF-002', 'CUS-001', 'John Doe', 50000, 50000, 'Paid', 'Finished', linesSelf);
  insQ.run('QT-RFS-PRICE-027', 'CUS-NDA', 'NDA Corp', 12000, 12000, 'Paid', 'Finished', linesPrice);

  const linesDeliverySvc = JSON.stringify({
    products: [{ name: 'Roofing', qty: 10, unitPrice: 5000 }],
    accessories: [],
    services: [{ name: 'Site delivery', qty: 1, unit_price_ngn: 75000 }],
  });
  insQ.run('QT-RFS-TRN-001', 'CUS-001', 'John Doe', 125000, 125000, 'Paid', 'Finished', linesDeliverySvc);

  const linesBundleSvc = JSON.stringify({
    products: [{ name: 'Roofing', qty: 5, unitPrice: 5000 }],
    accessories: [],
    services: [{ name: 'Transport and installation', qty: 1, value: 99000 }],
  });
  insQ.run('QT-RFS-BND-001', 'CUS-001', 'John Doe', 124000, 124000, 'Paid', 'Finished', linesBundleSvc);

  const linesCalcMismatch = JSON.stringify({
    products: [{ name: 'Roofing', qty: 10, unitPrice: 5000 }],
    accessories: [],
    services: [],
  });
  insQ.run('QT-RFS-CALC-001', 'CUS-001', 'John Doe', 50001, 50001, 'Paid', 'Finished', linesCalcMismatch);

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-BND', 'CUS-001', 'John Doe', 'QT-RFS-BND-001', 124000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-CALC', 'CUS-001', 'John Doe', 'QT-RFS-CALC-001', 50001, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-OVR', 'CUS-001', 'John Doe', 'QT-RFS-OVR-001', 120000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-UNPR', 'CUS-001', 'John Doe', 'QT-RFS-UNPR-001', 100000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-DUP', 'CUS-001', 'John Doe', 'QT-RFS-DUP-001', 1000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-SELF', 'CUS-001', 'John Doe', 'QT-RFS-SELF-002', 50000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-PRICE', 'CUS-NDA', 'NDA Corp', 'QT-RFS-PRICE-027', 12000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
     VALUES ('RCT-RFS-TRN', 'CUS-001', 'John Doe', 'QT-RFS-TRN-001', 125000, 'Confirmed', '2026-04-01')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
     VALUES ('JOB-RFS-OVR', 'QT-RFS-OVR-001', 100, 'Completed', '2026-04-01T10:00:00Z')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
     VALUES ('JOB-RFS-UNPR', 'QT-RFS-UNPR-001', 0, 'Cancelled', '2026-04-01T10:00:00Z')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
     VALUES ('JOB-RFS-DUP', 'QT-RFS-DUP-001', 0, 'Cancelled', '2026-04-01T10:00:00Z')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
     VALUES ('JOB-RFS-SELF', 'QT-RFS-SELF-002', 0, 'Cancelled', '2026-04-01T10:00:00Z')`
  ).run();

  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
     VALUES ('JOB-RFS-PRICE', 'QT-RFS-PRICE-027', 0, 'Cancelled', '2026-04-01T10:00:00Z')`
  ).run();

  const linesSub = JSON.stringify({
    products: [{ name: 'Roofing Premium', qty: 20, unitPrice: 5000 }],
    accessories: [],
    services: [],
  });
  insQ.run('QT-RFS-SUB-001', 'CUS-001', 'John Doe', 100000, 100000, 'Paid', 'Finished', linesSub);
  db.prepare(
    `INSERT OR REPLACE INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
     VALUES ('SUB-FG-TEST', 'Longspan economy', 0, 'm', 'BR-KD', '0.24mm', 'IV', 'Aluminium')`
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO price_list_items (
      id, gauge_key, design_key, unit_price_per_meter_ngn, sort_order, notes, branch_id, effective_from_iso
    ) VALUES ('PL-RFS-SUB', '0.24mm', 'iv', 3000, 0, 'test', NULL, '2026-01-01')`
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (
      job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso
    ) VALUES ('JOB-RFS-SUB', 'QT-RFS-SUB-001', 'SUB-FG-TEST', 'Longspan economy', 10, 'Completed', '2026-04-01T10:00:00Z')`
  ).run();
}

describe('Refund Security & Substitution Logic', () => {
  let app;
  let db;

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    return client;
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    seedData(db);
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('blocks duplicate refund requests for the same quotation and category', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');

    const res1 = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 1000,
    });
    expect(res1.status).toBe(201);

    const res2 = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 1000,
    });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/already exists/i);
  });

  it('branch manager approves refund raised by sales (no refund.request on branch manager)', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-SELF-002',
      reasonCategory: ['Order cancellation'],
      amountNgn: 5000,
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;

    const manager = request.agent(app);
    await loginAs(manager, 'sales.manager', 'Sales@123');
    const approve = await manager.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 5000,
      note: 'Branch manager approval',
    });
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);
  });

  it('managing director approves refund raised by sales (refunds.approve)', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-PRICE-027',
      reasonCategory: ['Calculation error'],
      amountNgn: 100,
      calculationLines: [{ label: 'Header vs lines', amountNgn: 100, category: 'Calculation error' }],
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;

    const md = request.agent(app);
    await loginAs(md, 'md', 'Md@1234567890!');
    const approve = await md.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 100,
      note: 'MD approval',
    });
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);
  });

  it('validates overpayment detection', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-OVR-001',
      reasonCategory: ['Overpayment'],
    });

    expect(preview.status).toBe(200);
    const lines = preview.body.preview.suggestedLines;
    const overpayment = lines.find((l) => l.category === 'Overpayment');
    expect(overpayment).toBeDefined();
    expect(overpayment.amountNgn).toBe(20000);
  });

  it('validates unproduced meter detection', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-UNPR-001',
      reasonCategory: ['Order cancellation'],
      quotedMeters: 120,
      actualMeters: 100,
      pricePerMeterNgn: 5000,
    });

    expect(preview.status).toBe(200);
    const lines = preview.body.preview.suggestedLines;
    const unproduced = lines.find((l) => l.label.includes('Unproduced'));
    expect(unproduced).toBeDefined();
    expect(unproduced.amountNgn).toBe(100000);
    expect(preview.body.preview.suggestedAmountNgn).toBe(100000);
  });

  it('suggests substitution credit from per-metre delta × produced metres', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-SUB-001',
    });

    expect(preview.status).toBe(200);
    const sub = preview.body.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeDefined();
    expect(sub.amountNgn).toBe(20_000);
    const bd = preview.body.preview.substitutionPerMeterBreakdown;
    expect(Array.isArray(bd)).toBe(true);
    expect(bd).toHaveLength(1);
    expect(bd[0].deltaPerMeterNgn).toBe(2000);
    expect(bd[0].creditNgn).toBe(20_000);
    expect(bd[0].meters).toBe(10);
  });

  it('honours substitutePricePerMeterNgn override for substitution delta', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-SUB-001',
      substitutePricePerMeterNgn: 3500,
    });

    expect(preview.status).toBe(200);
    const sub = preview.body.preview.suggestedLines.find((l) => l.category === 'Substitution Difference');
    expect(sub).toBeDefined();
    expect(sub.amountNgn).toBe(15_000);
  });

  it('flags price variance > 5%', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-PRICE-027',
      pricePerMeterNgn: 15000,
    });

    expect(preview.status).toBe(200);
    expect(preview.body.preview.warnings.some((w) => w.includes('deviates by more than 5%'))).toBe(true);
  });

  it('suggests transport refund for delivery-style service names and snake_case prices', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-TRN-001',
      reasonCategory: ['Transport issue'],
    });

    expect(preview.status).toBe(200);
    const transport = preview.body.preview.suggestedLines.find((l) => l.category === 'Transport issue');
    expect(transport).toBeDefined();
    expect(transport.amountNgn).toBe(75000);
  });

  it('suggests bundled transport+installation when only Installation issue is selected', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-BND-001',
      reasonCategory: ['Installation issue'],
    });

    expect(preview.status).toBe(200);
    const bundle = preview.body.preview.suggestedLines.find((l) =>
      Array.isArray(l.appliesToCategories) && l.appliesToCategories.includes('Installation issue')
    );
    expect(bundle).toBeDefined();
    expect(bundle.amountNgn).toBe(99000);
  });

  it('detects service amounts from value-only lines', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-BND-001',
      reasonCategory: ['Transport issue'],
    });

    expect(preview.status).toBe(200);
    const bundle = preview.body.preview.suggestedLines.find((l) => l.amountNgn === 99000);
    expect(bundle).toBeDefined();
  });

  it('suggests calculation error when header total disagrees with line sum', async () => {
    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-CALC-001',
      reasonCategory: ['Calculation error'],
    });

    expect(preview.status).toBe(200);
    const calc = preview.body.preview.suggestedLines.find((l) => l.category === 'Calculation error');
    expect(calc).toBeDefined();
    expect(calc.amountNgn).toBe(1);
  });

  it('allows a second refund on the same quotation for a different category', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');

    const first = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 500,
      calculationLines: [{ label: 'Overpayment', amountNgn: 500, category: 'Overpayment' }],
    });
    expect(first.status).toBe(201);

    const second = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Transport issue'],
      amountNgn: 300,
      calculationLines: [{ label: 'Transport', amountNgn: 300, category: 'Transport issue' }],
    });
    expect(second.status).toBe(201);
  });

  it('blocks order cancellation after a delivery is marked for the quotation', async () => {
    db.prepare(
      `INSERT OR REPLACE INTO deliveries (
        id, quotation_ref, customer_id, customer_name, cutting_list_id, destination, method, status,
        tracking_no, ship_date, eta, delivered_date_iso, pod_notes, courier_confirmed, customer_signed_pod, fulfillment_posted, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'DLV-RFS-BLK',
      'QT-RFS-UNPR-001',
      'CUS-001',
      'John Doe',
      null,
      'Site',
      'Truck',
      'Delivered',
      null,
      '2026-04-01',
      '2026-04-01',
      '2026-04-02',
      null,
      0,
      0,
      1,
      'BR-KD'
    );

    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-UNPR-001',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.blockedRefundCategories).toContain('Order cancellation');

    const create = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-UNPR-001',
      reasonCategory: ['Order cancellation'],
      amountNgn: 1000,
      calculationLines: [{ label: 'Cancel', amountNgn: 1000, category: 'Order cancellation' }],
    });
    expect(create.status).toBe(400);
    expect(String(create.body.error || '')).toMatch(/delivered/i);
  });

  it('getEligibleRefundQuotations includes quotations with Cancelled production job', () => {
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json)
       VALUES ('QT-RFS-CANC-JOB','CUS-001','John Doe',50000,50000,'Finished','{}')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-CANC','QT-RFS-CANC-JOB',0,'Cancelled','2026-04-01T10:00:00Z')`
    ).run();
    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-RFS-CANC-JOB')).toBe(true);
  });

  it('preview counts actual metres from Cancelled production jobs', async () => {
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json)
       VALUES ('QT-RFS-CANC-M','CUS-001','John Doe',100000,100000,'Finished','{"products":[{"name":"R","qty":10,"unitPrice":10000}],"accessories":[],"services":[]}')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-CM','CUS-001','John Doe','QT-RFS-CANC-M',100000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-CM','QT-RFS-CANC-M',14.5,'Cancelled','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const preview = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-CANC-M' });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.actualMeters).toBeCloseTo(14.5, 5);
  });

  it('GET /api/refunds/intelligence includes dataQualityIssues array', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const res = await agent.get('/api/refunds/intelligence?quotationRef=QT-RFS-SUB-001');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.dataQualityIssues)).toBe(true);
  });

  it('getEligibleRefundQuotations includes paid Void quotations without a production job', () => {
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, archived, lines_json)
       VALUES ('QT-RFS-VOID-PAID','CUS-001','John Doe',30000,30000,'Void',1,'{}')`
    ).run();
    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-RFS-VOID-PAID')).toBe(true);
  });
});
