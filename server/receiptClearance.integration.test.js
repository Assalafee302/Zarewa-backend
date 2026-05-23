/**
 * Integration tests for receipt clearance workflow (requires MySQL — see ZAREWA_MYSQL_*).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { insertRefundRequest } from './controlOps.js';
import { patchSalesReceiptFinanceSettlement } from './writeOps.js';

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

describe.skipIf(!mysqlOk)('receipt clearance (integration)', () => {
  let app;
  let agent;
  let db;

  async function loginAs(client) {
    const res = await client.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(200);
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    db?.close();
  });

  it('posts receipt as Pending clearance until finance settles', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Clearance ${Date.now()}`,
      dateISO: '2026-05-20',
      lines: {
        products: [{ name: 'Item', qty: '1', unitPrice: '300000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationId = q.body.quotation?.id || q.body.id;

    const receipt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 150_000,
      confirmAmountNgn: 150_000,
      paymentMethod: 'Transfer',
      bankReference: `CLR-${Date.now()}`,
      dateISO: '2026-05-20',
    });
    expect(receipt.status).toBe(201);
    const receiptId = receipt.body.receipt.id;

    const row = db.prepare(`SELECT status, finance_reconciliation_saved_at_iso FROM sales_receipts WHERE id = ?`).get(
      receiptId
    );
    expect(String(row.status)).toBe('Pending clearance');
    expect(row.finance_reconciliation_saved_at_iso).toBeFalsy();

    const settle = patchSalesReceiptFinanceSettlement(
      db,
      receiptId,
      { bankReceivedAmountNgn: 150_000 },
      { id: 'USR-ADMIN', displayName: 'Admin', roleKey: 'admin' }
    );
    expect(settle.ok).toBe(true);

    const cleared = db.prepare(`SELECT status, finance_reconciliation_saved_at_iso FROM sales_receipts WHERE id = ?`).get(
      receiptId
    );
    expect(String(cleared.status)).toBe('Cleared');
    expect(String(cleared.finance_reconciliation_saved_at_iso || '').trim()).not.toBe('');
  });

  it('rejects amendSalesReceiptId re-post', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Amend ${Date.now()}`,
      dateISO: '2026-05-20',
      lines: {
        products: [{ name: 'Item', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      },
    });
    const quotationId = q.body.quotation?.id || q.body.id;
    const receipt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 50_000,
      paymentMethod: 'Cash',
      bankReference: 'AMEND-1',
      dateISO: '2026-05-20',
    });
    const amend = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 50_000,
      paymentMethod: 'Cash',
      bankReference: 'AMEND-2',
      dateISO: '2026-05-20',
      amendSalesReceiptId: receipt.body.receipt.id,
    });
    expect(amend.status).toBe(400);
    expect(amend.body.code).toBe('RECEIPT_AMEND_NOT_ALLOWED');
  });

  it('requires confirmAmountNgn for posts >= 100k', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Confirm ${Date.now()}`,
      dateISO: '2026-05-20',
      lines: {
        products: [{ name: 'Item', qty: '1', unitPrice: '500000' }],
        accessories: [],
        services: [],
      },
    });
    const quotationId = q.body.quotation?.id || q.body.id;
    const bad = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 148_000,
      paymentMethod: 'Transfer',
      bankReference: 'NO-CONFIRM',
      dateISO: '2026-05-20',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('RECEIPT_AMOUNT_CONFIRM_REQUIRED');

    const ok = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 148_000,
      confirmAmountNgn: 148_000,
      paymentMethod: 'Transfer',
      bankReference: 'WITH-CONFIRM',
      dateISO: '2026-05-20',
    });
    expect(ok.status).toBe(201);
  });

  it('blocks refund while receipts are uncleared', () => {
    const quotationId = 'QT-CLR-REFUND-001';
    const lines = JSON.stringify({
      products: [{ name: 'Item', qty: '1', unitPrice: '200000' }],
      accessories: [],
      services: [],
    });
    db.prepare(
      `INSERT OR REPLACE INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(quotationId, 'CUS-002', 'Test Customer', 200_000, 100_000, 'Partial', 'Finished', lines);
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES (?,?,?,?,?,?,?)`
    ).run('LE-CLR-UNCLEARED', 'CUS-002', 'Test Customer', quotationId, 100_000, 'Pending clearance', '2026-05-20');
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (job_id, quotation_ref, actual_meters, status, created_at_iso)
       VALUES (?,?,?,?,?)`
    ).run('JOB-CLR-CANCEL', quotationId, 0, 'Cancelled', '2026-05-20T10:00:00.000Z');

    const refund = insertRefundRequest(
      db,
      {
        customerID: 'CUS-002',
        quotationRef: quotationId,
        amountNgn: 10_000,
        reasonCategory: ['Order cancellation'],
        payeeName: 'Test Payee',
        payeeAccountNo: '1234567890',
        payeeBankName: 'Test Bank',
        calculationLines: [{ category: 'Order cancellation', label: 'Test', amountNgn: 10_000, include: true }],
      },
      { id: 'USR-ADMIN', displayName: 'Admin', roleKey: 'admin' }
    );
    expect(refund.ok).toBe(false);
    expect(refund.code).toBe('RECEIPT_CLEARANCE_REQUIRED');
  });
});
