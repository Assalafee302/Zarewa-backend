import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { actorMayApproveMdPriceException, approveMdPriceExceptionForQuotation } from './pricingOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('MD below-floor price exception', () => {
  let app;
  let db;

  async function loginAs(client, username, password) {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    return res;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('actorMayApproveMdPriceException allows md and admin only', () => {
    expect(actorMayApproveMdPriceException({ roleKey: 'md', permissions: ['md.price_exception.approve'] })).toBe(
      true
    );
    expect(actorMayApproveMdPriceException({ roleKey: 'admin', permissions: ['*'] })).toBe(true);
    expect(
      actorMayApproveMdPriceException({ roleKey: 'sales_manager', permissions: ['refunds.approve'] })
    ).toBe(false);
  });

  it('branch manager cannot approve via deprecated bm endpoint', async () => {
    const admin = request.agent(app);
    await loginAs(admin, 'admin', 'Admin@123');
    const q = await admin.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Below floor BM gate',
      dateISO: '2026-06-15',
      lines: {
        materialGauge: '0.55mm',
        materialDesign: 'milano',
        products: [{ name: 'Roof', qty: '10', unitPrice: '500' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const qid = q.body.quotationId;

    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const blocked = await mgr.patch(`/api/quotations/${encodeURIComponent(qid)}/bm-price-exception`).send({});
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error || '')).toMatch(/Managing Director|administrator/i);
  });

  it('MD approval unblocks cutting list for below-floor quote', async () => {
    const admin = request.agent(app);
    await loginAs(admin, 'admin', 'Admin@123');
    await admin.post('/api/pricing/price-list').send({
      gaugeKey: '0.55mm',
      designKey: 'milano',
      unitPricePerMeterNgn: 4000,
      effectiveFromIso: '2026-01-01',
    });

    const q = await admin.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Below floor MD gate',
      dateISO: '2026-06-15',
      lines: {
        materialGauge: '0.55mm',
        materialDesign: 'milano',
        products: [{ name: 'Roof', qty: '10', unitPrice: '500' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const qid = q.body.quotationId;

    const clBlocked = await admin.post('/api/cutting-lists').send({
      quotationRef: qid,
      customerID: 'CUS-001',
      dateISO: '2026-06-15',
      lines: [{ sheets: 2, lengthM: 3.5, totalM: 7, lineType: 'Roof' }],
    });
    expect(clBlocked.status).toBe(400);
    expect(String(clBlocked.body.error || '')).toMatch(/Managing Director|administrator/i);

    const md = request.agent(app);
    await loginAs(md, 'md', 'Md@1234567890!');
    const approve = await md
      .patch(`/api/quotations/${encodeURIComponent(qid)}/md-price-exception-approve`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);

    const actor = { id: 'u-md', roleKey: 'md', permissions: ['md.price_exception.approve'] };
    const again = approveMdPriceExceptionForQuotation(db, qid, actor);
    expect(again.ok).toBe(false);

    db.prepare(
      `UPDATE quotations SET paid_ngn = total_ngn, manager_production_approved_at_iso = ? WHERE id = ?`
    ).run(new Date().toISOString(), qid);

    const clOk = await admin.post('/api/cutting-lists').send({
      quotationRef: qid,
      customerID: 'CUS-001',
      dateISO: '2026-06-15',
      lines: [{ sheets: 2, lengthM: 3.5, totalM: 7, lineType: 'Roof' }],
    });
    expect(clOk.status).toBe(201);
    expect(clOk.body.ok).toBe(true);
  });

  it('published list price at current floor does not block cutting list (current pricing gate)', async () => {
    const admin = request.agent(app);
    await loginAs(admin, 'admin', 'Admin@123');

    await admin.post('/api/pricing/price-list').send({
      gaugeKey: '0.55mm',
      designKey: 'milano',
      unitPricePerMeterNgn: 4000,
      effectiveFromIso: '2026-01-01',
    });
    await admin.post('/api/pricing/price-list').send({
      gaugeKey: '0.55mm',
      designKey: 'milano',
      unitPricePerMeterNgn: 3600,
      effectiveFromIso: '2026-08-01',
    });

    const q = await admin.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Published list gate',
      dateISO: '2026-06-15',
      lines: {
        materialGauge: '0.55mm',
        materialDesign: 'milano',
        products: [{ name: 'Roof', qty: '10', unitPrice: '3600' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const qid = q.body.quotationId;

    db.prepare(`UPDATE quotations SET paid_ngn = total_ngn, payment_gate_basis_total_ngn = total_ngn WHERE id = ?`).run(
      qid
    );

    const clOk = await admin.post('/api/cutting-lists').send({
      quotationRef: qid,
      customerID: 'CUS-001',
      dateISO: '2026-08-17',
      lines: [{ sheets: 2, lengthM: 3.5, totalM: 7, lineType: 'Roof' }],
    });
    expect(clOk.status).toBe(201);
    expect(clOk.body.ok).toBe(true);
  });
});
