import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { adjustProductStockForBranch, getProductRowForWorkspace } from './productBranchInventory.js';
import { adminForceRecallAndDeleteCuttingList } from './productionTraceability.js';

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

describe.skipIf(!mysqlOk).sequential('admin force-recall completed production + delete cutting list', () => {
  let app;
  let agent;
  let db;

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('rejects non-admin callers', async () => {
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
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

    const sales = request.agent(app);
    await loginAs(sales, 'sales.staff', 'Sales@123');
    const denied = await sales
      .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/admin-force-recall`)
      .send({ reason: 'Duplicate entry — remove this wrong job and cutting list.' });
    expect(denied.status).toBe(403);
  });

  it('admin can force-recall a planned job and delete its cutting list', async () => {
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
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
    const jobID = job.body.jobID;
    const cuttingListId = cutting.body.id;

    const recall = await agent
      .post(`/api/production-jobs/${encodeURIComponent(jobID)}/admin-force-recall`)
      .send({ reason: 'Duplicate cutting list entered twice — admin cleanup.' });
    expect(recall.status).toBe(200);
    expect(recall.body.outcome).toBe('force_recalled_and_cutting_list_deleted');
    expect(db.prepare(`SELECT 1 FROM production_jobs WHERE job_id = ?`).get(jobID)).toBeFalsy();
    expect(db.prepare(`SELECT 1 FROM cutting_lists WHERE id = ?`).get(cuttingListId)).toBeFalsy();
  });

  it('admin force-recall restores stone flatsheet stock on a completed supplied job then deletes the list', () => {
    const productId = 'STONE-FS-TEST-1';
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
       VALUES (?, 'Stone flatsheet test', 100, 'm2', ?)`
    ).run(productId, DEFAULT_BRANCH_ID);

    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-AF-1', 'Admin Force Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json,
        date_iso, branch_id, manager_production_approved_at_iso, manager_production_approval_level
      ) VALUES (
        'QT-AF-STONE-1', 'CUS-AF-1', 'Admin Force Customer', 100000, 0, 'Unpaid', 'Approved', ?,
        '2026-05-01', ?, '2026-05-01T00:00:00.000Z', 'admin'
      )`
    ).run(
      JSON.stringify({
        materialTypeId: 'MAT-005',
        stoneMeterQuote: true,
        materialDesign: 'Bond',
        materialColor: 'Red',
        materialGauge: '0.50mm',
        products: [{ name: 'Stone flatsheet', qty: '10', unitPrice: '1000', lengthM: 2 }],
        accessories: [],
      }),
      DEFAULT_BRANCH_ID
    );

    const cuttingListId = 'CL-AF-STONE-1';
    const jobId = 'JOB-AF-STONE-1';
    db.prepare(
      `INSERT INTO cutting_lists (
        id, quotation_ref, customer_id, customer_name, status, production_registered, production_register_ref, date_iso
      ) VALUES (?, 'QT-AF-STONE-1', 'CUS-AF-1', 'Admin Force Customer', 'Finished', 1, ?, '2026-05-01')`
    ).run(cuttingListId, jobId);
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, cutting_list_id, quotation_ref, customer_id, customer_name, status, branch_id, completed_at_iso, actual_meters, created_at_iso
      ) VALUES (?, ?, 'QT-AF-STONE-1', 'CUS-AF-1', 'Admin Force Customer', 'Completed', ?, '2026-05-02T00:00:00.000Z', 0, '2026-05-01T00:00:00.000Z')`
    ).run(jobId, cuttingListId, DEFAULT_BRANCH_ID);

    adjustProductStockForBranch(db, productId, -10, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_job_stone_flatsheet_usage (
        id, job_id, quotation_ref, quote_line_id, name, length_m, ordered_m2, supplied_m2, deduction_m2,
        inventory_product_id, posted_at_iso
      ) VALUES (
        'PSF-AF-1', ?, 'QT-AF-STONE-1', 'line-1', 'Stone flatsheet', 2, 10, 10, 0, ?, '2026-05-02T00:00:00.000Z'
      )`
    ).run(jobId, productId);

    const before = getProductRowForWorkspace(db, productId, DEFAULT_BRANCH_ID);
    expect(Number(before.stock_level)).toBe(90);

    const r = adminForceRecallAndDeleteCuttingList(
      db,
      jobId,
      { reason: 'Duplicate stone-coated supply entered twice — recall wrong job.' },
      { actor: { id: 'U-ADMIN', roleKey: 'admin', displayName: 'Admin' } }
    );
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('force_recalled_and_cutting_list_deleted');

    const after = getProductRowForWorkspace(db, productId, DEFAULT_BRANCH_ID);
    expect(Number(after.stock_level)).toBe(100);
    expect(db.prepare(`SELECT 1 FROM production_jobs WHERE job_id = ?`).get(jobId)).toBeFalsy();
    expect(db.prepare(`SELECT 1 FROM cutting_lists WHERE id = ?`).get(cuttingListId)).toBeFalsy();
    expect(
      db.prepare(`SELECT 1 FROM production_job_stone_flatsheet_usage WHERE job_id = ?`).get(jobId)
    ).toBeFalsy();
  });
});
