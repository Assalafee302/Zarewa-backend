import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { lockAccountingPeriod } from '../controlOps.js';
import { insertExpenseEntry, payPaymentRequest, reversePaymentRequestTreasuryPayouts } from '../writeOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const ACTOR = { id: 'u-fin', displayName: 'Finance' };

function balance(db) {
  return Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = 1`).get().balance);
}

function seedRequest(db, requestId, amountNgn, date) {
  const exp = insertExpenseEntry(
    db,
    {
      category: 'Maintenance',
      expenseType: 'Generator service',
      amountNgn,
      date,
      paymentMethod: 'Transfer',
      actor: ACTOR,
    },
    'BR-KD'
  );
  expect(exp.ok, exp.error).toBe(true);
  db.prepare(
    `INSERT INTO payment_requests (
      request_id, expense_id, amount_requested_ngn, request_date, approval_status, description, paid_amount_ngn
    ) VALUES (?,?,?,?,?,?,?)`
  ).run(requestId, exp.expenseID, amountNgn, date, 'Approved', 'Generator service', 0);
  return exp.expenseID;
}

describe.skipIf(!mysqlAvailable())('payment request payout reversal', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('deletes an open-month expense payout so recording it again is a single payment', () => {
    const before = balance(db);
    const expenseId = seedRequest(db, 'PR-OPEN-1', 50_000, '2026-03-29');
    const pay = payPaymentRequest(db, 'PR-OPEN-1', {
      treasuryAccountId: 1,
      amountNgn: 50_000,
      paidAtISO: '2026-03-29',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(pay.ok, pay.error).toBe(true);
    expect(balance(db)).toBe(before - 50_000);

    const rev = reversePaymentRequestTreasuryPayouts(
      db,
      'PR-OPEN-1',
      { note: 'wrong account', workspaceBranchId: 'BR-KD' },
      ACTOR
    );
    expect(rev.ok, rev.error).toBe(true);
    expect(rev.expenseRemoved).toBe(true);
    expect(rev.movements).toEqual([]);
    expect(db.prepare(`SELECT request_id FROM payment_requests WHERE request_id = 'PR-OPEN-1'`).get()).toBeFalsy();
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(expenseId)).toBeFalsy();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM treasury_movements WHERE source_id IN ('PR-OPEN-1', ?)`).get(expenseId).n
    ).toBe(0);
    expect(balance(db)).toBe(before);

    const again = payPaymentRequest(db, 'PR-OPEN-1', {
      treasuryAccountId: 1,
      amountNgn: 50_000,
      paidAtISO: '2026-03-29',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(again.ok).toBe(false);

    const expenseId2 = seedRequest(db, 'PR-OPEN-2', 50_000, '2026-03-30');
    const pay2 = payPaymentRequest(db, 'PR-OPEN-2', {
      treasuryAccountId: 1,
      amountNgn: 50_000,
      paidAtISO: '2026-03-30',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(pay2.ok, pay2.error).toBe(true);
    const outs = db
      .prepare(
        `SELECT source_id, amount_ngn FROM treasury_movements
         WHERE amount_ngn < 0 AND source_kind = 'PAYMENT_REQUEST'`
      )
      .all();
    expect(outs).toEqual([{ source_id: 'PR-OPEN-2', amount_ngn: -50_000 }]);
    expect(balance(db)).toBe(before - 50_000);
    expect(db.prepare(`SELECT amount_ngn FROM expenses WHERE expense_id = ?`).get(expenseId2).amount_ngn).toBe(50_000);
  });

  it('does not pay again while a live cash line is still on the request', () => {
    seedRequest(db, 'PR-LIVE-1', 20_000, '2026-04-02');
    const pay = payPaymentRequest(db, 'PR-LIVE-1', {
      treasuryAccountId: 1,
      amountNgn: 20_000,
      paidAtISO: '2026-04-02',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(pay.ok, pay.error).toBe(true);
    db.prepare(`UPDATE payment_requests SET paid_amount_ngn = 0 WHERE request_id = 'PR-LIVE-1'`).run();
    const second = payPaymentRequest(db, 'PR-LIVE-1', {
      treasuryAccountId: 1,
      amountNgn: 20_000,
      paidAtISO: '2026-04-02',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toMatch(/still has a payout/i);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM treasury_movements WHERE source_id = 'PR-LIVE-1'`).get().n
    ).toBe(1);
  });

  it('cancels a locked-month payout instead of deleting the closed cash line', () => {
    const before = balance(db);
    const expenseId = seedRequest(db, 'PR-LOCK-1', 15_000, '2026-03-11');
    const pay = payPaymentRequest(db, 'PR-LOCK-1', {
      treasuryAccountId: 1,
      amountNgn: 15_000,
      paidAtISO: '2026-03-11',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(pay.ok, pay.error).toBe(true);
    const locked = lockAccountingPeriod(db, { periodKey: '2026-03', reason: 'month closed' }, ACTOR);
    expect(locked.ok, locked.error).toBe(true);

    const rev = reversePaymentRequestTreasuryPayouts(
      db,
      'PR-LOCK-1',
      { note: 'wrong payee', actedAtISO: '2026-10-01', workspaceBranchId: 'BR-KD' },
      ACTOR
    );
    expect(rev.ok, rev.error).toBe(true);
    expect(rev.mode).toBe('cancelled');
    expect(rev.expenseRemoved).toBe(false);
    expect(rev.movements).toHaveLength(1);
    expect(Number(rev.movements[0].amountNgn)).toBe(15_000);
    expect(db.prepare(`SELECT approval_status, paid_amount_ngn FROM payment_requests WHERE request_id = 'PR-LOCK-1'`).get()).toEqual({
      approval_status: 'Cancelled',
      paid_amount_ngn: 0,
    });
    expect(db.prepare(`SELECT amount_ngn FROM expenses WHERE expense_id = ?`).get(expenseId).amount_ngn).toBe(0);
    expect(balance(db)).toBe(before);

    const repay = payPaymentRequest(db, 'PR-LOCK-1', {
      treasuryAccountId: 1,
      amountNgn: 15_000,
      paidAtISO: '2026-10-01',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(repay.ok).toBe(false);
  });
});
