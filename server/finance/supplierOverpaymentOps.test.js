import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { lockAccountingPeriod } from '../controlOps.js';
import { recordSupplierPayment } from '../writeOps.js';
import {
  correctSupplierPaymentAmount,
  listEditableSupplierPayments,
  recordSupplierExcessPayment,
  recordSupplierOverpaymentReversal,
  supplierCashPosition,
} from './supplierOverpaymentOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const ACTOR = { id: 'u-fin', displayName: 'Finance', permissions: ['finance.pay'] };

function balance(db, treasuryAccountId) {
  return Number(db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId).balance);
}

function glBySource(db, sourceId) {
  return db
    .prepare(
      `SELECT a.code AS code, SUM(l.debit_ngn) AS debit, SUM(l.credit_ngn) AS credit
       FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_id
       JOIN gl_accounts a ON a.id = l.account_id
       WHERE e.source_id = ?
       GROUP BY a.code`
    )
    .all(sourceId);
}

function seedPo(db, { poId, paidNgn, orderedNgn, branchId = 'BR-KD' }) {
  db.prepare(
    `INSERT INTO purchase_orders (
      po_id, supplier_id, supplier_name, order_date_iso, status, supplier_paid_ngn, branch_id
    ) VALUES (?,?,?,?,?,?,?)`
  ).run(poId, 'SUP-1', 'Coil Mill', '2026-03-01', 'received', paidNgn, branchId);
  db.prepare(
    `INSERT INTO purchase_order_lines (
      po_id, line_key, product_id, product_name, qty_ordered, qty_received, unit_price_ngn
    ) VALUES (?,?,?,?,?,?,?)`
  ).run(poId, 'L1', 'COIL-1', 'Coil', 1, 1, orderedNgn);
}

describe.skipIf(!mysqlAvailable())('supplier overpayment', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  let treasuryAccountId;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES (?,?,?,?,?,?,?)`
    ).run('Kaduna Bank', 'Test Bank', 5_000_000, 'Bank', 'ACC-1', 'BR-KD', 5_000_000);
    treasuryAccountId = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id DESC LIMIT 1`).get().id;
  });

  afterEach(() => {
    db?.close();
  });

  function pay(poId, amountNgn, reference, reason = 'duplicate_payment') {
    return recordSupplierExcessPayment(db, poId, {
      amountNgn,
      treasuryAccountId,
      dateISO: '2026-03-20',
      reference,
      note: 'Second transfer already left the bank',
      reason,
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
  }

  function reverse(poId, amountNgn, reference) {
    return recordSupplierOverpaymentReversal(db, poId, {
      amountNgn,
      treasuryAccountId,
      dateISO: '2026-03-21',
      reference,
      note: 'Supplier returned the extra cash',
      reason: 'supplier_refund',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
  }

  it('records a second payment on a fully paid order, then the refund of that overpayment', () => {
    seedPo(db, { poId: 'PO-DBL', paidNgn: 1_000_000, orderedNgn: 1_000_000 });
    const before = balance(db, treasuryAccountId);

    const extra = pay('PO-DBL', 1_000_000, 'TRF-2');
    expect(extra.ok, extra.error).toBe(true);
    expect(extra.settlementNgn).toBe(0);
    expect(extra.advanceNgn).toBe(1_000_000);
    expect(extra.position.supplierPaidNgn).toBe(2_000_000);
    expect(extra.position.excessNgn).toBe(1_000_000);
    expect(balance(db, treasuryAccountId)).toBe(before - 1_000_000);

    const lines = glBySource(db, extra.treasuryMovementId);
    expect(lines.find((l) => l.code === '1400')?.debit).toBe(1_000_000);
    expect(lines.some((l) => l.credit === 1_000_000)).toBe(true);

    const back = reverse('PO-DBL', 1_000_000, 'RFD-2');
    expect(back.ok, back.error).toBe(true);
    expect(back.unwindAdvanceNgn).toBe(1_000_000);
    expect(back.position.supplierPaidNgn).toBe(1_000_000);
    expect(back.position.excessNgn).toBe(0);
    expect(balance(db, treasuryAccountId)).toBe(before);

    const tooMuch = reverse('PO-DBL', 1, 'RFD-3');
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.error).toMatch(/Nothing is above the order value/);
  });

  it('splits one transfer that both settles the order and overpays, then reverses only the extra', () => {
    seedPo(db, { poId: 'PO-OVER', paidNgn: 0, orderedNgn: 1_000_000 });
    const within = pay('PO-OVER', 400_000, 'TRF-PART', 'overpayment');
    expect(within.ok).toBe(false);
    expect(within.error).toMatch(/normal supplier payment/);

    const extra = pay('PO-OVER', 1_200_000, 'TRF-OVER', 'overpayment');
    expect(extra.ok, extra.error).toBe(true);
    expect(extra.settlementNgn).toBe(1_000_000);
    expect(extra.advanceNgn).toBe(200_000);
    expect(supplierCashPosition(db, 'PO-OVER').excessNgn).toBe(200_000);

    const lines = glBySource(db, extra.treasuryMovementId);
    expect(lines.find((l) => l.code === '2000')?.debit).toBe(1_000_000);
    expect(lines.find((l) => l.code === '1400')?.debit).toBe(200_000);

    const back = reverse('PO-OVER', 200_000, 'RFD-OVER');
    expect(back.ok, back.error).toBe(true);
    expect(back.unwindAdvanceNgn).toBe(200_000);
    expect(back.position.supplierPaidNgn).toBe(1_000_000);
    expect(back.position.excessNgn).toBe(0);
    expect(balance(db, treasuryAccountId)).toBe(5_000_000 - 1_000_000);

    const again = reverse('PO-OVER', 200_000, 'RFD-OVER');
    expect(again.ok, again.error).toBe(true);
    expect(again.duplicate).toBe(true);
    expect(supplierCashPosition(db, 'PO-OVER').supplierPaidNgn).toBe(1_000_000);
  });

  it('does not post the same bank reference twice', () => {
    seedPo(db, { poId: 'PO-DUP', paidNgn: 500_000, orderedNgn: 500_000 });
    const first = pay('PO-DUP', 500_000, 'TRF-SAME');
    expect(first.ok, first.error).toBe(true);
    const second = pay('PO-DUP', 500_000, 'TRF-SAME');
    expect(second.ok, second.error).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(supplierCashPosition(db, 'PO-DUP').supplierPaidNgn).toBe(1_000_000);
  });

  it('blocks a locked period and another branch', () => {
    seedPo(db, { poId: 'PO-LOCK', paidNgn: 100_000, orderedNgn: 100_000 });
    lockAccountingPeriod(db, { periodKey: '2026-03', reason: 'closed' }, ACTOR);
    const locked = pay('PO-LOCK', 100_000, 'TRF-LOCK');
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/locked period/);

    seedPo(db, { poId: 'PO-YOL', paidNgn: 100_000, orderedNgn: 100_000, branchId: 'BR-YOL' });
    const other = recordSupplierExcessPayment(db, 'PO-YOL', {
      amountNgn: 50_000,
      treasuryAccountId,
      dateISO: '2026-04-02',
      reference: 'TRF-YOL',
      note: 'Paid from the wrong branch workspace',
      reason: 'duplicate_payment',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/BR-YOL/);
  });

  it('corrects a posted supplier payment to the amount that left the bank', () => {
    seedPo(db, { poId: 'PO-FIX', paidNgn: 0, orderedNgn: 1_000_000 });
    const posted = recordSupplierPayment(db, 'PO-FIX', 1_000_000, 'First settlement', {
      treasuryAccountId,
      dateISO: '2026-04-02',
      reference: 'TRF-WRONG',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(posted.ok, posted.error).toBe(true);
    const lines = listEditableSupplierPayments(db, 'PO-FIX');
    expect(lines).toHaveLength(1);
    expect(lines[0].amountPaidNgn).toBe(1_000_000);
    const before = balance(db, treasuryAccountId);

    const up = correctSupplierPaymentAmount(db, 'PO-FIX', {
      movementId: lines[0].id,
      amountNgn: '1,200,000',
      note: 'Bank alert was higher than entered',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(up.ok, up.error).toBe(true);
    expect(up.settlementNgn).toBe(0);
    expect(up.advanceNgn).toBe(200_000);
    expect(up.position.supplierPaidNgn).toBe(1_200_000);
    expect(up.position.excessNgn).toBe(200_000);
    expect(balance(db, treasuryAccountId)).toBe(before - 200_000);

    const same = correctSupplierPaymentAmount(db, 'PO-FIX', {
      movementId: lines[0].id,
      amountNgn: 1_200_000,
      note: 'Bank alert was higher than entered',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(same.ok, same.error).toBe(true);
    expect(same.noOp).toBe(true);
    expect(balance(db, treasuryAccountId)).toBe(before - 200_000);

    const down = correctSupplierPaymentAmount(db, 'PO-FIX', {
      movementId: lines[0].id,
      amountNgn: 800_000,
      note: 'Correct figure from the bank alert',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(down.ok, down.error).toBe(true);
    expect(down.position.supplierPaidNgn).toBe(800_000);
    expect(down.position.stillOwedNgn).toBe(200_000);
    expect(down.position.excessNgn).toBe(0);
    expect(balance(db, treasuryAccountId)).toBe(before + 200_000);
    const movement = db.prepare(`SELECT amount_ngn FROM treasury_movements WHERE id = ?`).get(lines[0].id);
    expect(Number(movement.amount_ngn)).toBe(-800_000);

    const missing = correctSupplierPaymentAmount(db, 'PO-FIX', {
      movementId: 'TM-NOT-HERE',
      amountNgn: 100,
      note: 'This payment is not on the order',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(missing.ok).toBe(false);
  });

  it('corrects an extra payment down without a separate refund', () => {
    seedPo(db, { poId: 'PO-EDIT-EXTRA', paidNgn: 1_000_000, orderedNgn: 1_000_000 });
    const extra = pay('PO-EDIT-EXTRA', 1_000_000, 'TRF-EXTRA');
    expect(extra.ok, extra.error).toBe(true);
    const before = balance(db, treasuryAccountId);
    const fixed = correctSupplierPaymentAmount(db, 'PO-EDIT-EXTRA', {
      movementId: extra.treasuryMovementId,
      amountNgn: 400_000,
      note: 'Only 400,000 of the second transfer left the bank',
      actor: ACTOR,
      workspaceBranchId: 'BR-KD',
    });
    expect(fixed.ok, fixed.error).toBe(true);
    expect(fixed.unwindAdvanceNgn).toBe(600_000);
    expect(fixed.position.supplierPaidNgn).toBe(1_400_000);
    expect(fixed.position.excessNgn).toBe(400_000);
    expect(balance(db, treasuryAccountId)).toBe(before + 600_000);
  });
});
