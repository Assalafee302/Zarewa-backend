import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { listManagementItems } from './readModel.js';
import { insertLedgerRows, reopenQuotationManagerClearanceAfterReceipt } from './writeOps.js';

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

describe.skipIf(!mysqlOk)('receipt on a manager-cleared quotation', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-REOPEN', 'Reopen Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status,
        lines_json, date_iso, manager_cleared_at_iso, branch_id
      ) VALUES (
        'QT-REOPEN', 'CUS-REOPEN', 'Reopen Customer', 100000, 40000, 'Partial', 'Pending',
        '{}', '2099-01-01', '2026-05-01T00:00:00.000Z', '${DEFAULT_BRANCH_ID}'
      );
    `);
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const receiptRow = {
    type: 'RECEIPT',
    customerID: 'CUS-REOPEN',
    customerName: 'Reopen Customer',
    amountNgn: 10000,
    quotationRef: 'QT-REOPEN',
    paymentMethod: 'Cash',
    bankReference: 'RCPT-REOPEN',
    note: 'extra receipt after clearance',
    atISO: '2026-09-29T12:00:00.000Z',
  };

  it('allows the receipt and returns the quotation to the clearance queue', () => {
    expect(() => insertLedgerRows(db, [receiptRow], DEFAULT_BRANCH_ID)).toThrow(/cleared by manager/i);

    const saved = insertLedgerRows(db, [receiptRow], DEFAULT_BRANCH_ID, {
      allowManagerClearedQuotationRefs: ['QT-REOPEN'],
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe('RECEIPT');

    const opened = reopenQuotationManagerClearanceAfterReceipt(db, 'QT-REOPEN');
    expect(opened.reopened).toBe(true);
    const row = db.prepare(`SELECT manager_cleared_at_iso FROM quotations WHERE id = ?`).get('QT-REOPEN');
    expect(row.manager_cleared_at_iso).toBeNull();

    const queue = listManagementItems(db, 'ALL');
    expect(queue.pendingClearance.some((q) => q.id === 'QT-REOPEN')).toBe(true);

    expect(reopenQuotationManagerClearanceAfterReceipt(db, 'QT-REOPEN').reopened).toBe(false);
  });

  it('still blocks a receipt when the quotation is flagged', () => {
    db.prepare(
      `UPDATE quotations SET manager_flagged_at_iso = ?, manager_cleared_at_iso = NULL, manager_flag_reason = ? WHERE id = ?`
    ).run('2026-05-02T00:00:00.000Z', 'audit', 'QT-REOPEN');

    expect(() =>
      insertLedgerRows(db, [{ ...receiptRow, bankReference: 'RCPT-FLAG' }], DEFAULT_BRANCH_ID, {
        allowManagerClearedQuotationRefs: ['QT-REOPEN'],
      })
    ).toThrow(/flagged by manager/i);
    expect(reopenQuotationManagerClearanceAfterReceipt(db, 'QT-REOPEN').reopened).toBe(false);
  });

  it('POST /api/ledger/receipt accepts a cleared quotation and returns it to clearance', async () => {
    db.prepare(
      `UPDATE quotations
       SET manager_cleared_at_iso = ?, manager_flagged_at_iso = NULL, manager_flag_reason = NULL, paid_ngn = 40000
       WHERE id = ?`
    ).run('2026-05-01T00:00:00.000Z', 'QT-REOPEN');

    const treasury = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    expect(treasury?.id).toBeTruthy();

    const app = createApp(db);
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const res = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-REOPEN',
      quotationId: 'QT-REOPEN',
      amountNgn: 15_000,
      paymentMethod: 'Cash',
      bankReference: 'RCPT-API-REOPEN',
      dateISO: '2026-09-29',
      paymentLines: [{ treasuryAccountId: treasury.id, amountNgn: 15_000, reference: 'RCPT-API-REOPEN' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.managerClearanceReopened).toBe(true);
    expect(res.body.receipt?.amountNgn).toBe(15_000);

    const row = db.prepare(`SELECT manager_cleared_at_iso, paid_ngn FROM quotations WHERE id = ?`).get('QT-REOPEN');
    expect(row.manager_cleared_at_iso).toBeNull();
    expect(Number(row.paid_ngn)).toBeGreaterThanOrEqual(15_000);

    const queue = listManagementItems(db, 'ALL');
    expect(queue.pendingClearance.some((q) => q.id === 'QT-REOPEN')).toBe(true);
  });

  it('POST /api/ledger/receipt on a cleared quote uses the quotation customer even if the body has another customer', async () => {
    db.prepare(
      `UPDATE quotations
       SET manager_cleared_at_iso = ?, manager_flagged_at_iso = NULL, manager_flag_reason = NULL, paid_ngn = 40000
       WHERE id = ?`
    ).run('2026-05-01T00:00:00.000Z', 'QT-REOPEN');

    const treasury = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    expect(treasury?.id).toBeTruthy();

    const app = createApp(db);
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const res = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-001',
      quotationId: 'QT-REOPEN',
      amountNgn: 8_000,
      paymentMethod: 'Cash',
      bankReference: 'RCPT-CLEARED-CUSTOMER',
      dateISO: '2026-09-29',
      paymentLines: [{ treasuryAccountId: treasury.id, amountNgn: 8_000, reference: 'RCPT-CLEARED-CUSTOMER' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.managerClearanceReopened).toBe(true);
    expect(res.body.receipt?.customerID).toBe('CUS-REOPEN');

    const row = db.prepare(`SELECT manager_cleared_at_iso, customer_id FROM quotations WHERE id = ?`).get('QT-REOPEN');
    expect(row.manager_cleared_at_iso).toBeNull();
    expect(row.customer_id).toBe('CUS-REOPEN');
  });
});
