import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { buildDebtorsRegister, refundableOverpayCreditNgnForCustomer } from './accountingSubledgerOps.js';
import { listLedgerEntries } from './readModel.js';

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

function insertTestCustomer(db, customerId = 'CUS-1') {
  db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?, 'Test Customer', ?)`).run(
    customerId,
    DEFAULT_BRANCH_ID
  );
}

describe.skipIf(!mysqlOk)('debtors overpayment via refund payables (economic cap helper)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
  });

  it('caps inflated ledger pool to economic overpayment (settled-quote duplicate)', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-A', 'CUS-1', 'Test', 564540, 564540, 'Paid', 'Finished', '{}', '2026-05-11', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('LE-A', 'CUS-1', 'Test', 'QT-A', 564540, 'Posted', '2026-05-11', '${DEFAULT_BRANCH_ID}',
        '2026-05-11T12:00:00.000Z', 580400);
      INSERT INTO ledger_entries (id, type, customer_id, quotation_ref, amount_ngn, at_iso, note, branch_id)
      VALUES
        ('LE-R', 'RECEIPT', 'CUS-1', 'QT-A', 564540, '2026-05-11T12:00:00.000Z', 'Settlement', '${DEFAULT_BRANCH_ID}'),
        ('LE-O1', 'OVERPAY_ADVANCE', 'CUS-1', 'QT-A', 15860, '2026-05-11T12:00:00.000Z', 'Overpayment vs remaining balance on QT-A → advance', '${DEFAULT_BRANCH_ID}'),
        ('LE-O2', 'OVERPAY_ADVANCE', 'CUS-1', 'QT-A', 580400, '2026-05-11T12:01:00.000Z', 'Quote QT-A already settled in records — full payment to customer advance', '${DEFAULT_BRANCH_ID}');
    `);

    const ledger = listLedgerEntries(db, DEFAULT_BRANCH_ID);
    const econ = refundableOverpayCreditNgnForCustomer(db, ledger, 'CUS-1', DEFAULT_BRANCH_ID);
    expect(econ.ledgerPoolNgn).toBe(596_260);
    expect(econ.economicExcessNgn).toBe(15_860);
    expect(econ.amountNgn).toBe(15_860);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    expect(reg.sections.some((s) => s.id === 'overpayment_credits')).toBe(false);
  });

  it('shows approved overpayment refund in refund payables section', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-OP', 'CUS-1', 'Test Customer', 500000, 600000, 'Paid', 'Finished', '{}', '2026-05-14', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-OP', 'CUS-1', 'Test Customer', 'QT-OP', 600000, 'Posted', '2026-05-14', '${DEFAULT_BRANCH_ID}',
        '2026-05-14T18:00:00.000Z', 600000);
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id
      ) VALUES (
        'RF-OP-1', 'CUS-1', 'Test Customer', 'QT-OP', '—', '["Overpayment"]',
        'Overpay refund', 100000, 100000, 0, 'Approved', 'Sales', '2026-05-14', '2026-05-15', 'BM', '${DEFAULT_BRANCH_ID}'
      );
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(section?.count).toBe(1);
    expect(section?.subtotalNgn).toBe(100_000);
  });

  it('omits customer when ledger pool exists but economic excess is zero', () => {
    insertTestCustomer(db, 'CUS-2');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-FULL', 'CUS-2', 'Paid Up', 4100000, 4100000, 'Paid', 'Finished', '{}', '2026-05-14', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-2', 'CUS-2', 'Paid Up', 'QT-FULL', 4100000, 'Posted', '2026-05-14', '${DEFAULT_BRANCH_ID}',
        '2026-05-14T18:00:00.000Z', 4100000);
      INSERT INTO ledger_entries (id, type, customer_id, quotation_ref, amount_ngn, at_iso, payment_method, bank_reference, note, branch_id)
      VALUES
        ('LE-R2', 'RECEIPT', 'CUS-2', 'QT-FULL', 2679600, '2026-05-14T12:00:00.000Z', 'Bank', 'REF2', 'Settlement', '${DEFAULT_BRANCH_ID}'),
        ('LE-O2', 'OVERPAY_ADVANCE', 'CUS-2', 'QT-FULL', 1420400, '2026-05-14T12:00:00.000Z', 'Bank', 'REF2', 'Overpayment vs remaining balance on QT-FULL → credit', '${DEFAULT_BRANCH_ID}');
    `);

    const ledger = listLedgerEntries(db, DEFAULT_BRANCH_ID);
    const econ = refundableOverpayCreditNgnForCustomer(db, ledger, 'CUS-2', DEFAULT_BRANCH_ID);
    expect(econ.ledgerPoolNgn).toBe(1_420_400);
    expect(econ.economicExcessNgn).toBe(0);
    expect(econ.amountNgn).toBe(0);
  });
});
