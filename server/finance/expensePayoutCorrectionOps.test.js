import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { insertExpenseEntry } from '../writeOps.js';
import {
  listDirectExpenseRefunds,
  listExpensePayoutsOnAccount,
  reassignExpensePayouts,
  releaseDirectExpenseRefunds,
} from './expensePayoutCorrectionOps.js';

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
  id: 'usr-payout-correct',
  displayName: 'Payout correct',
  roleKey: 'admin',
  permissions: ['*', 'finance.pay', 'finance.post', 'finance.reverse'],
};

function balance(db, accountId) {
  return Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(accountId)?.balance);
}

describe.skipIf(!mysqlOk)('expense payout corrections', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let tajId;
  let moniepointId;

  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('TAJ', 'TAJ Bank', 5000000, 'Bank', 'TAJ-1', ?, 5000000)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('Moniepoint', 'Moniepoint', 1000, 'Bank', 'MONIE-1', ?, 1000)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES (?, 'payout.correct', 'Payout correct', 'x', 'admin', 'active', ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'active'`
    ).run(ACTOR.id, new Date().toISOString());
    tajId = Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'TAJ-1'`).get()?.id);
    moniepointId = Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'MONIE-1'`).get()?.id);
    expect(tajId).toBeGreaterThan(0);
    expect(moniepointId).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('moves a payout onto the account that paid even when that book balance is short', () => {
    const beforeTaj = balance(db, tajId);
    const beforeMonie = balance(db, moniepointId);
    const created = insertExpenseEntry(
      db,
      {
        category: 'Fuel & lubricant',
        expenseType: 'Diesel',
        amountNgn: 80_000,
        date: new Date().toISOString().slice(0, 10),
        paymentMethod: 'Bank',
        reference: 'PAID-MONIE-BOOKED-TAJ',
        treasuryAccountId: tajId,
        actor: ACTOR,
      },
      DEFAULT_BRANCH_ID
    );
    expect(created.ok, created.error).toBe(true);
    expect(balance(db, tajId)).toBe(beforeTaj - 80_000);

    const listed = listExpensePayoutsOnAccount(db, {
      branchId: DEFAULT_BRANCH_ID,
      treasuryAccountId: tajId,
      q: 'PAID-MONIE-BOOKED-TAJ',
    });
    expect(listed).toHaveLength(1);

    const moved = reassignExpensePayouts(
      db,
      {
        movementIds: [listed[0].movementId],
        toTreasuryAccountId: moniepointId,
        workspaceBranchId: DEFAULT_BRANCH_ID,
        note: 'Paid from Moniepoint, booked on TAJ',
      },
      ACTOR
    );
    expect(moved.ok, moved.error).toBe(true);
    expect(moved.moved[0].mode).toBe('in_place');
    expect(balance(db, tajId)).toBe(beforeTaj);
    expect(balance(db, moniepointId)).toBe(beforeMonie - 80_000);

    const stillOnTaj = listExpensePayoutsOnAccount(db, {
      branchId: DEFAULT_BRANCH_ID,
      treasuryAccountId: tajId,
      q: 'PAID-MONIE-BOOKED-TAJ',
    });
    expect(stillOnTaj).toHaveLength(0);
    const onMonie = listExpensePayoutsOnAccount(db, {
      branchId: DEFAULT_BRANCH_ID,
      treasuryAccountId: moniepointId,
      q: 'PAID-MONIE-BOOKED-TAJ',
    });
    expect(onMonie).toHaveLength(1);
  });

  it('dates the account move today when the payout month is locked', () => {
    const today = new Date().toISOString().slice(0, 10);
    const lockedMonth = today.slice(5, 7) === '01' ? '2026-02' : '2026-01';
    const created = insertExpenseEntry(
      db,
      {
        category: 'Office expenses',
        expenseType: 'Supplies',
        amountNgn: 20_000,
        date: `${lockedMonth}-15`,
        paymentMethod: 'Bank',
        reference: 'LOCKED-MONTH-TAJ',
        treasuryAccountId: tajId,
        actor: ACTOR,
      },
      DEFAULT_BRANCH_ID
    );
    expect(created.ok, created.error).toBe(true);
    db.prepare(
      `INSERT INTO accounting_period_locks (period_key, locked_from_iso, locked_at_iso, reason)
       VALUES (?, ?, ?, ?)`
    ).run(lockedMonth, `${lockedMonth}-01`, new Date().toISOString(), 'Month closed');

    const beforeTaj = balance(db, tajId);
    const beforeMonie = balance(db, moniepointId);
    const listed = listExpensePayoutsOnAccount(db, {
      branchId: DEFAULT_BRANCH_ID,
      treasuryAccountId: tajId,
      q: 'LOCKED-MONTH-TAJ',
    });
    expect(listed).toHaveLength(1);
    const noReason = reassignExpensePayouts(
      db,
      {
        movementIds: [listed[0].movementId],
        toTreasuryAccountId: moniepointId,
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      ACTOR
    );
    expect(noReason.ok).toBe(false);
    expect(balance(db, tajId)).toBe(beforeTaj);
    const moved = reassignExpensePayouts(
      db,
      {
        movementIds: [listed[0].movementId],
        toTreasuryAccountId: moniepointId,
        workspaceBranchId: DEFAULT_BRANCH_ID,
        correctionReason: 'Bank statement shows Moniepoint paid it',
      },
      ACTOR
    );
    expect(moved.ok, moved.error).toBe(true);
    expect(moved.moved[0].mode).toBe('open_period_adjustment');
    expect(balance(db, tajId)).toBe(beforeTaj + 20_000);
    expect(balance(db, moniepointId)).toBe(beforeMonie - 20_000);
    const charge = db
      .prepare(
        `SELECT treasury_account_id, amount_ngn, posted_at_iso
         FROM treasury_movements
         WHERE source_id = ? AND treasury_account_id = ? AND amount_ngn < 0
         ORDER BY posted_at_iso DESC LIMIT 1`
      )
      .get(created.expenseID, moniepointId);
    expect(String(charge?.posted_at_iso || '').slice(0, 10)).toBe(today);
  });

  it('reverses a refund posted as an expense, zeroes it and puts the cash back', () => {
    const beforeTaj = balance(db, tajId);
    const created = insertExpenseEntry(
      db,
      {
        category: 'Refund',
        expenseType: 'Customer refund paid outside Sales',
        amountNgn: 12_000,
        date: new Date().toISOString().slice(0, 10),
        paymentMethod: 'Bank',
        reference: 'DIRECT-REFUND-1',
        treasuryAccountId: tajId,
        allowRevenue: true,
        actor: ACTOR,
      },
      DEFAULT_BRANCH_ID
    );
    expect(created.ok, created.error).toBe(true);
    expect(balance(db, tajId)).toBe(beforeTaj - 12_000);
    const listed = listDirectExpenseRefunds(db, { branchId: DEFAULT_BRANCH_ID });
    expect(listed.some((row) => row.expenseId === created.expenseID)).toBe(true);

    const released = releaseDirectExpenseRefunds(
      db,
      { expenseIds: [created.expenseID], workspaceBranchId: DEFAULT_BRANCH_ID },
      ACTOR
    );
    expect(released.ok, released.error).toBe(true);
    expect(released.released[0].mode).toBe('zeroed');
    expect(balance(db, tajId)).toBe(beforeTaj);
    const exp = db.prepare(`SELECT amount_ngn FROM expenses WHERE expense_id = ?`).get(created.expenseID);
    expect(Number(exp.amount_ngn)).toBe(0);
    const rows = db
      .prepare(`SELECT amount_ngn, reverses_movement_id FROM treasury_movements WHERE source_id = ?`)
      .all(created.expenseID);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.reduce((s, r) => s + Number(r.amount_ngn), 0)).toBe(0);
  });

  it('refuses to clear an expense that is not a refund', () => {
    const created = insertExpenseEntry(
      db,
      {
        category: 'Security',
        expenseType: 'Night guard',
        amountNgn: 4_000,
        date: new Date().toISOString().slice(0, 10),
        paymentMethod: 'Cash',
        reference: 'NOT-A-REFUND',
        treasuryAccountId: tajId,
        actor: ACTOR,
      },
      DEFAULT_BRANCH_ID
    );
    expect(created.ok, created.error).toBe(true);
    const released = releaseDirectExpenseRefunds(
      db,
      { expenseIds: [created.expenseID], workspaceBranchId: DEFAULT_BRANCH_ID },
      ACTOR
    );
    expect(released.ok).toBe(false);
    expect(db.prepare(`SELECT amount_ngn FROM expenses WHERE expense_id = ?`).get(created.expenseID)?.amount_ngn).toBe(
      4_000
    );
  });
});
