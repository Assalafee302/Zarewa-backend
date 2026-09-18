import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { buildExpenseMemoFilingPackFromDb } from './expenseMemoFilingOps.js';

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

describe.skipIf(!mysqlOk)('expenseMemoFilingOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.exec(`
      INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
      VALUES
        ('EXP-FUEL-1', 'Diesel week 1', 75000, '2026-08-28', 'Fuel & lubricant', 'Pending', 'OFFICE-1', '${DEFAULT_BRANCH_ID}'),
        ('EXP-FUEL-2', 'Diesel week 2', 90000, '2026-09-10', 'Fuel & lubricant', 'Bank', 'OFFICE-2', '${DEFAULT_BRANCH_ID}'),
        ('EXP-OFF-1', 'A4 paper', 8000, '2026-09-12', 'Office expenses', 'Cash', '', '${DEFAULT_BRANCH_ID}'),
        ('EXP-PEND', 'Not yet paid', 4000, '2026-09-15', 'Office expenses', 'Pending', '', '${DEFAULT_BRANCH_ID}');
      INSERT INTO payment_requests (
        request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
        approved_by, paid_amount_ngn, paid_at_iso, paid_by, request_reference, payee_name, line_items_json
      ) VALUES
        ('PREQ-FUEL-1', 'EXP-FUEL-1', 75000, '2026-08-28', 'Paid', 'Diesel week 1',
         'Musa', 75000, '2026-09-03T10:00:00.000Z', 'Cashier A', 'OFFICE-1', 'ABC Petroleum',
         '[{"description":"Diesel","quantity":1,"unitPriceNgn":75000}]'),
        ('PREQ-FUEL-2', 'EXP-FUEL-2', 90000, '2026-09-10', 'Paid', 'Diesel week 2',
         'Musa', 90000, '2026-09-10T11:00:00.000Z', 'Cashier A', 'OFFICE-2', 'ABC Petroleum', NULL),
        ('PREQ-PEND', 'EXP-PEND', 4000, '2026-09-15', 'Pending', 'Not yet paid',
         NULL, 0, NULL, NULL, '', NULL, NULL);
    `);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('groups September paid memos by category using payout date', () => {
    const pack = buildExpenseMemoFilingPackFromDb(db, {
      month: '2026-09',
      branchScope: DEFAULT_BRANCH_ID,
      status: 'paid',
      dateBasis: 'paid',
    });
    expect(pack.ok).toBe(true);
    expect(pack.totals.count).toBe(3);
    expect(pack.groups.map((g) => g.category)).toEqual(['Fuel & lubricant', 'Office expenses']);
    const fuel = pack.groups[0];
    expect(fuel.rowCount).toBe(2);
    expect(fuel.subtotalNgn).toBe(165_000);
    expect(fuel.memos[0].expenseId).toBe('EXP-FUEL-1');
    expect(fuel.memos[0].dateISO).toBe('2026-09-03');
    expect(pack.printHints.pageBreakBeforeMemo).toBe(false);
    expect(pack.groups.some((g) => g.memos.some((m) => m.expenseId === 'EXP-PEND'))).toBe(false);
  });

  it('can print a single category folder', () => {
    const pack = buildExpenseMemoFilingPackFromDb(db, {
      month: '2026-09',
      branchScope: DEFAULT_BRANCH_ID,
      category: 'Office expenses',
    });
    expect(pack.ok).toBe(true);
    expect(pack.groups).toHaveLength(1);
    expect(pack.groups[0].category).toBe('Office expenses');
    expect(pack.printHints.pageBreakBeforeCategory).toBe(false);
  });

  it('keeps August-dated but September-paid fuel in the September pack', () => {
    const august = buildExpenseMemoFilingPackFromDb(db, {
      month: '2026-08',
      branchScope: DEFAULT_BRANCH_ID,
      dateBasis: 'paid',
    });
    expect(august.totals.count).toBe(0);

    const byExpenseDate = buildExpenseMemoFilingPackFromDb(db, {
      month: '2026-08',
      branchScope: DEFAULT_BRANCH_ID,
      dateBasis: 'expense',
    });
    expect(byExpenseDate.totals.count).toBe(1);
    expect(byExpenseDate.groups[0].memos[0].expenseId).toBe('EXP-FUEL-1');
  });
});
