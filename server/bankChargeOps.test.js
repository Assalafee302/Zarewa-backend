import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { recordBankCharge, BANK_CHARGES_CATEGORY } from './bankChargeOps.js';
import { ensureGlSchema, seedDefaultGlAccounts } from './glOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

describe('recordBankCharge', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    ensureGlSchema(db);
    seedDefaultGlAccounts(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('debits treasury, records Bank charges expense, and posts GL 6170', () => {
    const account = db.prepare(`SELECT id, balance FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    expect(account?.id).toBeTruthy();
    const beforeBalance = Math.round(Number(account.balance) || 0);

    const actor = { id: 'USR-CASH', displayName: 'Cashier', roleKey: 'cashier', permissions: ['finance.pay'] };
    const r = recordBankCharge(
      db,
      {
        treasuryAccountId: account.id,
        amountNgn: 2_150,
        dateISO: '2026-08-13',
        description: 'COT / turnover charge',
        reference: 'STMT-COT-0813',
        actor,
        createdBy: 'Cashier',
      },
      DEFAULT_BRANCH_ID
    );
    expect(r.ok).toBe(true);
    expect(r.expenseID).toMatch(/^EXP/);
    expect(r.treasuryMovementId).toBeTruthy();
    expect(r.amountNgn).toBe(2_150);

    const expense = db.prepare(`SELECT * FROM expenses WHERE expense_id = ?`).get(r.expenseID);
    expect(expense.category).toBe(BANK_CHARGES_CATEGORY);
    expect(expense.amount_ngn).toBe(2_150);
    expect(expense.date).toBe('2026-08-13');
    expect(String(expense.expense_type)).toContain('COT');

    const mv = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(r.treasuryMovementId);
    expect(mv.type).toBe('EXPENSE');
    expect(Number(mv.amount_ngn)).toBe(-2_150);
    expect(Number(mv.treasury_account_id)).toBe(Number(account.id));
    expect(mv.source_kind).toBe('EXPENSE');
    expect(mv.source_id).toBe(r.expenseID);

    const after = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(account.id);
    expect(Math.round(Number(after.balance) || 0)).toBe(beforeBalance - 2_150);

    const je = db
      .prepare(
        `SELECT id FROM gl_journal_entries WHERE source_kind = 'EXPENSE_PAYMENT_GL' AND source_id = ?`
      )
      .get(r.treasuryMovementId);
    expect(je?.id).toBeTruthy();

    const lines = db
      .prepare(
        `SELECT ga.code AS account_code, jl.debit_ngn, jl.credit_ngn
         FROM gl_journal_lines jl
         JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE jl.journal_id = ?`
      )
      .all(je.id);
    const debit = lines.find((l) => Number(l.debit_ngn) > 0);
    const credit = lines.find((l) => Number(l.credit_ngn) > 0);
    expect(debit?.account_code).toBe('6170');
    expect(Number(debit?.debit_ngn)).toBe(2_150);
    expect(Number(credit?.credit_ngn)).toBe(2_150);
  });

  it('rejects missing account and non-positive amount', () => {
    expect(recordBankCharge(db, { amountNgn: 100, dateISO: '2026-08-13' }).ok).toBe(false);
    const account = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    expect(
      recordBankCharge(db, {
        treasuryAccountId: account.id,
        amountNgn: 0,
        dateISO: '2026-08-13',
      }).ok
    ).toBe(false);
  });
});
