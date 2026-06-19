import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  applyFinanceConfirmedReceiptBookAmountTx,
  patchSalesReceiptFinanceSettlement,
  reapplyFinanceReconciledReceiptAmountsForBranchScope,
  syncQuotationPaidFromReceipts,
} from './writeOps.js';
import { quotationPaymentCashBreakdown } from './quotationPaymentCash.js';
import { previewRefundRequest, quotationMeetsRefundEligibility } from './controlOps.js';

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

describe('finance-reconciled split-till overpay (refund cash dedupe)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-KD-26-0200', 'CUS-1', 'Test Customer', 2679600, 2679600, 'Paid', 'Pending', '{}', '2026-05-14');
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, bank_received_amount_ngn,
        finance_reconciliation_saved_at_iso, status, date_iso, ledger_entry_id
      ) VALUES (
        'LE-KD-26-0358', 'CUS-1', 'Test Customer', 'QT-KD-26-0200', 2679600, 4100000,
        '2026-05-23T19:59:03.624Z', 'Cleared', '2026-05-14', 'LE-KD-26-0358'
      );
      INSERT INTO ledger_entries (
        id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso,
        payment_method, bank_reference, note
      ) VALUES
        (
          'LE-KD-26-0358', 'RECEIPT', 'CUS-1', 'Test Customer', 'QT-KD-26-0200', 2679600,
          '2026-05-14T12:00:00.000Z', 'Bank — Zaps Aluminum Enterprises',
          'Saleh Haladu ₦4,100,000 Bank:Zaps Aluminum Enterprises',
          'Settlement to quotation balance (receipt)'
        ),
        (
          'LE-KD-26-0359', 'OVERPAY_ADVANCE', 'CUS-1', 'Test Customer', 'QT-KD-26-0200', 1420400,
          '2026-05-14T12:00:00.000Z', 'Bank — Zaps Aluminum Enterprises',
          'Saleh Haladu ₦4,100,000 Bank:Zaps Aluminum Enterprises',
          'Overpayment vs remaining balance on QT-KD-26-0200 → customer credit (refund via Sales refunds, not advance deposit)'
        );
      INSERT INTO production_jobs (job_id, quotation_ref, status)
      VALUES ('PRO-KD-26-0172', 'QT-KD-26-0200', 'Completed');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('does not double-count companion OVERPAY_ADVANCE when bank_received is reconciled', () => {
    const cash = quotationPaymentCashBreakdown(db, 'QT-KD-26-0200');
    expect(cash.receiptCashNgn).toBe(4_100_000);
    expect(cash.companionOverpayOnQuoteNgn).toBe(1_420_400);
    expect(cash.netOverpayLedgerNgn).toBe(1_420_400);
    expect(cash.cashInNgn).toBe(4_100_000);

    const meets = quotationMeetsRefundEligibility(db, 'QT-KD-26-0200');
    expect(meets.ok).toBe(true);
    expect(meets.overpaymentExcessNgn).toBe(1_420_400);
    expect(meets.remainingNgn).toBe(4_100_000);

    const prev = previewRefundRequest(db, { quotationRef: 'QT-KD-26-0200' });
    expect(prev.ok).toBe(true);
    const over = prev.preview.suggestedLines.find((l) => l.category === 'Overpayment');
    expect(over?.amountNgn).toBe(1_420_400);
    expect(prev.preview.remainingRefundableNgn).toBe(1_420_400);
  });
});

describe('finance confirm replaces mistaken sales-posted overpay', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-KD-26-0566', 'CUS-1', 'Test Customer', 1151580, 1500000, 'Paid', 'Finished', '{}', '2026-05-14');
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, ledger_entry_id
      ) VALUES (
        'LE-566', 'CUS-1', 'Test Customer', 'QT-KD-26-0566', 1500000, 'Pending clearance', '2026-05-14', 'LE-566'
      );
      INSERT INTO ledger_entries (
        id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso,
        payment_method, bank_reference, note
      ) VALUES
        (
          'LE-566', 'RECEIPT', 'CUS-1', 'Test Customer', 'QT-KD-26-0566', 1151580,
          '2026-05-14T12:00:00.000Z', 'Bank', 'REF566', 'Settlement to quotation balance (receipt)'
        ),
        (
          'LE-566-O', 'OVERPAY_ADVANCE', 'CUS-1', 'Test Customer', 'QT-KD-26-0566', 348420,
          '2026-05-14T12:00:00.000Z', 'Bank', 'REF566',
          'Overpayment vs remaining balance on QT-KD-26-0566 → customer credit'
        );
      INSERT INTO production_jobs (job_id, quotation_ref, status)
      VALUES ('PRO-566', 'QT-KD-26-0566', 'Completed');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('zeros phantom overpay when bank received is below quote total', () => {
    const settle = patchSalesReceiptFinanceSettlement(
      db,
      'LE-566',
      { bankReceivedAmountNgn: 1_150_000 },
      { id: 'USR-FIN', displayName: 'Finance', roleKey: 'finance_officer' }
    );
    expect(settle.ok).toBe(true);

    const rec = db.prepare(`SELECT amount_ngn, bank_received_amount_ngn FROM sales_receipts WHERE id = ?`).get('LE-566');
    expect(rec.amount_ngn).toBe(1_150_000);
    expect(rec.bank_received_amount_ngn).toBe(1_150_000);

    const receiptLedger = db.prepare(`SELECT amount_ngn FROM ledger_entries WHERE id = 'LE-566'`).get();
    const overpayLedger = db.prepare(`SELECT amount_ngn FROM ledger_entries WHERE id = 'LE-566-O'`).get();
    expect(receiptLedger.amount_ngn).toBe(1_150_000);
    expect(overpayLedger.amount_ngn).toBe(0);

    const qt = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = ?`).get('QT-KD-26-0566');
    expect(qt.paid_ngn).toBe(1_150_000);

    const cash = quotationPaymentCashBreakdown(db, 'QT-KD-26-0566');
    expect(cash.receiptCashNgn).toBe(1_150_000);
    expect(cash.cashInNgn).toBe(1_150_000);
    expect(cash.netOverpayLedgerNgn).toBe(0);

    const prev = previewRefundRequest(db, { quotationRef: 'QT-KD-26-0566' });
    expect(prev.ok).toBe(true);
    const over = prev.preview.suggestedLines.find((l) => l.category === 'Overpayment');
    expect(over).toBeUndefined();
    expect(prev.preview.overpaymentExcessNgn).toBe(0);
  });

  it('bulk reapply fixes already-cleared receipts with stale ledger splits', () => {
    db.prepare(
      `UPDATE sales_receipts SET
         amount_ngn = 1500000,
         bank_received_amount_ngn = 1150000,
         finance_reconciliation_saved_at_iso = '2026-06-01T10:00:00.000Z',
         status = 'Cleared'
       WHERE id = 'LE-566'`
    ).run();

    const r = reapplyFinanceReconciledReceiptAmountsForBranchScope(db, 'ALL');
    expect(r.ok).toBe(true);
    expect(r.changed).toBeGreaterThan(0);

    const overpayLedger = db.prepare(`SELECT amount_ngn FROM ledger_entries WHERE id = 'LE-566-O'`).get();
    expect(overpayLedger.amount_ngn).toBe(0);

    const rec = db.prepare(`SELECT amount_ngn FROM sales_receipts WHERE id = ?`).get('LE-566');
    expect(rec.amount_ngn).toBe(1_150_000);

    const prev = previewRefundRequest(db, { quotationRef: 'QT-KD-26-0566' });
    expect(prev.preview.overpaymentExcessNgn).toBe(0);
  });
});
