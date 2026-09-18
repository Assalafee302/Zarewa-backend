import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

const openDbs = [];

function makeApp() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  return { app: createApp(db), db };
}

describe('expense bulk import HTTP (MySQL)', () => {
  afterAll(() => {
    for (const db of openDbs) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    openDbs.length = 0;
  });

  it('template → preview → commit keeps July dates through the HTTP API', async () => {
    const { app, db } = makeApp();
    const agent = request.agent(app);

    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const workspace = await agent
      .patch('/api/session/workspace')
      .send({ currentBranchId: DEFAULT_BRANCH_ID, viewAllBranches: false });
    expect(workspace.status).toBe(200);
    expect(workspace.body.viewAllBranches).toBe(false);

    const blockedAllBranches = await agent.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(blockedAllBranches.status).toBe(200);
    const blockedPreview = await agent.post('/api/expenses/import/preview').send({
      rows: [{ date: '2026-07-10', amountNgn: 1000, category: 'Office expenses', include: true }],
    });
    expect(blockedPreview.status).toBe(403);

    await agent.patch('/api/session/workspace').send({ currentBranchId: DEFAULT_BRANCH_ID, viewAllBranches: false });

    const template = await agent.get('/api/expenses/import/template').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(template.status).toBe(200);
    expect(String(template.headers['content-type'] || '')).toMatch(/spreadsheetml|octet-stream/i);
    expect(Buffer.isBuffer(template.body)).toBe(true);
    expect(template.body.length).toBeGreaterThan(100);

    const cats = await agent.get('/api/expenses/import/categories');
    expect(cats.status).toBe(200);
    expect(cats.body.categories.length).toBeGreaterThan(0);

    const boot = await agent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const treasury =
      (boot.body.treasuryAccounts || []).find(
        (a) => String(a.branchId || a.branch_id || '') === DEFAULT_BRANCH_ID
      ) || boot.body.treasuryAccounts?.[0];
    expect(treasury?.id).toBeTruthy();
    // Guarantee float so the smoke is not flaky against seeded balances.
    db.prepare(`UPDATE treasury_accounts SET balance = GREATEST(COALESCE(balance, 0), ?) WHERE id = ?`).run(
      5_000_000,
      treasury.id
    );

    const preview = await agent.post('/api/expenses/import/preview').send({
      rows: [
        {
          date: '15/07/2026',
          amountNgn: 18_500,
          category: 'Fuel & lubricant',
          treasuryAccountId: treasury.id,
          reference: 'HTTP-JUL-1',
          description: 'HTTP July catch-up',
          paymentMethod: 'Cash',
          include: true,
        },
        {
          date: '',
          amountNgn: 4_000,
          category: 'Office expenses',
          treasuryAccountId: treasury.id,
          include: true,
        },
      ],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.previewTable[0].date).toBe('2026-07-15');
    expect(preview.body.previewTable[0].status).toBe('ok');
    expect(preview.body.previewTable[1].status).toBe('incomplete');

    const today = new Date().toISOString().slice(0, 10);
    const commit = await agent.post('/api/expenses/import/commit').send({
      rows: [
        {
          date: '2026-07-22',
          amountNgn: 27_750,
          category: 'Maintenance',
          treasuryAccountId: treasury.id,
          reference: 'HTTP-JUL-MAINT',
          description: 'HTTP July maintenance',
          paymentMethod: 'Transfer',
          include: true,
        },
      ],
    });
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);
    expect(commit.body.ok).toBe(true);
    expect(commit.body.createdCount).toBe(1);
    expect(commit.body.created[0].date).toBe('2026-07-22');
    expect(commit.body.created[0].date).not.toBe(today);
    expect(commit.body.created[0].expenseID).toBeTruthy();

    const expenseId = commit.body.created[0].expenseID;
    const row = db.prepare(`SELECT date, amount_ngn, category FROM expenses WHERE expense_id = ?`).get(expenseId);
    expect(row).toBeTruthy();
    expect(row.date).toBe('2026-07-22');
    expect(Number(row.amount_ngn)).toBe(27_750);

    const tm = db
      .prepare(`SELECT amount_ngn FROM treasury_movements WHERE source_kind = 'EXPENSE' AND source_id = ?`)
      .get(expenseId);
    expect(tm).toBeTruthy();
    expect(Number(tm.amount_ngn)).toBe(-27_750);

    const blankReject = await agent.post('/api/expenses/import/commit').send({
      rows: [
        {
          date: '',
          amountNgn: 1_000,
          category: 'Office expenses',
          treasuryAccountId: treasury.id,
          include: true,
        },
      ],
    });
    expect(blankReject.status).toBe(400);
    expect(blankReject.body.ok).toBe(false);
  }, 120_000);

  it('voids unposted imported expenses and can attach the rest to a bank account', async () => {
    const { app, db } = makeApp();
    const agent = request.agent(app);

    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);
    await agent.patch('/api/session/workspace').send({ currentBranchId: DEFAULT_BRANCH_ID, viewAllBranches: false });

    const boot = await agent.get('/api/bootstrap');
    const treasury =
      (boot.body.treasuryAccounts || []).find(
        (a) => String(a.branchId || a.branch_id || '') === DEFAULT_BRANCH_ID
      ) || boot.body.treasuryAccounts?.[0];
    db.prepare(`UPDATE treasury_accounts SET balance = GREATEST(COALESCE(balance, 0), ?) WHERE id = ?`).run(
      5_000_000,
      treasury.id
    );

    const autoTill = await agent.post('/api/expenses/import/commit').send({
      rows: [
        {
          date: '2026-07-11',
          amountNgn: 15_000,
          category: 'Refund',
          reference: 'HTTP-VOID-BLOCK',
          description: 'Should post to the branch cash till even without AccountKey',
          include: true,
        },
      ],
    });
    expect(autoTill.status, JSON.stringify(autoTill.body)).toBe(201);
    expect(autoTill.body.createdCount).toBe(1);
    expect(autoTill.body.created[0].treasuryAccountId).toBeTruthy();

    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES
         ('EXP-HTTP-VOID-1', 'Imported refund without bank account', 15000, '2026-07-11', 'Refund', 'Import', 'HTTP-VOID-1', ?),
         ('EXP-HTTP-BANK-1', 'Imported refund to attach later', 22000, '2026-07-11', 'Refund', 'Import', 'HTTP-BANK-1', ?)`
    ).run(DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID);

    const unposted = await agent.get('/api/expenses/import/unposted?category=Refund');
    expect(unposted.status).toBe(200);
    expect(unposted.body.rows.some((r) => r.expenseID === 'EXP-HTTP-VOID-1' && r.missingTreasury)).toBe(true);

    const voided = await agent.post('/api/expenses/import/void-unposted').send({ expenseIds: ['EXP-HTTP-VOID-1'] });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.voidedCount).toBe(1);

    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasury.id).balance);
    const attached = await agent.post('/api/expenses/import/attach-treasury').send({
      expenseIds: ['EXP-HTTP-BANK-1'],
      treasuryAccountId: treasury.id,
    });
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    expect(attached.body.postedCount).toBe(1);
    const after = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasury.id).balance);
    expect(after).toBe(before - 22_000);
  }, 120_000);

  it('lets finance delete unposted imports and re-upload onto the cash till without AccountKey', async () => {
    const { app, db } = makeApp();
    const agent = request.agent(app);

    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);
    await agent.patch('/api/session/workspace').send({ currentBranchId: DEFAULT_BRANCH_ID, viewAllBranches: false });

    await agent.get('/api/bootstrap');

    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES
         ('EXP-REIMPORT-A', 'Old memo refund', 11000, '2026-07-08', 'Refund', 'Import', 'OLD-A', ?),
         ('EXP-REIMPORT-B', 'Old memo refund', 19000, '2026-07-08', 'Refund', 'Import', 'OLD-B', ?)`
    ).run(DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID);

    const wiped = await agent.post('/api/expenses/import/void-unposted').send({ allUnposted: true });
    expect(wiped.status, JSON.stringify(wiped.body)).toBe(200);
    expect(wiped.body.voidedCount).toBeGreaterThanOrEqual(2);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = 'EXP-REIMPORT-A'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = 'EXP-REIMPORT-B'`).get()).toBeFalsy();

    const previewPaid = await agent.post('/api/expenses/import/preview').send({
      rows: [
        {
          date: '2026-07-08',
          amountNgn: 11_000,
          category: 'Refund',
          reference: 'NEW-A',
          description: 'Re-imported refund that must hit cashier statement',
          include: true,
        },
      ],
    });
    expect(previewPaid.status, JSON.stringify(previewPaid.body)).toBe(200);
    const paidFromId = Number(previewPaid.body.paidFromAccountId);
    expect(paidFromId).toBeGreaterThan(0);
    db.prepare(`UPDATE treasury_accounts SET balance = GREATEST(COALESCE(balance, 0), ?) WHERE id = ?`).run(
      5_000_000,
      paidFromId
    );

    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(paidFromId).balance);
    const commit = await agent.post('/api/expenses/import/commit').send({
      rows: [
        {
          date: '2026-07-08',
          amountNgn: 11_000,
          category: 'Refund',
          reference: 'NEW-A',
          description: 'Re-imported refund that must hit cashier statement',
          include: true,
        },
        {
          date: '2026-07-08',
          amountNgn: 19_000,
          category: 'Refund',
          reference: 'NEW-B',
          description: 'Re-imported refund that must hit cashier statement',
          include: true,
        },
      ],
    });
    expect(commit.status, JSON.stringify(commit.body)).toBe(201);
    expect(commit.body.createdCount).toBe(2);
    expect(Number(commit.body.created[0].treasuryAccountId)).toBe(paidFromId);
    expect(Number(commit.body.created[1].treasuryAccountId)).toBe(paidFromId);
    expect(commit.body.delta?.treasuryAccounts?.some((a) => Number(a.id) === paidFromId)).toBe(true);
    expect(Array.isArray(commit.body.delta?.treasuryMovements)).toBe(true);
    expect(commit.body.delta.treasuryMovements.length).toBe(2);

    const after = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(paidFromId).balance);
    expect(after).toBe(before - 30_000);

    for (const row of commit.body.created) {
      const tm = db
        .prepare(
          `SELECT amount_ngn, treasury_account_id FROM treasury_movements
           WHERE source_kind = 'EXPENSE' AND source_id = ?`
        )
        .get(row.expenseID);
      expect(tm).toBeTruthy();
      expect(Number(tm.amount_ngn)).toBe(-row.amountNgn);
      expect(Number(tm.treasury_account_id)).toBe(paidFromId);
    }
  }, 120_000);
});
