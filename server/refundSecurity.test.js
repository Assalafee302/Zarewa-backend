import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { getEligibleRefundQuotations } from './controlOps.js';
import { REFUND_PAYEE } from './refundTestPayee.js';

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
    `UPDATE sales_receipts
     SET finance_reconciliation_saved_at_iso = '2026-04-01T12:00:00Z'
     WHERE quotation_ref LIKE 'QT-RFS-%'`
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
    materialGauge: '0.28mm',
    materialDesign: 'IV',
    products: [
      {
        name: 'Roofing Premium',
        qty: 20,
        unitPrice: 5000,
        gauge: '0.28mm',
        design: 'IV',
      },
    ],
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
    `INSERT OR REPLACE INTO material_pricing_sheet_rows (
      id, material_key, gauge_mm, branch_id, design_key,
      conversion_standard_kg_per_m, conversion_reference_kg_per_m, conversion_history_kg_per_m, conversion_used_kg_per_m,
      cost_per_kg_ngn, overhead_ngn_per_m, profit_ngn_per_m,
      minimum_price_per_m_ngn, commission_ngn_per_m, gauge_customer_label, notes, updated_at_iso, updated_by_user_id
    ) VALUES (
      'MPS-RFS-SUB', 'alu', '0.24', 'BR-KD', 'iv',
      NULL, NULL, NULL, NULL,
      0, 0, 0,
      2200, 800, NULL, 'refund test: floor below list', '2026-01-01', NULL
    )`
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO production_jobs (
      job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso
    ) VALUES ('JOB-RFS-SUB', 'QT-RFS-SUB-001', 'SUB-FG-TEST', 'Longspan economy', 10, 'Completed', '2026-04-01T10:00:00Z')`
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO coil_lots (
      coil_no, product_id, qty_received, qty_remaining, current_weight_kg, current_status, gauge_label, colour
    ) VALUES ('CL-RFS-SUB-1', 'SUB-FG-TEST', 1000, 1000, 1000, 'Available', '0.24mm', 'IV')`
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO production_job_coils (
      id, job_id, sequence_no, coil_no, gauge_label, opening_weight_kg, closing_weight_kg, consumed_weight_kg,
      meters_produced, allocation_status, allocated_at_iso
    ) VALUES (
      'PJC-RFS-SUB-1', 'JOB-RFS-SUB', 1, 'CL-RFS-SUB-1', '0.24mm',
      100, 0, 100, 10, 'Completed', '2026-04-01T10:00:00Z'
    )`
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
      calculationLines: [{ label: 'Overpayment', amountNgn: 1000, category: 'Overpayment' }],
      ...REFUND_PAYEE,
    });
    expect(res1.status).toBe(201);

    const res2 = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 1000,
      calculationLines: [{ label: 'Overpayment', amountNgn: 1000, category: 'Overpayment' }],
      ...REFUND_PAYEE,
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
      calculationLines: [{ label: 'Cancellation', amountNgn: 5000, category: 'Order cancellation' }],
      ...REFUND_PAYEE,
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
      ...REFUND_PAYEE,
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
    expect(unproduced.category).toBe('Unproduced meterage');
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
    expect(sub.amountNgn).toBe(28_000);
    const bd = preview.body.preview.substitutionPerMeterBreakdown;
    expect(Array.isArray(bd)).toBe(true);
    expect(bd).toHaveLength(1);
    expect(bd[0].deltaPerMeterNgn).toBe(2800);
    expect(bd[0].creditNgn).toBe(28_000);
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

  it('excludes Corrugation service from refund preview (other services unchanged)', async () => {
    const linesJson = JSON.stringify({
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000 }],
      accessories: [],
      services: [
        { name: 'Corrugation', qty: 1, unit_price_ngn: 50000 },
        { name: 'Site bending', qty: 1, unit_price_ngn: 5000 },
      ],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-CORR-SVC','CUS-001','John Doe',105000,105000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-CORR','CUS-001','John Doe','QT-RFS-CORR-SVC',105000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-CORR','QT-RFS-CORR-SVC',10,'Completed','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({
      quotationRef: 'QT-RFS-CORR-SVC',
      reasonCategory: ['Additional services'],
    });

    expect(preview.status).toBe(200);
    const addl = preview.body.preview.suggestedLines.find((l) => l.category === 'Additional services');
    expect(addl).toBeDefined();
    expect(addl.amountNgn).toBe(5000);
    expect(String(addl.label || '')).not.toMatch(/50000|50,?000/);
    expect(String(addl.label || '')).toMatch(/bending/i);
  });

  it('unproduced metre preview uses roofing sheet metres only (ignores Eaves angle trim lines)', async () => {
    const linesJson = JSON.stringify({
      products: [
        { name: 'Roofing Sheet', qty: 20, unitPrice: 5000 },
        { name: 'Eaves angle', qty: 10, unitPrice: 2000 },
      ],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-TRIM-M','CUS-001','John Doe',120000,120000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-TRIM','CUS-001','John Doe','QT-RFS-TRIM-M',120000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-TRIM','QT-RFS-TRIM-M',20,'Completed','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-TRIM-M' });
    expect(preview.status).toBe(200);
    const unpr = preview.body.preview.suggestedLines.find((l) => l.category === 'Unproduced meterage');
    expect(unpr).toBeUndefined();
  });

  it('unproduced metre preview ignores stone flatsheet qty (not coil roofing metres)', async () => {
    const linesJson = JSON.stringify({
      products: [{ name: 'Stone flatsheet 1.5', qty: 15, unitPrice: 80000 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-SF-ONLY','CUS-001','John Doe',1200000,1200000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-SF','CUS-001','John Doe','QT-RFS-SF-ONLY',1200000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-SF','QT-RFS-SF-ONLY',0,'Completed','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-SF-ONLY' });
    expect(preview.status).toBe(200);
    const unpr = preview.body.preview.suggestedLines.find((l) => l.category === 'Unproduced meterage');
    expect(unpr).toBeUndefined();
  });

  it('roofing unproduced preview uses only coil roofing lines for metres and blended ₦/m (excludes stone flatsheet)', async () => {
    const linesJson = JSON.stringify({
      products: [
        { name: 'Roofing Sheet', qty: 10, unitPrice: 5000 },
        { name: 'Stone flatsheet 1.4', qty: 15, unitPrice: 80000 },
      ],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-SF-MIX','CUS-001','John Doe',1250000,1250000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-SFM','CUS-001','John Doe','QT-RFS-SF-MIX',1250000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-SFM','QT-RFS-SF-MIX',0,'Completed','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent);

    const preview = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-SF-MIX' });
    expect(preview.status).toBe(200);
    const unpr = preview.body.preview.suggestedLines.find((l) => l.category === 'Unproduced meterage');
    expect(unpr).toBeDefined();
    expect(unpr.amountNgn).toBe(50000);
    expect(String(unpr.label || '')).toMatch(/10\.00/);
    expect(String(unpr.label || '')).toMatch(/5,?000/);
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
      ...REFUND_PAYEE,
    });
    expect(first.status).toBe(201);

    const second = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Transport issue'],
      amountNgn: 300,
      calculationLines: [{ label: 'Transport', amountNgn: 300, category: 'Transport issue' }],
      ...REFUND_PAYEE,
    });
    expect(second.status).toBe(201);

    const rows = getEligibleRefundQuotations(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('QT-RFS-DUP-001');
    const row = rows.find((r) => r.id === 'QT-RFS-DUP-001');
    expect(Number(row?.remaining_ngn)).toBeGreaterThan(0);
    expect(Number(row?.cash_in_ngn)).toBeGreaterThan(0);
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
    expect(preview.body.preview.blockedRefundCategories).toContain('Unproduced meterage');

    const create = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-UNPR-001',
      reasonCategory: ['Order cancellation'],
      amountNgn: 1000,
      calculationLines: [{ label: 'Cancel', amountNgn: 1000, category: 'Order cancellation' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(400);
    expect(String(create.body.error || '')).toMatch(/delivered/i);
  });

  it('getEligibleRefundQuotations includes quotations with Cancelled production job', () => {
    const linesJson = JSON.stringify({
      products: [{ name: 'R', qty: 20, unitPrice: 2500 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json)
       VALUES ('QT-RFS-CANC-JOB','CUS-001','John Doe',50000,50000,'Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-CANC','QT-RFS-CANC-JOB',0,'Cancelled','2026-04-01T10:00:00Z')`
    ).run();
    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-RFS-CANC-JOB')).toBe(true);
  });

  it('getEligibleRefundQuotations treats Cancelled refund like Rejected (headroom restored)', () => {
    const linesRefCanc = JSON.stringify({
      products: [{ name: 'R', qty: 20, unitPrice: 2500 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json)
       VALUES ('QT-RFS-REF-CANC','CUS-001','John Doe',50000,50000,'Finished',?)`
    ).run(linesRefCanc);
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-RC','QT-RFS-REF-CANC',0,'Cancelled','2026-04-01T10:00:00Z')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, calculation_lines_json, status, requested_by, requested_at_iso,
        approval_date, approved_by, approved_amount_ngn, manager_comments,
        paid_amount_ngn, branch_id
      ) VALUES (
        'RF-RFS-RC-001','CUS-001','John Doe','QT-RFS-REF-CANC','—','[]','test',
        30000,'[]','Cancelled','Tester','2026-04-01T10:00:00Z',
        '','',0,'',0,'BR-KD'
      )`
    ).run();

    const rows = getEligibleRefundQuotations(db);
    const row = rows.find((r) => r.id === 'QT-RFS-REF-CANC');
    expect(row).toBeTruthy();
    expect(Number(row.total_refunded)).toBe(0);
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

  it('GET /api/refunds/intelligence: substitution data quality when quoted gauge set but job has no coil allocations', async () => {
    const linesJson = JSON.stringify({
      materialGauge: '0.22mm',
      materialColor: 'Blue',
      materialDesign: 'Longspan',
      products: [{ name: 'Longspan roofing', qty: 10, unitPrice: 5000 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-GG-MIS','CUS-001','John Doe',50000,50000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO products (product_id, name, stock_level, unit, branch_id, gauge, colour, material_type)
       VALUES ('FG-GG-MIS','Longspan roofing',0,'m','BR-KD','0.18mm','Blue','Aluminium')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, product_id, product_name, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-GG','QT-RFS-GG-MIS','FG-GG-MIS','Longspan roofing',10,'Completed','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const res = await agent.get('/api/refunds/intelligence').query({ quotationRef: 'QT-RFS-GG-MIS' });
    expect(res.status).toBe(200);
    expect(res.body.dataQualityIssues.some((x) => x.code === 'substitution_coil_gauge_missing')).toBe(true);
  });

  it('getEligibleRefundQuotations includes paid Void quotations without a production job', () => {
    const linesVoidPaid = JSON.stringify({
      products: [{ name: 'R', qty: 10, unitPrice: 2000 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, archived, lines_json)
       VALUES ('QT-RFS-VOID-PAID','CUS-001','John Doe',20000,30000,'Void',1,?)`
    ).run(linesVoidPaid);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-VP','CUS-001','John Doe','QT-RFS-VOID-PAID',30000,'Confirmed','2026-04-01')`
    ).run();
    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-RFS-VOID-PAID')).toBe(true);
  });

  it('GET /api/refunds/eligibility-check: positive automatic preview → appears in dropdown; manual-only path false', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const res = await agent.get('/api/refunds/eligibility-check').query({ quotationRef: 'QT-RFS-OVR-001' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetsBackendRules).toBe(true);
    expect(res.body.previewOk).toBe(true);
    expect(res.body.wouldAppearInRefundQuotationDropdown).toBe(true);
    expect(res.body.manualEntryRefundAllowed).toBe(false);
    expect(res.body.diagnostics.suggestedPreviewAmountNgn).toBeGreaterThanOrEqual(1000);
  });

  it('GET /api/refunds/eligibility-check: ₦0 automatic preview but otherwise valid → manualEntryRefundAllowed; appears in fast eligible list', async () => {
    const linesJson = JSON.stringify({
      products: [{ name: 'Roofing', qty: 10, unitPrice: 5000 }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES ('QT-RFS-MAN-ZERO','CUS-001','John Doe',50000,50000,'Paid','Finished',?)`
    ).run(linesJson);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-RFS-MZ','CUS-001','John Doe','QT-RFS-MAN-ZERO',50000,'Confirmed','2026-04-01')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES ('JOB-RFS-MZ','QT-RFS-MAN-ZERO',10,'Cancelled','2026-04-01T10:00:00Z')`
    ).run();

    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');

    const previewRes = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-MAN-ZERO' });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.preview.suggestedAmountNgn).toBe(0);

    const res = await agent.get('/api/refunds/eligibility-check').query({ quotationRef: 'QT-RFS-MAN-ZERO' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetsBackendRules).toBe(true);
    expect(res.body.previewOk).toBe(true);
    expect(res.body.wouldAppearInRefundQuotationDropdown).toBe(false);
    expect(res.body.manualEntryRefundAllowed).toBe(true);
    expect(res.body.diagnostics.suggestedPreviewAmountNgn).toBe(0);
    expect(Array.isArray(res.body.eligibleRefundCategories)).toBe(true);
    expect(res.body.eligibleRefundCategories.length).toBeGreaterThan(0);
    expect(res.body.blockingReasons.some((r) => /automatic preview|preview total/i.test(String(r)))).toBe(
      true
    );

    const rows = getEligibleRefundQuotations(db);
    expect(rows.some((r) => r.id === 'QT-RFS-MAN-ZERO')).toBe(true);
    const listed = rows.find((r) => r.id === 'QT-RFS-MAN-ZERO');
    expect(Number(listed?.remaining_ngn)).toBeGreaterThan(1000);
  });

  it('GET /api/refunds/eligibility-check: missing quotationRef → 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const res = await agent.get('/api/refunds/eligibility-check');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects POST /api/refunds when a line exceeds system-calculated category max', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const preview = await agent.post('/api/refunds/preview').send({ quotationRef: 'QT-RFS-OVR-001' });
    expect(preview.status).toBe(200);
    const overLine = (preview.body.preview?.suggestedLines || []).find((l) => l.category === 'Overpayment');
    expect(overLine).toBeTruthy();
    const inflated = Math.round(Number(overLine.amountNgn) || 0) + 5000;
    const res = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-OVR-001',
      reasonCategory: ['Overpayment'],
      amountNgn: inflated,
      calculationLines: [{ label: 'Overpayment', amountNgn: inflated, category: 'Overpayment' }],
      ...REFUND_PAYEE,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/system-calculated|Overpayment/i);
  });

  it('rejects POST /api/refunds when amountNgn does not match sum of included calculation lines', async () => {
    const agent = request.agent(app);
    await loginAs(agent, 'sales.staff', 'Sales@123');
    const res = await agent.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-OVR-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 19_999,
      calculationLines: [{ label: 'Overpayment', amountNgn: 20_000, category: 'Overpayment' }],
      ...REFUND_PAYEE,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toMatch(/sum of included breakdown lines/i);
  });

  it('rejects approval when payload calculationLines sum ≠ approvedAmountNgn', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-OVR-001',
      reasonCategory: ['Overpayment'],
      amountNgn: 5000,
      calculationLines: [{ label: 'Overpayment', amountNgn: 5000, category: 'Overpayment' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);

    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const bad = await mgr.post(`/api/refunds/${encodeURIComponent(create.body.refundID)}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 1000,
      calculationLines: [{ label: 'Overpayment', amountNgn: 5000, category: 'Overpayment' }],
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error || '')).toMatch(/sum of included breakdown lines/i);
  });
});

describe('Refund Phase 11A controls', () => {
  let app;
  let db;
  const savedEnv = {};

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    return client;
  }

  beforeEach(async () => {
    savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS = process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
    db = createDatabase(':memory:');
    seedData(db);
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
    if (savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS === undefined) {
      delete process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
    } else {
      process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS;
    }
  });

  it('blocks branch manager from approving own refund request', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-SELF-002',
      reasonCategory: ['Order cancellation'],
      amountNgn: 5000,
      calculationLines: [{ label: 'Cancellation', amountNgn: 5000, category: 'Order cancellation' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;
    db.prepare(`UPDATE customer_refunds SET requested_by_user_id = ? WHERE refund_id = ?`).run(
      'USR-SM',
      refundID
    );

    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const approve = await mgr.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 5000,
    });
    expect(approve.status).toBe(400);
    expect(String(approve.body.error || '')).toMatch(/cannot approve a refund you requested/i);
  });

  it('allows admin full request → approve → pay chain with audit trail', async () => {
    const admin = request.agent(app);
    await loginAs(admin);
    const before = await admin.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const create = await admin.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-DUP-001',
      reasonCategory: ['Other'],
      amountNgn: 500,
      calculationLines: [{ label: 'Adjustment', amountNgn: 500, category: 'Other' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;

    const approve = await admin.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 500,
    });
    expect(approve.status).toBe(200);

    const pay = await admin.post(`/api/refunds/${refundID}/pay`).send({
      treasuryAccountId,
      amountNgn: 500,
    });
    expect(pay.status).toBe(200);

    const audit = db
      .prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action LIKE 'refund.dual_control.admin_trial%'`)
      .all(refundID);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('blocks branch manager from approving refunds above MD threshold', async () => {
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      'QT-RFS-HIVAL',
      'CUS-001',
      'High Value Co',
      2_500_000,
      2_500_000,
      'Paid',
      'Finished',
      JSON.stringify({ products: [{ name: 'Roof', qty: 500, unitPrice: 5000 }], accessories: [], services: [] })
    );
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES ('RCT-HIVAL', 'CUS-001', 'High Value Co', 'QT-RFS-HIVAL', 2500000, 'Confirmed', '2026-04-01')`
    ).run();

    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'High Value Co',
      quotationRef: 'QT-RFS-HIVAL',
      reasonCategory: ['Overpayment'],
      amountNgn: 1_500_000,
      calculationLines: [{ label: 'Overpayment', amountNgn: 1_500_000, category: 'Overpayment' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;

    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const bm = await mgr.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 1_500_000,
    });
    expect(bm.status).toBe(400);
    expect(String(bm.body.error || '')).toMatch(/MD\/CEO-level approval/i);

    const md = request.agent(app);
    await loginAs(md, 'md', 'Md@1234567890!');
    const mdOk = await md.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 1_500_000,
    });
    expect(mdOk.status).toBe(200);
  });

  it('blocks cashier from approving refunds (payout only)', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-PRICE-027',
      reasonCategory: ['Calculation error'],
      amountNgn: 100,
      calculationLines: [{ label: 'Fix', amountNgn: 100, category: 'Calculation error' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);

    const cashier = request.agent(app);
    await loginAs(cashier, 'cashier', 'Cashier@12345!');
    const approve = await cashier.post(`/api/refunds/${encodeURIComponent(create.body.refundID)}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 100,
    });
    expect(approve.status).toBe(400);
    expect(String(approve.body.error || '')).toMatch(/cashiers may only pay/i);
  });

  it('blocks approver from paying same refund when ENFORCE_DUAL_CONTROL_PAYMENTS=1', async () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '1';
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const create = await staff.post('/api/refunds').send({
      customerID: 'CUS-001',
      customer: 'John Doe',
      quotationRef: 'QT-RFS-SELF-002',
      reasonCategory: ['Order cancellation'],
      amountNgn: 5000,
      calculationLines: [{ label: 'Cancellation', amountNgn: 5000, category: 'Order cancellation' }],
      ...REFUND_PAYEE,
    });
    expect(create.status).toBe(201);
    const refundID = create.body.refundID;

    const fin = request.agent(app);
    await loginAs(fin, 'finance.manager', 'Finance@123');
    const approve = await fin.post(`/api/refunds/${refundID}/decision`).send({
      status: 'Approved',
      approvedAmountNgn: 5000,
    });
    expect(approve.status).toBe(200);

    const before = await fin.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const finPayBlocked = await fin.post(`/api/refunds/${refundID}/pay`).send({
      treasuryAccountId,
      amountNgn: 5000,
    });
    expect(finPayBlocked.status).toBe(400);
    expect(String(finPayBlocked.body.error || '')).toMatch(/cannot pay out a refund you approved/i);

    const cashier = request.agent(app);
    await loginAs(cashier, 'cashier', 'Cashier@12345!');
    const cashierPay = await cashier.post(`/api/refunds/${refundID}/pay`).send({
      treasuryAccountId,
      amountNgn: 5000,
    });
    expect(cashierPay.status).toBe(200);
  });
});
