import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  applyFinanceConfirmedReceiptBookAmountTx,
  patchSalesReceiptFinanceSettlement,
  syncQuotationPaidFromReceipts,
} from './writeOps.js';
import { quotationPaymentCashBreakdown } from './quotationPaymentCash.js';

describe('receipt finance settlement aligns paid amount', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-146', 'CUS-1', 'Test Customer', 800000, 415350, 'Partial', 'Finished', '{}', '2026-05-20');
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id
      ) VALUES (
        'LE-261', 'CUS-1', 'Test Customer', 'QT-146', 415350, '₦415,350', 'Pending clearance', '2026-05-20', 'LE-261'
      );
      INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, payment_method)
      VALUES ('LE-261', 'RECEIPT', 'CUS-1', 'Test Customer', 'QT-146', 415350, '2026-05-20T12:00:00.000Z', 'Transfer');
      INSERT INTO treasury_accounts (id, name, account_type, balance_ngn, branch_id)
      VALUES (1, 'Taj Bank', 'bank', 0, 'BR-001');
      INSERT INTO treasury_movements (
        id, type, source_kind, source_id, treasury_account_id, amount_ngn, posted_at_iso, counterparty_kind
      ) VALUES (
        'TM-261', 'RECEIPT_IN', 'LEDGER_RECEIPT', 'LE-261', 1, 415350, '2026-05-20T12:00:00.000Z', 'CUSTOMER'
      );
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('finance confirm updates receipt, ledger, treasury, and quotation paid_ngn', () => {
    const settle = patchSalesReceiptFinanceSettlement(
      db,
      'LE-261',
      { bankReceivedAmountNgn: 620_000 },
      { id: 'USR-FIN', displayName: 'Finance', roleKey: 'finance_officer' }
    );
    expect(settle.ok).toBe(true);

    const rec = db.prepare(`SELECT amount_ngn, bank_received_amount_ngn, status FROM sales_receipts WHERE id = ?`).get(
      'LE-261'
    );
    expect(rec.amount_ngn).toBe(620_000);
    expect(rec.bank_received_amount_ngn).toBe(620_000);
    expect(String(rec.status)).toBe('Cleared');

    const led = db.prepare(`SELECT amount_ngn FROM ledger_entries WHERE id = ?`).get('LE-261');
    expect(led.amount_ngn).toBe(620_000);

    const treas = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements
         WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = 'LE-261'`
      )
      .get();
    expect(treas.s).toBe(620_000);

    const qt = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get('QT-146');
    expect(qt.paid_ngn).toBe(620_000);

    const cash = quotationPaymentCashBreakdown(db, 'QT-146');
    expect(cash.receiptCashNgn).toBe(620_000);
    expect(cash.cashInNgn).toBe(620_000);
  });

  it('syncQuotationPaidFromReceipts uses bank_received for already-reconciled receipts', () => {
    db.prepare(
      `UPDATE sales_receipts SET
         amount_ngn = 415350,
         bank_received_amount_ngn = 620000,
         finance_reconciliation_saved_at_iso = '2026-05-21T10:00:00.000Z',
         status = 'Cleared'
       WHERE id = 'LE-261'`
    ).run();
    syncQuotationPaidFromReceipts(db, 'QT-146');
    const qt = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get('QT-146');
    expect(qt.paid_ngn).toBe(620_000);

    const cash = quotationPaymentCashBreakdown(db, 'QT-146');
    expect(cash.cashInNgn).toBe(620_000);
  });

  it('applyFinanceConfirmedReceiptBookAmountTx is idempotent when already aligned', () => {
    applyFinanceConfirmedReceiptBookAmountTx(db, 'LE-261', 620_000, null);
    const first = db.prepare(`SELECT amount_ngn FROM sales_receipts WHERE id = ?`).get('LE-261');
    const again = applyFinanceConfirmedReceiptBookAmountTx(db, 'LE-261', 620_000, null);
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    const second = db.prepare(`SELECT amount_ngn FROM sales_receipts WHERE id = ?`).get('LE-261');
    expect(second.amount_ngn).toBe(first.amount_ngn);
  });
});
