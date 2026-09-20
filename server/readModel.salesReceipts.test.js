import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { listSalesReceipts } from './readModel.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

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

describe.skipIf(!mysqlOk)('listSalesReceipts confirmer names', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?, ?, ?)`).run(
      'CUS-1',
      'Test Customer',
      DEFAULT_BRANCH_ID
    );
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
       VALUES (?, ?, ?, 'hash', ?, '2026-01-01T00:00:00.000Z')`
    ).run('USR-CASH-1', 'hauwa.cashier', 'Cashier', 'cashier');
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, profile_extra_json)
       VALUES (?, ?, ?)`
    ).run(
      'USR-CASH-1',
      DEFAULT_BRANCH_ID,
      JSON.stringify({ personal: { firstName: 'Hauwa', surname: 'Bello' } })
    );
    db.prepare(
      `INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, amount_display,
        status, handled_by, ledger_entry_id, branch_id,
        finance_reconciliation_saved_at_iso, finance_reconciliation_saved_by_user_id,
        bank_confirmed_at_iso, bank_confirmed_by_user_id
      ) VALUES (
        'LE-RC-1', 'CUS-1', 'Test Customer', 'QT-1', '2026-05-20', 50000, '₦50,000',
        'Cleared', 'Sales', 'LE-RC-1', ?,
        '2026-05-20T10:00:00.000Z', 'USR-CASH-1',
        '2026-05-20T10:00:00.000Z', 'USR-CASH-1'
      )`
    ).run(DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    db?.close();
  });

  it('prints the cashier person name instead of the Cashier role title', () => {
    const [row] = listSalesReceipts(db, DEFAULT_BRANCH_ID, { ids: ['LE-RC-1'], limit: 1 });
    expect(row.financeReconciliationSavedBy).toBe('Hauwa Bello');
    expect(row.bankConfirmedBy).toBe('Hauwa Bello');
  });

  it('falls back to bank confirmer when finance saved-by is blank', () => {
    db.prepare(
      `UPDATE sales_receipts SET finance_reconciliation_saved_by_user_id = NULL WHERE id = ?`
    ).run('LE-RC-1');
    const [row] = listSalesReceipts(db, DEFAULT_BRANCH_ID, { ids: ['LE-RC-1'], limit: 1 });
    expect(row.financeReconciliationSavedBy).toBe('Hauwa Bello');
    expect(row.bankConfirmedBy).toBe('Hauwa Bello');
  });
});
