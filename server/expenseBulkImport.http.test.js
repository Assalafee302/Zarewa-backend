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
});
