import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { patchSalesReceiptFinanceSettlement } from '../writeOps.js';
import {
  bulkUnconfirmSalesReceiptsFinanceClearance,
  previewBulkUnconfirmSalesReceipts,
} from './receiptBulkUnconfirmOps.js';
import {
  RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
  resolveBulkUnconfirmDateRange,
  lastDayOfYearMonth,
} from '../../shared/lib/receiptClearance.js';

const ACTOR = { id: 'USR-FIN', displayName: 'Finance', roleKey: 'finance_officer' };

function mysqlAvailable() {
  // Local Vitest without MySQL: skip DB integration (same gate as other finance ops tests).
  if (!String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim()) return false;
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe('resolveBulkUnconfirmDateRange', () => {
  it('expands yearMonth to calendar month bounds', () => {
    expect(lastDayOfYearMonth('2026-05')).toBe('2026-05-31');
    const r = resolveBulkUnconfirmDateRange({ yearMonth: '2026-05' });
    expect(r).toEqual({
      ok: true,
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      yearMonth: '2026-05',
    });
  });

  it('rejects overly long ranges', () => {
    const r = resolveBulkUnconfirmDateRange({ dateFrom: '2026-01-01', dateTo: '2026-06-01' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DATE_RANGE_TOO_LONG');
  });
});

describe.skipIf(!mysqlOk)('bulkUnconfirmSalesReceiptsFinanceClearance', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-1', 'Test Customer', 'BR-001');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-MAY', 'CUS-1', 'Test Customer', 100000, 0, 'Unpaid', 'Finished', '{}', '2026-05-10', 'BR-001'),
        ('QT-JUN', 'CUS-1', 'Test Customer', 80000, 0, 'Unpaid', 'Finished', '{}', '2026-06-10', 'BR-001');
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id, branch_id
      ) VALUES
        ('LE-MAY', 'CUS-1', 'Test Customer', 'QT-MAY', 100000, '₦100,000', 'Pending clearance', '2026-05-10', 'LE-MAY', 'BR-001'),
        ('LE-JUN', 'CUS-1', 'Test Customer', 'QT-JUN', 80000, '₦80,000', 'Pending clearance', '2026-06-10', 'LE-JUN', 'BR-001');
      INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, payment_method)
      VALUES
        ('LE-MAY', 'RECEIPT', 'CUS-1', 'Test Customer', 'QT-MAY', 100000, '2026-05-10T12:00:00.000Z', 'Transfer'),
        ('LE-JUN', 'RECEIPT', 'CUS-1', 'Test Customer', 'QT-JUN', 80000, '2026-06-10T12:00:00.000Z', 'Transfer');
      INSERT INTO treasury_accounts (id, name, account_type, balance_ngn, branch_id)
      VALUES (1, 'Taj Bank', 'bank', 0, 'BR-001');
      INSERT INTO treasury_movements (
        id, type, source_kind, source_id, treasury_account_id, amount_ngn, posted_at_iso, counterparty_kind
      ) VALUES
        ('TM-MAY', 'RECEIPT_IN', 'LEDGER_RECEIPT', 'LE-MAY', 1, 100000, '2026-05-10T12:00:00.000Z', 'CUSTOMER'),
        ('TM-JUN', 'RECEIPT_IN', 'LEDGER_RECEIPT', 'LE-JUN', 1, 80000, '2026-06-10T12:00:00.000Z', 'CUSTOMER');
    `);

    expect(patchSalesReceiptFinanceSettlement(db, 'LE-MAY', { bankReceivedAmountNgn: 100000 }, ACTOR).ok).toBe(
      true
    );
    expect(patchSalesReceiptFinanceSettlement(db, 'LE-JUN', { bankReceivedAmountNgn: 80000 }, ACTOR).ok).toBe(
      true
    );
  });

  afterEach(() => {
    db?.close();
  });

  it('previews only confirmed receipts in the selected month', () => {
    const preview = previewBulkUnconfirmSalesReceipts(db, 'BR-001', { yearMonth: '2026-05' });
    expect(preview.ok).toBe(true);
    expect(preview.count).toBe(1);
    expect(preview.sampleIds).toEqual(['LE-MAY']);
    expect(preview.dateFrom).toBe('2026-05-01');
    expect(preview.dateTo).toBe('2026-05-31');
  });

  it('requires the confirm phrase and reason', () => {
    const missing = bulkUnconfirmSalesReceiptsFinanceClearance(db, 'BR-001', ACTOR, {
      yearMonth: '2026-05',
      reason: 'Reconfirm May',
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('CONFIRM_PHRASE_REQUIRED');

    const noReason = bulkUnconfirmSalesReceiptsFinanceClearance(db, 'BR-001', ACTOR, {
      yearMonth: '2026-05',
      confirmPhrase: RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
      reason: 'ab',
    });
    expect(noReason.ok).toBe(false);
    expect(noReason.code).toBe('REASON_REQUIRED');
  });

  it('unconfirms only the selected month so receipts can be reconfirmed', () => {
    const r = bulkUnconfirmSalesReceiptsFinanceClearance(db, 'BR-001', ACTOR, {
      yearMonth: '2026-05',
      confirmPhrase: RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
      reason: 'Reconfirm all May receipts for branch audit',
    });
    expect(r.ok).toBe(true);
    expect(r.unconfirmedCount).toBe(1);
    expect(r.failedCount).toBe(0);

    const may = db
      .prepare(
        `SELECT status, finance_reconciliation_saved_at_iso, bank_received_amount_ngn FROM sales_receipts WHERE id = ?`
      )
      .get('LE-MAY');
    expect(String(may.status)).toBe('Pending clearance');
    expect(may.finance_reconciliation_saved_at_iso).toBeFalsy();
    expect(may.bank_received_amount_ngn).toBeNull();

    const jun = db
      .prepare(`SELECT status, finance_reconciliation_saved_at_iso FROM sales_receipts WHERE id = ?`)
      .get('LE-JUN');
    expect(String(jun.status)).toBe('Cleared');
    expect(jun.finance_reconciliation_saved_at_iso).toBeTruthy();

    const tmMay = db
      .prepare(`SELECT finance_confirmed_at_iso FROM treasury_movements WHERE id = 'TM-MAY'`)
      .get();
    expect(tmMay.finance_confirmed_at_iso).toBeFalsy();
  });
});
