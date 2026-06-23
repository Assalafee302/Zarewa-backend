import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { createFixedAsset } from './accountingPhase2Ops.js';
import { postOpeningPackJournal } from './accountingOpeningPackOps.js';
import { postDepreciationRun } from './depreciationRunOps.js';

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

describe('opening pack branch scope (pure)', () => {
  it('blocks opening pack post for ALL workspace scope', () => {
    const result = postOpeningPackJournal(null, { branchScope: 'ALL', createdByUserId: 'u-test' });
    expect(result.ok).toBe(false);
    expect(String(result.error || '')).toMatch(/single branch/i);
  });
});

describe.skipIf(!mysqlOk)('Finance / sales / accounting branch isolation', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    app = undefined;
  });

  async function loginAdmin() {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);
    return agent;
  }

  async function branchIds(agent) {
    const boot = await agent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const branches = boot.body.workspaceBranches || [];
    expect(branches.length).toBeGreaterThanOrEqual(2);
    return { branchA: branches[0].id, branchB: branches[1].id, boot };
  }

  it('rejects cross-branch delivery confirm', async () => {
    const agent = await loginAdmin();
    const { branchA, branchB } = await branchIds(agent);

    db.prepare(
      `INSERT INTO deliveries (id, quotation_ref, customer_name, status, branch_id)
       VALUES (?, ?, ?, ?, ?)`
    ).run('DL-ISO-A', 'QT-ISO-A', 'Branch A delivery', 'Scheduled', branchA);

    await agent.patch('/api/session/workspace').send({ currentBranchId: branchB, viewAllBranches: false });

    const confirm = await agent.post('/api/deliveries/DL-ISO-A/confirm').send({ status: 'Delivered' });
    expect(confirm.status).toBe(403);
    expect(String(confirm.body.error || '')).toMatch(/branch/i);
  });

  it('rejects cross-branch sales receipt bank confirmation', async () => {
    const agent = await loginAdmin();
    const { branchA, branchB } = await branchIds(agent);

    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('QT-RCP-A', 'CUS-001', 'Cust A', 100_000, 0, 'Unpaid', 'Approved', '{}', '2026-06-01', branchA);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('RC-ISO-A', 'CUS-001', 'Cust A', 'QT-RCP-A', 50_000, 'Posted', '2026-06-02');

    await agent.patch('/api/session/workspace').send({ currentBranchId: branchB, viewAllBranches: false });

    const patch = await agent
      .patch('/api/sales-receipts/RC-ISO-A/bank-confirmation')
      .send({ confirmed: true, reason: 'Branch isolation test' });
    expect(patch.status).toBe(403);
    expect(String(patch.body.error || '')).toMatch(/branch/i);
  });

  it('rejects cross-branch AP payment when PO belongs to another branch', async () => {
    const agent = await loginAdmin();
    const { branchA, branchB, boot } = await branchIds(agent);
    const treasuryAccountId = boot.body.treasuryAccounts?.[0]?.id;
    expect(treasuryAccountId).toBeTruthy();

    db.prepare(
      `INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('PO-ISO-AP-A', 'SUP-001', 'ISO Supplier', '2026-06-01', 'Approved', branchA);
    db.prepare(
      `INSERT INTO accounts_payable (ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('AP-ISO-A', 'ISO Supplier', 'PO-ISO-AP-A', 'INV-ISO-A', 200_000, 0, '2026-06-30');

    await agent.patch('/api/session/workspace').send({ currentBranchId: branchB, viewAllBranches: false });

    const pay = await agent.post('/api/accounts-payable/AP-ISO-A/pay').send({
      amountNgn: 50_000,
      paymentMethod: 'Bank transfer',
      treasuryAccountId,
      reference: 'ISO-AP-PAY',
      dateISO: '2026-06-15',
    });
    expect(pay.status).toBe(400);
    expect(String(pay.body.error || '')).toMatch(/branch/i);
  });

  it('HTTP rejects opening pack post while all-branches view is on', async () => {
    const md = request.agent(app);
    const login = await md.post('/api/session/login').send({ username: 'md', password: 'Md@1234567890!' });
    expect(login.status).toBe(200);
    await md.patch('/api/session/workspace').send({ viewAllBranches: true });

    const post = await md.post('/api/finance/opening-pack/post').send({ capitalNgn: 0 });
    expect(post.status).toBe(400);
    expect(String(post.body.error || '')).toMatch(/single branch|All branches/i);
  });

  it('blocks treasury bulk replace while all-branches view is on', async () => {
    const fin = request.agent(app);
    const login = await fin.post('/api/session/login').send({ username: 'finance.manager', password: 'Finance@123' });
    expect(login.status).toBe(200);
    await fin.patch('/api/session/workspace').send({ viewAllBranches: true });

    const put = await fin.put('/api/treasury/accounts').send({
      reason: 'Branch isolation bulk test',
      accounts: [{ id: 1, name: 'Test', bankName: 'GT', balance: 0, type: 'Bank', accNo: 'T1', branchId: 'BR-KD' }],
    });
    expect(put.status).toBe(403);
    expect(String(put.body.error || '')).toMatch(/All branches/i);
  });

  it('rejects treasury bulk replace with foreign branch accounts for non-admin', async () => {
    const fin = request.agent(app);
    const login = await fin.post('/api/session/login').send({ username: 'finance.manager', password: 'Finance@123' });
    expect(login.status).toBe(200);

    const boot = await fin.get('/api/bootstrap');
    const branches = boot.body.workspaceBranches || [];
    const workspaceBranch = boot.body.branchScope;
    const foreign = branches.find((b) => b.id !== workspaceBranch)?.id || 'BR-YL';

    const put = await fin.put('/api/treasury/accounts').send({
      reason: 'Cross-branch bulk attempt',
      accounts: [
        {
          id: 99,
          name: 'Foreign branch cash',
          bankName: 'GT',
          balance: 0,
          type: 'Bank',
          accNo: 'FRN-99',
          branchId: foreign,
        },
      ],
    });
    expect(put.status).toBe(403);
    expect(String(put.body.error || '')).toMatch(/tagged to/i);
  });

  it('posts depreciation per branch when scope is ALL', () => {
    const kd = createFixedAsset(
      db,
      {
        name: 'Kaduna plant',
        category: 'plant',
        branchId: 'BR-KD',
        acquisitionDateIso: '2026-01-01',
        costNgn: 1_000_000,
        usefulLifeMonths: 60,
      },
      { id: 'u-test' }
    );
    const yl = createFixedAsset(
      db,
      {
        name: 'Yola IT',
        category: 'it',
        branchId: 'BR-YL',
        acquisitionDateIso: '2026-01-01',
        costNgn: 500_000,
        usefulLifeMonths: 60,
      },
      { id: 'u-test' }
    );
    expect(kd.ok).toBe(true);
    expect(yl.ok).toBe(true);

    const result = postDepreciationRun(db, '2026-06', 'ALL', { id: 'u-test' }, 'BR-KD');
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.journalIds)).toBe(true);
    expect(result.journalIds.length).toBeGreaterThanOrEqual(2);

    const journals = db
      .prepare(`SELECT branch_id, source_id FROM gl_journal_entries WHERE source_kind = 'DEPRECIATION_RUN'`)
      .all();
    const branches = new Set(journals.map((j) => j.branch_id));
    expect(branches.has('BR-KD')).toBe(true);
    expect(branches.has('BR-YL')).toBe(true);
  });
});
