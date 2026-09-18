import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { insertExpenseEntry } from '../writeOps.js';
import { commitExpenseBulkImport } from '../expenseBulkImport.js';
import {
  attachTreasuryToImportedExpense,
  attachTreasuryToImportedExpenses,
  clearExpensesForReimport,
  isExpenseUnpostedForVoid,
  listExpensesClearableForReimport,
  listExpensesMissingBankPosting,
  voidUnpostedImportedExpense,
  EXPENSE_REIMPORT_CONFIRM_PHRASE,
} from './expenseTreasuryCatchUpOps.js';

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

const ACTOR = {
  id: 'usr-expense-catchup-e2e',
  displayName: 'Catch-up E2E',
  roleKey: 'admin',
  permissions: ['*', 'finance.post', 'expenses.create'],
};

describe.skipIf(!mysqlOk)('expense treasury catch-up (imported refunds)', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let treasuryId;

  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('GTB Ops', 'GTBank', 50000000, 'Bank', 'GTB-OPS', ?, 50000000)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES (?, 'catchup.e2e', 'Catch-up E2E', 'x', 'admin', 'active', ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'`
    ).run(ACTOR.id, new Date().toISOString());
    treasuryId = Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'GTB-OPS'`).get()?.id);
    expect(treasuryId).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('voids imported refunds that never hit the bank book', () => {
    const committed = commitExpenseBulkImport(
      db,
      ACTOR,
      [
        {
          date: '2026-07-12',
          amountNgn: 45_000,
          category: 'Refund',
          reference: 'CATCHUP-VOID-1',
          description: 'Historical refund catch-up without bank',
          paymentMethod: 'Import',
          include: true,
        },
      ],
      DEFAULT_BRANCH_ID,
      { requireTreasury: false }
    );
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    const expenseID = committed.created[0].expenseID;
    expect(isExpenseUnpostedForVoid(db, expenseID)).toBe(true);

    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    const voided = voidUnpostedImportedExpense(db, expenseID, ACTOR, {
      workspaceBranchId: DEFAULT_BRANCH_ID,
    });
    expect(voided.ok, JSON.stringify(voided)).toBe(true);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(expenseID)).toBeFalsy();
    const after = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    expect(after).toBe(before);
  });

  it('posts already-imported refunds onto the bank account and deducts the balance', () => {
    const committed = commitExpenseBulkImport(
      db,
      ACTOR,
      [
        {
          date: '2026-07-14',
          amountNgn: 80_000,
          category: 'Refund',
          reference: 'CATCHUP-BANK-1',
          description: 'Historical refund catch-up missing AccountKey',
          paymentMethod: 'Import',
          include: true,
        },
      ],
      DEFAULT_BRANCH_ID,
      { requireTreasury: false }
    );
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    const expenseID = committed.created[0].expenseID;
    expect(isExpenseUnpostedForVoid(db, expenseID)).toBe(true);

    const missing = listExpensesMissingBankPosting(db, DEFAULT_BRANCH_ID, { category: 'Refund' });
    expect(missing.some((r) => r.expenseID === expenseID && r.missingTreasury)).toBe(true);

    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    const posted = attachTreasuryToImportedExpense(
      db,
      expenseID,
      { treasuryAccountId: treasuryId, workspaceBranchId: DEFAULT_BRANCH_ID },
      ACTOR
    );
    expect(posted.ok, JSON.stringify(posted)).toBe(true);
    expect(posted.alreadyOnTreasury).toBe(false);
    expect(posted.balanceAfterNgn).toBe(before - 80_000);

    const tm = db
      .prepare(
        `SELECT amount_ngn, treasury_account_id FROM treasury_movements
         WHERE source_kind = 'EXPENSE' AND source_id = ?`
      )
      .get(expenseID);
    expect(tm).toBeTruthy();
    expect(Number(tm.amount_ngn)).toBe(-80_000);
    expect(Number(tm.treasury_account_id)).toBe(treasuryId);
    expect(isExpenseUnpostedForVoid(db, expenseID)).toBe(false);

    const gl = db
      .prepare(
        `SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`
      )
      .get(posted.treasuryMovementId);
    expect(gl?.id).toBeTruthy();

    const refuseVoid = voidUnpostedImportedExpense(db, expenseID, ACTOR, {
      workspaceBranchId: DEFAULT_BRANCH_ID,
    });
    expect(refuseVoid.ok).toBe(false);
  });

  it('does not double-deduct when the expense already has a till line (GL backfill only)', () => {
    const created = insertExpenseEntry(
      db,
      {
        category: 'Refund',
        amountNgn: 12_000,
        date: '2026-07-16',
        reference: 'CATCHUP-GL-ONLY',
        expenseType: 'Refund already on till',
        paymentMethod: 'Import',
        treasuryAccountId: treasuryId,
        allowRevenue: true,
        actor: ACTOR,
        createdBy: ACTOR.displayName,
      },
      DEFAULT_BRANCH_ID
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    const again = attachTreasuryToImportedExpenses(
      db,
      [created.expenseID],
      { treasuryAccountId: treasuryId, workspaceBranchId: DEFAULT_BRANCH_ID },
      ACTOR
    );
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.posted[0].alreadyOnTreasury).toBe(true);
    const after = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    expect(after).toBe(before);
  });

  it('clears this branch’s re-importable expenses and puts bank cash back', () => {
    const unposted = commitExpenseBulkImport(
      db,
      ACTOR,
      [
        {
          date: '2026-07-17',
          amountNgn: 9_000,
          category: 'Refund',
          reference: 'CLEAR-UNPOSTED',
          description: 'Will be deleted for re-import',
          paymentMethod: 'Import',
          include: true,
        },
      ],
      DEFAULT_BRANCH_ID,
      { requireTreasury: false }
    );
    expect(unposted.ok, JSON.stringify(unposted)).toBe(true);
    const posted = insertExpenseEntry(
      db,
      {
        category: 'Refund',
        amountNgn: 30_000,
        date: '2026-07-17',
        reference: 'CLEAR-POSTED',
        expenseType: 'Imported refund with bank',
        paymentMethod: 'Import',
        treasuryAccountId: treasuryId,
        allowRevenue: true,
        actor: ACTOR,
        createdBy: ACTOR.displayName,
      },
      DEFAULT_BRANCH_ID
    );
    expect(posted.ok, JSON.stringify(posted)).toBe(true);

    const keepId = 'EXP-KEEP-PAID';
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES (?, 'Keep me', 5000, '2026-07-17', 'Office expenses', 'Pending', 'KEEP-PAID', ?)`
    ).run(keepId, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO payment_requests (
        request_id, expense_id, amount_requested_ngn, request_date, approval_status, description,
        approved_by, paid_amount_ngn, paid_at_iso, paid_by
      ) VALUES ('PREQ-KEEP-PAID', ?, 5000, '2026-07-17', 'Paid', 'Keep paid request', 'Admin', 5000, '2026-07-17T12:00:00.000Z', 'Cashier')`
    ).run(keepId);

    const before = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    const preview = listExpensesClearableForReimport(db, DEFAULT_BRANCH_ID);
    expect(preview.ok).toBe(true);
    expect(preview.skippedPaidCount).toBeGreaterThanOrEqual(1);
    expect(preview.clearableCount).toBeGreaterThanOrEqual(2);

    const blocked = clearExpensesForReimport(db, ACTOR, {
      workspaceBranchId: DEFAULT_BRANCH_ID,
      confirmPhrase: 'wrong',
    });
    expect(blocked.ok).toBe(false);

    const cleared = clearExpensesForReimport(db, ACTOR, {
      workspaceBranchId: DEFAULT_BRANCH_ID,
      confirmPhrase: EXPENSE_REIMPORT_CONFIRM_PHRASE,
    });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(cleared.clearedCount).toBeGreaterThanOrEqual(2);
    expect(cleared.restoredCashNgn).toBe(preview.restoreCashNgn);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(unposted.created[0].expenseID)).toBeFalsy();
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(posted.expenseID)).toBeFalsy();
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(keepId)).toBeTruthy();
    const after = Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryId).balance);
    expect(after).toBe(before + preview.restoreCashNgn);
  });
});
