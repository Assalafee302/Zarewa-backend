import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { applyAdminDataReset, ADMIN_DATA_RESET_CONFIRM_PHRASE } from './adminDataResetOps.js';
import { ensureHumanIdSequencesTable } from './humanId.js';

describe('admin data reset branch scope', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('rejects reset without a single branch workspace', () => {
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'ALL',
    });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/one branch/i);
  });

  it('rejects reset when workspace view-all is set', () => {
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
      workspaceViewAll: true,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/all branches/i);
  });

  it('clears human_id_sequences only for the target branch code', () => {
    ensureHumanIdSequencesTable(db);
    db.prepare(`INSERT INTO human_id_sequences (scope, \`last_value\`) VALUES (?, 5), (?, 3)`).run(
      'QT|YL|2026',
      'QT|MDG|2026'
    );
    const r = applyAdminDataReset(db, ['document_sequences'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT scope FROM human_id_sequences`).all().map((x) => x.scope)).toEqual(['QT|MDG|2026']);
  });

  it('deletes customers only for the selected branch', () => {
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id, status, tier, payment_terms)
       VALUES ('C-YL', 'Yola Co', 'BR-YL', 'Active', 'Standard', 'Cash'),
              ('C-MDG', 'Maiduguri Co', 'BR-MDG', 'Active', 'Standard', 'Cash')`
    ).run();
    const r = applyAdminDataReset(db, ['operations_core'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT customer_id FROM customers ORDER BY customer_id`).all().map((x) => x.customer_id)).toEqual([
      'C-MDG',
    ]);
  });

  it('expenses_ap deletes this branch’s expenses, unscoped rows, and linked payment requests', () => {
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-YL-1', 'Fuel', 5000, '2026-09-01', 'Others', 'Cash', 'yl-1', 'BR-YL'),
              ('EXP-BLANK', 'Fuel', 1000, '2026-09-01', 'Others', 'Cash', 'blank', ''),
              ('EXP-MDG-1', 'Fuel', 8000, '2026-09-01', 'Others', 'Cash', 'mdg-1', 'BR-MDG')`
    ).run();
    db.prepare(
      `INSERT INTO payment_requests (request_id, expense_id, amount_requested_ngn, request_date, approval_status, description)
       VALUES ('PR-YL-1', 'EXP-YL-1', 5000, '2026-09-01', 'approved', 'Yola fuel'),
              ('PR-MDG-1', 'EXP-MDG-1', 8000, '2026-09-01', 'approved', 'Maiduguri fuel')`
    ).run();

    const r = applyAdminDataReset(db, ['expenses_ap'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBeFalsy();
    const expenseIds = db.prepare(`SELECT expense_id FROM expenses ORDER BY expense_id`).all().map((x) => x.expense_id);
    expect(expenseIds).toEqual(['EXP-MDG-1']);
    const prIds = db.prepare(`SELECT request_id FROM payment_requests ORDER BY request_id`).all().map((x) => x.request_id);
    expect(prIds).toEqual(['PR-MDG-1']);
  });

  it('expenses_ap restores till cash and removes expense treasury/GL lines', () => {
    const acc = db
      .prepare(
        `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id)
         VALUES ('Yola till', 'Cash', 25000, 'cash', 'CASH-YL', 'BR-YL')`
      )
      .run();
    const accountId = Number(acc.lastInsertRowid);
    expect(accountId).toBeGreaterThan(0);
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-YL-CASH', 'Diesel', 15000, '2026-09-02', 'Others', 'Cash', 'diesel', 'BR-YL')`
    ).run();
    db.prepare(
      `INSERT INTO treasury_movements (
         id, posted_at_iso, type, treasury_account_id, amount_ngn, source_kind, source_id
       ) VALUES ('TM-EXP-1', '2026-09-02T10:00:00.000Z', 'EXPENSE', ?, -15000, 'EXPENSE', 'EXP-YL-CASH')`
    ).run(accountId);
    db.prepare(
      `INSERT INTO gl_journal_entries (id, entry_date_iso, period_key, memo, source_kind, source_id, created_at_iso, branch_id)
       VALUES ('GJ-EXP-1', '2026-09-02', '2026-09', 'Expense payment', 'EXPENSE_PAYMENT_GL', 'TM-EXP-1', '2026-09-02T10:00:00.000Z', 'BR-YL')`
    ).run();
    const glAccount = db.prepare(`SELECT id FROM gl_accounts LIMIT 1`).get();
    if (glAccount?.id) {
      db.prepare(
        `INSERT INTO gl_journal_lines (id, journal_id, account_id, debit_ngn, credit_ngn)
         VALUES ('GJL-EXP-1', 'GJ-EXP-1', ?, 15000, 0)`
      ).run(glAccount.id);
    }

    const r = applyAdminDataReset(db, ['expenses_ap'], ADMIN_DATA_RESET_CONFIRM_PHRASE, {
      branchId: 'BR-YL',
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = 'EXP-YL-CASH'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT id FROM treasury_movements WHERE id = 'TM-EXP-1'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT id FROM gl_journal_entries WHERE id = 'GJ-EXP-1'`).get()).toBeFalsy();
    const till = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(accountId);
    expect(Number(till?.balance)).toBe(40000);
  });
});
