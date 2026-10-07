/**
 * Supplier cash that is above the purchase-order value.
 *
 * Invariants:
 * - A second payment, or the slice of a transfer above what is still owed, is not another
 *   settlement of the invoice. That extra cash is a supplier advance (GL 1400) until it is reversed.
 * - A reversal cannot reduce `supplier_paid_ngn` below the order obligation (ordered value, or
 *   received value when goods landed cost more than the order).
 * - Treasury, `supplier_paid_ngn`, accounts payable, and the GL journal commit together.
 * - The same bank reference and amount on the same PO is not posted twice.
 * - Correcting a payment restates that one outflow. The difference moves cash, the paid total,
 *   and a balancing journal. It does not delete the original line.
 */
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import {
  assertEntityBranchForWorkspaceWrite,
  userMaySettleSupplierPayableFromHqRollup,
} from '../branchScope.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  computePoReceivedBasisEconomics,
  orderedValueFromLines,
  roundMoney,
} from '../ap2ReceivedBasisOps.js';
import { ensureSupplierAdvanceGlAccount } from '../ap2SupplierAdvanceGl.js';
import { ensureArchitecturalGlAccounts, ensureTreasuryCashGlAccount } from '../accountingPostingOps.js';
import { postBalancedJournalTx } from '../glOps.js';
import { nextStockMovementHumanId } from '../humanId.js';
import { insertStockMovementTx } from '../stockMovementOps.js';
import { insertPurchasePaymentCashierAckTx } from './purchasePaymentCashierAckOps.js';
import { insertTreasuryMovementTx, syncAccountsPayableFromPurchaseOrder } from '../writeOps.js';
import { supplierPaymentCapBlock } from '../procurement/poSupplierAdvanceGuard.js';

const EXCESS_REASONS = {
  duplicate_payment: 'Duplicate supplier payment',
  overpayment: 'Supplier overpayment',
};

const REVERSAL_REASONS = {
  supplier_refund: 'Supplier refunded the overpayment',
  bank_reversal: 'Bank reversed the extra payment',
};

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 */
export function supplierCashPosition(db, poId) {
  const id = String(poId || '').trim();
  if (!id) return { ok: false, error: 'Purchase order is required.' };
  const po = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(id);
  if (!po) return { ok: false, error: 'Purchase order not found.' };
  const lines = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(id);
  const orderedValueNgn = orderedValueFromLines(lines);
  let receivedValueNgn = 0;
  try {
    receivedValueNgn = computePoReceivedBasisEconomics(db, po, lines, { apRow: null }).receivedValueNgn;
  } catch {
    receivedValueNgn = 0;
  }
  const obligationNgn = Math.max(roundMoney(orderedValueNgn), roundMoney(receivedValueNgn));
  const supplierPaidNgn = roundMoney(po.supplier_paid_ngn);
  return {
    ok: true,
    poId: id,
    supplierId: String(po.supplier_id || '').trim(),
    supplierName: String(po.supplier_name || '').trim(),
    branchId: String(po.branch_id || '').trim() || DEFAULT_BRANCH_ID,
    status: String(po.status || '').trim(),
    orderedValueNgn,
    receivedValueNgn: roundMoney(receivedValueNgn),
    obligationNgn,
    supplierPaidNgn,
    stillOwedNgn: Math.max(0, obligationNgn - supplierPaidNgn),
    excessNgn: Math.max(0, supplierPaidNgn - obligationNgn),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 */
export function listSupplierOverpaymentMovements(db, poId) {
  const id = String(poId || '').trim();
  if (!id) return [];
  const rows = db
    .prepare(
      `SELECT tm.id, tm.posted_at_iso, tm.type, tm.amount_ngn, tm.reference, tm.note, tm.treasury_account_id,
              ta.name AS account_name, ta.type AS account_type, ta.bank_name
       FROM treasury_movements tm
       LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE tm.source_id = ?
         AND tm.source_kind IN ('SUPPLIER_OVERPAYMENT', 'SUPPLIER_OVERPAYMENT_REVERSAL')
       ORDER BY tm.posted_at_iso DESC, tm.id DESC`
    )
    .all(id);
  return rows.map((row) => ({
    id: row.id,
    postedAtISO: row.posted_at_iso || '',
    type: row.type || '',
    amountNgn: roundMoney(row.amount_ngn),
    reference: row.reference || '',
    note: row.note || '',
    treasuryAccountId: Number(row.treasury_account_id) || 0,
    accountName: String(row.account_name || row.bank_name || '').trim(),
    accountType: String(row.account_type || '').trim(),
  }));
}

/**
 * Net debit on a GL account for supplier cash already posted against this PO.
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {string} accountCode
 */
function netGlForPoSupplierCash(db, poId, accountCode) {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_ngn - l.credit_ngn), 0) AS net
         FROM gl_journal_lines l
         JOIN gl_journal_entries e ON e.id = l.journal_id
         JOIN gl_accounts a ON a.id = l.account_id
         WHERE a.code = ?
           AND e.source_id IN (
             SELECT tm.id FROM treasury_movements tm
             LEFT JOIN accounts_payable ap
               ON tm.source_kind = 'ACCOUNTS_PAYABLE' AND tm.source_id = ap.ap_id
             WHERE (tm.source_kind = 'PURCHASE_ORDER' AND tm.source_id = ? AND tm.type = 'SUPPLIER_PAYMENT')
                OR (tm.source_kind IN ('SUPPLIER_OVERPAYMENT', 'SUPPLIER_OVERPAYMENT_REVERSAL') AND tm.source_id = ?)
                OR ap.po_ref = ?
           )`
      )
      .get(accountCode, poId, poId, poId);
    return roundMoney(row?.net);
  } catch {
    return 0;
  }
}

function rejectGl(gl) {
  if (!gl || gl.ok || gl.skipped || gl.duplicate) return null;
  return gl.error || 'Supplier overpayment GL posting failed.';
}

function postingDay(payload) {
  return (
    String(payload.dateISO || payload.postedAtISO || '')
      .trim()
      .slice(0, 10) || new Date().toISOString().slice(0, 10)
  );
}

/** Accepts 1200000 or 1,200,000. */
function moneyInput(value) {
  if (typeof value === 'number') return roundMoney(value);
  const raw = String(value ?? '').replace(/[₦,\s]/g, '');
  return roundMoney(raw);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {object} payload
 * @param {'payment' | 'reversal'} kind
 */
function assertPostingContext(db, poId, payload, kind) {
  const position = supplierCashPosition(db, poId);
  if (!position.ok) return position;
  if (String(position.status).toLowerCase() === 'rejected') {
    return { ok: false, error: 'This purchase order is rejected.' };
  }
  if (position.obligationNgn <= 0) {
    return {
      ok: false,
      error:
        'This purchase order has no line value, so a duplicate payment or overpayment cannot be measured. Enter the PO prices first.',
    };
  }
  const amountNgn = moneyInput(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
  const treasuryAccountId = Number(payload.treasuryAccountId);
  if (!treasuryAccountId) return { ok: false, error: 'Treasury account is required.' };
  const reference = String(payload.reference || '').trim();
  if (reference.length < 3) return { ok: false, error: 'Enter the bank reference (at least 3 characters).' };
  const note = String(payload.note || '').trim();
  if (note.length < 8) {
    return { ok: false, error: 'Enter a note explaining this payment or reversal (at least 8 characters).' };
  }
  const reasons = kind === 'payment' ? EXCESS_REASONS : REVERSAL_REASONS;
  const reason = String(payload.reason || '').trim();
  if (!reasons[reason]) {
    return { ok: false, error: 'Choose why this cash is being recorded.' };
  }
  const hqSettle = userMaySettleSupplierPayableFromHqRollup(payload.actor, payload.workspaceViewAll);
  if (!hqSettle) {
    const gate = assertEntityBranchForWorkspaceWrite(
      payload.actor,
      position.branchId,
      payload.workspaceBranchId,
      Boolean(payload.workspaceViewAll)
    );
    if (!gate.ok) return { ok: false, error: gate.error };
  }
  const day = postingDay(payload);
  try {
    assertPeriodOpen(db, day, kind === 'payment' ? 'Supplier excess payment date' : 'Supplier overpayment reversal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return {
    ok: true,
    position,
    amountNgn,
    treasuryAccountId,
    reference,
    note,
    reason,
    reasonLabel: reasons[reason],
    day,
    hqSettle,
  };
}

function existingMovement(db, sourceKind, poId, reference, amountNgn, type) {
  return db
    .prepare(
      `SELECT id FROM treasury_movements
       WHERE source_kind = ? AND source_id = ? AND reference = ? AND amount_ngn = ? AND type = ?`
    )
    .get(sourceKind, poId, reference, amountNgn, type);
}

/**
 * Record cash that left the bank above what the purchase order still owed.
 * The slice that clears the remaining balance settles accounts payable.
 * The slice above that balance is a supplier advance.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {object} payload
 */
export function recordSupplierExcessPayment(db, poId, payload = {}) {
  const ctx = assertPostingContext(db, poId, payload, 'payment');
  if (!ctx.ok) return ctx;
  const cap = supplierPaymentCapBlock({
    paidNgn: ctx.position.supplierPaidNgn,
    orderedNgn: ctx.position.orderedValueNgn,
    mdNote: payload.mdNote,
  });
  if (cap) return cap;
  if (ctx.amountNgn <= ctx.position.stillOwedNgn) {
    return {
      ok: false,
      error: `₦${ctx.amountNgn.toLocaleString('en-NG')} is still within what this purchase order owes (₦${ctx.position.stillOwedNgn.toLocaleString('en-NG')}). Record that as a normal supplier payment. Use this only for the extra cash above the order.`,
    };
  }
  const settlementNgn = ctx.position.stillOwedNgn;
  const advanceNgn = roundMoney(ctx.amountNgn - settlementNgn);
  const poBranchId = ctx.position.branchId;
  const treasuryWorkspace = ctx.hqSettle ? poBranchId : payload.workspaceBranchId;
  try {
    let result = { ok: false };
    db.transaction(() => {
      const fresh = supplierCashPosition(db, poId);
      if (!fresh.ok) throw new Error(fresh.error);
      if (ctx.amountNgn <= fresh.stillOwedNgn) {
        throw new Error(
          `₦${ctx.amountNgn.toLocaleString('en-NG')} is still within what this purchase order owes. Record it as a normal supplier payment.`
        );
      }
      const settlement = fresh.stillOwedNgn;
      const advance = roundMoney(ctx.amountNgn - settlement);
      const dup = existingMovement(
        db,
        'SUPPLIER_OVERPAYMENT',
        fresh.poId,
        ctx.reference,
        -ctx.amountNgn,
        'SUPPLIER_OVERPAYMENT'
      );
      if (dup?.id) {
        result = {
          ok: true,
          duplicate: true,
          treasuryMovementId: dup.id,
          amountNgn: ctx.amountNgn,
          settlementNgn: settlement,
          advanceNgn: advance,
          position: fresh,
        };
        return;
      }
      const nextPaid = roundMoney(fresh.supplierPaidNgn + ctx.amountNgn);
      db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = ? WHERE po_id = ?`).run(nextPaid, fresh.poId);
      const tm = insertTreasuryMovementTx(db, {
        type: 'SUPPLIER_OVERPAYMENT',
        treasuryAccountId: ctx.treasuryAccountId,
        amountNgn: -ctx.amountNgn,
        postedAtISO: ctx.day,
        reference: ctx.reference,
        counterpartyKind: 'SUPPLIER',
        counterpartyId: fresh.supplierId,
        counterpartyName: fresh.supplierName,
        sourceKind: 'SUPPLIER_OVERPAYMENT',
        sourceId: fresh.poId,
        note: `${ctx.reasonLabel}. ${ctx.note}`,
        createdBy: payload.createdBy || payload.actor?.displayName || 'Finance',
        workspaceBranchId: treasuryWorkspace,
        workspaceViewAll: ctx.hqSettle ? false : payload.workspaceViewAll,
        actor: payload.actor,
      });
      const cash = ensureTreasuryCashGlAccount(db, ctx.treasuryAccountId);
      if (!cash.ok) throw new Error(cash.error || 'Treasury cash account is not on the GL.');
      ensureArchitecturalGlAccounts(db);
      if (advance > 0) ensureSupplierAdvanceGlAccount(db);
      const lines = [];
      if (settlement > 0) lines.push({ accountCode: '2000', debitNgn: settlement, memo: fresh.poId });
      if (advance > 0) lines.push({ accountCode: '1400', debitNgn: advance, memo: fresh.poId });
      lines.push({ accountCode: cash.accountCode, creditNgn: ctx.amountNgn, memo: tm.id });
      const gl = postBalancedJournalTx(db, {
        entryDateISO: ctx.day,
        memo: `${ctx.reasonLabel} ${fresh.poId}`,
        sourceKind: 'SUPPLIER_OVERPAYMENT_GL',
        sourceId: tm.id,
        branchId: poBranchId,
        createdByUserId: payload.actor?.id ?? null,
        lines,
      });
      const glError = rejectGl(gl);
      if (glError) throw new Error(glError);
      const ack = insertPurchasePaymentCashierAckTx(db, {
        treasuryMovementId: tm.id,
        branchId: poBranchId,
        sourceKind: 'SUPPLIER_OVERPAYMENT',
        sourceId: fresh.poId,
        poId: fresh.poId,
        supplierId: fresh.supplierId,
        supplierName: fresh.supplierName,
        amountNgn: ctx.amountNgn,
        paidAtISO: tm.postedAtISO || ctx.day,
        paidByUserId: payload.actor?.id,
        paidByName: payload.actor?.displayName || payload.createdBy,
      });
      if (!ack.ok) throw new Error(ack.error || 'Failed to queue cashier acknowledgment.');
      insertStockMovementTx(db, {
        id: nextStockMovementHumanId(db),
        type: 'PO_SUPPLIER_OVERPAYMENT',
        ref: fresh.poId,
        detail: `${ctx.amountNgn} advance ${advance} — ${ctx.reasonLabel}`,
        dateISO: ctx.day,
        branchId: poBranchId,
      });
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'purchase_order.supplier_excess_payment',
        entityKind: 'purchase_order',
        entityId: fresh.poId,
        note: ctx.note,
        details: {
          reason: ctx.reason,
          amountNgn: ctx.amountNgn,
          settlementNgn: settlement,
          advanceNgn: advance,
          treasuryMovementId: tm.id,
          reference: ctx.reference,
        },
      });
      syncAccountsPayableFromPurchaseOrder(db, fresh.poId);
      result = {
        ok: true,
        treasuryMovementId: tm.id,
        amountNgn: ctx.amountNgn,
        settlementNgn: settlement,
        advanceNgn: advance,
        position: supplierCashPosition(db, fresh.poId),
      };
    })();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Record cash coming back for the amount already paid above the purchase order.
 * Credits supplier advances (1400) first, then trade payables (2000), matching how the extra was booked.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {object} payload
 */
export function recordSupplierOverpaymentReversal(db, poId, payload = {}) {
  const ctx = assertPostingContext(db, poId, payload, 'reversal');
  if (!ctx.ok) return ctx;
  if (ctx.position.excessNgn <= 0) {
    return {
      ok: false,
      error: `Nothing is above the order value. Paid ₦${ctx.position.supplierPaidNgn.toLocaleString('en-NG')} against an order of ₦${ctx.position.obligationNgn.toLocaleString('en-NG')}. Record the extra payment first if it is not in the books yet.`,
    };
  }
  if (ctx.amountNgn > ctx.position.excessNgn) {
    return {
      ok: false,
      error: `Only ₦${ctx.position.excessNgn.toLocaleString('en-NG')} is above the order value. Reverse that amount, or less.`,
    };
  }
  const poBranchId = ctx.position.branchId;
  const treasuryWorkspace = ctx.hqSettle ? poBranchId : payload.workspaceBranchId;
  try {
    let result = { ok: false };
    db.transaction(() => {
      const fresh = supplierCashPosition(db, poId);
      if (!fresh.ok) throw new Error(fresh.error);
      if (ctx.amountNgn > fresh.excessNgn) {
        throw new Error(
          `Only ₦${fresh.excessNgn.toLocaleString('en-NG')} is above the order value. Reverse that amount, or less.`
        );
      }
      const dup = existingMovement(
        db,
        'SUPPLIER_OVERPAYMENT_REVERSAL',
        fresh.poId,
        ctx.reference,
        ctx.amountNgn,
        'SUPPLIER_OVERPAYMENT_REVERSAL'
      );
      if (dup?.id) {
        result = {
          ok: true,
          duplicate: true,
          treasuryMovementId: dup.id,
          amountNgn: ctx.amountNgn,
          position: fresh,
        };
        return;
      }
      const nextPaid = roundMoney(fresh.supplierPaidNgn - ctx.amountNgn);
      if (nextPaid < fresh.obligationNgn) {
        throw new Error('Reversal would take supplier paid below the purchase order value.');
      }
      db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = ? WHERE po_id = ?`).run(nextPaid, fresh.poId);
      const tm = insertTreasuryMovementTx(db, {
        type: 'SUPPLIER_OVERPAYMENT_REVERSAL',
        treasuryAccountId: ctx.treasuryAccountId,
        amountNgn: ctx.amountNgn,
        postedAtISO: ctx.day,
        reference: ctx.reference,
        counterpartyKind: 'SUPPLIER',
        counterpartyId: fresh.supplierId,
        counterpartyName: fresh.supplierName,
        sourceKind: 'SUPPLIER_OVERPAYMENT_REVERSAL',
        sourceId: fresh.poId,
        note: `${ctx.reasonLabel}. ${ctx.note}`,
        createdBy: payload.createdBy || payload.actor?.displayName || 'Finance',
        workspaceBranchId: treasuryWorkspace,
        workspaceViewAll: ctx.hqSettle ? false : payload.workspaceViewAll,
        actor: payload.actor,
      });
      const net1400 = Math.max(0, netGlForPoSupplierCash(db, fresh.poId, '1400'));
      const net2000 = Math.max(0, netGlForPoSupplierCash(db, fresh.poId, '2000'));
      let left = ctx.amountNgn;
      const fromAdvanceKnown = Math.min(left, net1400);
      left -= fromAdvanceKnown;
      const unwindPayableNgn = Math.min(left, net2000);
      left -= unwindPayableNgn;
      const unwindAdvanceNgn = fromAdvanceKnown + left;
      const cash = ensureTreasuryCashGlAccount(db, ctx.treasuryAccountId);
      if (!cash.ok) throw new Error(cash.error || 'Treasury cash account is not on the GL.');
      ensureArchitecturalGlAccounts(db);
      if (unwindAdvanceNgn > 0) ensureSupplierAdvanceGlAccount(db);
      const lines = [{ accountCode: cash.accountCode, debitNgn: ctx.amountNgn, memo: tm.id }];
      if (unwindAdvanceNgn > 0) lines.push({ accountCode: '1400', creditNgn: unwindAdvanceNgn, memo: fresh.poId });
      if (unwindPayableNgn > 0) lines.push({ accountCode: '2000', creditNgn: unwindPayableNgn, memo: fresh.poId });
      const gl = postBalancedJournalTx(db, {
        entryDateISO: ctx.day,
        memo: `${ctx.reasonLabel} ${fresh.poId}`,
        sourceKind: 'SUPPLIER_OVERPAYMENT_REVERSAL_GL',
        sourceId: tm.id,
        branchId: poBranchId,
        createdByUserId: payload.actor?.id ?? null,
        lines,
      });
      const glError = rejectGl(gl);
      if (glError) throw new Error(glError);
      insertStockMovementTx(db, {
        id: nextStockMovementHumanId(db),
        type: 'PO_SUPPLIER_OVERPAYMENT_REVERSAL',
        ref: fresh.poId,
        detail: `${ctx.amountNgn} — ${ctx.reasonLabel}`,
        dateISO: ctx.day,
        branchId: poBranchId,
      });
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'purchase_order.supplier_overpayment_reversal',
        entityKind: 'purchase_order',
        entityId: fresh.poId,
        note: ctx.note,
        details: {
          reason: ctx.reason,
          amountNgn: ctx.amountNgn,
          unwindAdvanceNgn,
          unwindPayableNgn,
          treasuryMovementId: tm.id,
          reference: ctx.reference,
        },
      });
      syncAccountsPayableFromPurchaseOrder(db, fresh.poId);
      result = {
        ok: true,
        treasuryMovementId: tm.id,
        amountNgn: ctx.amountNgn,
        unwindAdvanceNgn,
        unwindPayableNgn,
        position: supplierCashPosition(db, fresh.poId),
      };
    })();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function paymentKindLabel(type) {
  if (type === 'SUPPLIER_OVERPAYMENT') return 'Extra / duplicate payment';
  if (type === 'AP_PAYMENT') return 'Invoice payment';
  return 'Invoice payment';
}

/**
 * Supplier outflows already posted against this purchase order. These are the lines
 * whose amount can be restated when the figure entered was wrong.
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 */
export function listEditableSupplierPayments(db, poId) {
  const id = String(poId || '').trim();
  if (!id) return [];
  const rows = db
    .prepare(
      `SELECT tm.id, tm.posted_at_iso, tm.type, tm.amount_ngn, tm.reference, tm.note,
              tm.treasury_account_id, tm.source_kind,
              ta.name AS account_name, ta.type AS account_type, ta.bank_name
       FROM treasury_movements tm
       LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE tm.amount_ngn < 0
         AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
         AND (
           (tm.type = 'SUPPLIER_PAYMENT' AND tm.source_kind = 'PURCHASE_ORDER' AND tm.source_id = ?)
           OR (tm.type = 'SUPPLIER_OVERPAYMENT' AND tm.source_kind = 'SUPPLIER_OVERPAYMENT' AND tm.source_id = ?)
           OR (
             tm.type = 'AP_PAYMENT'
             AND tm.source_kind = 'ACCOUNTS_PAYABLE'
             AND tm.source_id IN (SELECT ap_id FROM accounts_payable WHERE po_ref = ?)
           )
         )
       ORDER BY tm.posted_at_iso DESC, tm.id DESC`
    )
    .all(id, id, id);
  return rows.map((row) => ({
    id: row.id,
    postedAtISO: row.posted_at_iso || '',
    type: row.type || '',
    kindLabel: paymentKindLabel(row.type),
    amountNgn: roundMoney(row.amount_ngn),
    amountPaidNgn: Math.abs(roundMoney(row.amount_ngn)),
    reference: row.reference || '',
    note: row.note || '',
    treasuryAccountId: Number(row.treasury_account_id) || 0,
    accountName: String(row.account_name || row.bank_name || '').trim(),
    accountType: String(row.account_type || '').trim(),
    sourceKind: row.source_kind || '',
  }));
}

function loadEditablePayment(db, poId, movementId) {
  const id = String(movementId || '').trim();
  if (!id) return { ok: false, error: 'Choose the payment to correct.' };
  const row = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Payment not found.' };
  if (String(row.reverses_movement_id || '').trim()) {
    return { ok: false, error: 'This line is a reversal. Correct the original payment instead.' };
  }
  const type = String(row.type || '');
  const sourceKind = String(row.source_kind || '');
  const sourceId = String(row.source_id || '');
  let belongs = false;
  if (type === 'SUPPLIER_PAYMENT' && sourceKind === 'PURCHASE_ORDER' && sourceId === poId) belongs = true;
  if (type === 'SUPPLIER_OVERPAYMENT' && sourceKind === 'SUPPLIER_OVERPAYMENT' && sourceId === poId) belongs = true;
  if (type === 'AP_PAYMENT' && sourceKind === 'ACCOUNTS_PAYABLE') {
    const ap = db.prepare(`SELECT po_ref FROM accounts_payable WHERE ap_id = ?`).get(sourceId);
    belongs = String(ap?.po_ref || '') === poId;
  }
  if (!belongs) return { ok: false, error: 'That payment is not on this purchase order.' };
  const oldAmount = roundMoney(row.amount_ngn);
  if (oldAmount >= 0) {
    return { ok: false, error: 'Only payments that left the bank can be corrected here.' };
  }
  return { ok: true, row, oldPaidNgn: Math.abs(oldAmount) };
}

function correctionJournalLines(db, poId, treasuryAccountId, movementId, deltaPaidNgn) {
  const cash = ensureTreasuryCashGlAccount(db, treasuryAccountId);
  if (!cash.ok) throw new Error(cash.error || 'Treasury cash account is not on the GL.');
  ensureArchitecturalGlAccounts(db);
  if (deltaPaidNgn > 0) {
    const position = supplierCashPosition(db, poId);
    if (!position.ok) throw new Error(position.error);
    const settlementNgn = Math.min(deltaPaidNgn, position.stillOwedNgn);
    const advanceNgn = roundMoney(deltaPaidNgn - settlementNgn);
    if (advanceNgn > 0) ensureSupplierAdvanceGlAccount(db);
    const lines = [];
    if (settlementNgn > 0) lines.push({ accountCode: '2000', debitNgn: settlementNgn, memo: poId });
    if (advanceNgn > 0) lines.push({ accountCode: '1400', debitNgn: advanceNgn, memo: poId });
    lines.push({ accountCode: cash.accountCode, creditNgn: deltaPaidNgn, memo: movementId });
    return { lines, settlementNgn, advanceNgn, unwindAdvanceNgn: 0, unwindPayableNgn: 0 };
  }
  const reduceNgn = -deltaPaidNgn;
  const net1400 = Math.max(0, netGlForPoSupplierCash(db, poId, '1400'));
  const net2000 = Math.max(0, netGlForPoSupplierCash(db, poId, '2000'));
  let left = reduceNgn;
  const unwindAdvanceNgn = Math.min(left, net1400);
  left -= unwindAdvanceNgn;
  const unwindKnown = Math.min(left, net2000);
  left -= unwindKnown;
  const unwindPayableNgn = unwindKnown + left;
  if (unwindAdvanceNgn > 0) ensureSupplierAdvanceGlAccount(db);
  const lines = [{ accountCode: cash.accountCode, debitNgn: reduceNgn, memo: movementId }];
  if (unwindAdvanceNgn > 0) lines.push({ accountCode: '1400', creditNgn: unwindAdvanceNgn, memo: poId });
  if (unwindPayableNgn > 0) lines.push({ accountCode: '2000', creditNgn: unwindPayableNgn, memo: poId });
  return { lines, settlementNgn: 0, advanceNgn: 0, unwindAdvanceNgn, unwindPayableNgn };
}

/**
 * Restate one posted supplier payment to the amount that actually left the bank.
 * Cash, the purchase-order paid total, accounts payable, and the GL move by the difference only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {object} payload
 */
export function correctSupplierPaymentAmount(db, poId, payload = {}) {
  const position = supplierCashPosition(db, poId);
  if (!position.ok) return position;
  if (String(position.status).toLowerCase() === 'rejected') {
    return { ok: false, error: 'This purchase order is rejected.' };
  }
  const amountNgn = moneyInput(payload.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Enter the correct amount that left the bank.' };
  const note = String(payload.note || '').trim();
  if (note.length < 8) {
    return { ok: false, error: 'Enter a note explaining the correction (at least 8 characters).' };
  }
  const hqSettle = userMaySettleSupplierPayableFromHqRollup(payload.actor, payload.workspaceViewAll);
  if (!hqSettle) {
    const gate = assertEntityBranchForWorkspaceWrite(
      payload.actor,
      position.branchId,
      payload.workspaceBranchId,
      Boolean(payload.workspaceViewAll)
    );
    if (!gate.ok) return { ok: false, error: gate.error };
  }
  const loaded = loadEditablePayment(db, position.poId, payload.movementId);
  if (!loaded.ok) return loaded;
  if (amountNgn === loaded.oldPaidNgn) {
    return {
      ok: true,
      noOp: true,
      movementId: loaded.row.id,
      previousAmountNgn: loaded.oldPaidNgn,
      amountNgn,
      position,
    };
  }
  const day = String(loaded.row.posted_at_iso || '').slice(0, 10) || postingDay(payload);
  try {
    assertPeriodOpen(db, day, 'Supplier payment correction date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  try {
    let result = { ok: false };
    db.transaction(() => {
      const fresh = supplierCashPosition(db, position.poId);
      if (!fresh.ok) throw new Error(fresh.error);
      const current = loadEditablePayment(db, fresh.poId, payload.movementId);
      if (!current.ok) throw new Error(current.error);
      if (amountNgn === current.oldPaidNgn) {
        result = {
          ok: true,
          noOp: true,
          movementId: current.row.id,
          previousAmountNgn: current.oldPaidNgn,
          amountNgn,
          position: fresh,
        };
        return;
      }
      const deltaPaidNgn = roundMoney(amountNgn - current.oldPaidNgn);
      const nextPaid = roundMoney(fresh.supplierPaidNgn + deltaPaidNgn);
      if (nextPaid < 0) throw new Error('The corrected amount would take supplier paid below zero.');
      const split = correctionJournalLines(
        db,
        fresh.poId,
        Number(current.row.treasury_account_id),
        current.row.id,
        deltaPaidNgn
      );
      const account = db
        .prepare(`SELECT id, name, balance FROM treasury_accounts WHERE id = ?`)
        .get(current.row.treasury_account_id);
      if (!account) throw new Error('Treasury account not found.');
      // Restates cash that already left this account, so the book balance may go negative.
      db.prepare(`UPDATE treasury_accounts SET balance = ? WHERE id = ?`).run(
        roundMoney(account.balance) - deltaPaidNgn,
        account.id
      );
      db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = ? WHERE po_id = ?`).run(nextPaid, fresh.poId);
      const priorNote = String(current.row.note || '').trim();
      const mergedNote = priorNote
        ? `${priorNote} — Corrected from ₦${current.oldPaidNgn.toLocaleString('en-NG')} to ₦${amountNgn.toLocaleString('en-NG')}. ${note}`
        : `Corrected from ₦${current.oldPaidNgn.toLocaleString('en-NG')} to ₦${amountNgn.toLocaleString('en-NG')}. ${note}`;
      db.prepare(`UPDATE treasury_movements SET amount_ngn = ?, note = ? WHERE id = ?`).run(
        -amountNgn,
        mergedNote,
        current.row.id
      );
      db.prepare(`UPDATE purchase_payment_cashier_acks SET amount_ngn = ? WHERE treasury_movement_id = ?`).run(
        amountNgn,
        current.row.id
      );
      const likePrefix = `${String(current.row.id).replace(/[\\%_]/g, '\\$&')}:%`;
      const priorCorrections = db
        .prepare(
          `SELECT COUNT(*) AS c FROM gl_journal_entries
           WHERE source_kind = 'SUPPLIER_PAYMENT_CORRECTION_GL' AND source_id LIKE ? ESCAPE '\\'`
        )
        .get(likePrefix);
      const gl = postBalancedJournalTx(db, {
        entryDateISO: day,
        memo: `Correct supplier payment ${fresh.poId} from ${current.oldPaidNgn} to ${amountNgn}`,
        sourceKind: 'SUPPLIER_PAYMENT_CORRECTION_GL',
        sourceId: `${current.row.id}:${Number(priorCorrections?.c || 0) + 1}`,
        branchId: fresh.branchId,
        createdByUserId: payload.actor?.id ?? null,
        lines: split.lines,
      });
      const glError = rejectGl(gl);
      if (glError) throw new Error(glError);
      insertStockMovementTx(db, {
        id: nextStockMovementHumanId(db),
        type: 'PO_SUPPLIER_PAYMENT_CORRECTION',
        ref: fresh.poId,
        detail: `${current.row.id} ${current.oldPaidNgn} -> ${amountNgn}`,
        dateISO: day,
        branchId: fresh.branchId,
      });
      appendAuditLog(db, {
        actor: payload.actor,
        action: 'purchase_order.supplier_payment_correct',
        entityKind: 'purchase_order',
        entityId: fresh.poId,
        note,
        details: {
          movementId: current.row.id,
          previousAmountNgn: current.oldPaidNgn,
          amountNgn,
          deltaPaidNgn,
          settlementNgn: split.settlementNgn,
          advanceNgn: split.advanceNgn,
          unwindAdvanceNgn: split.unwindAdvanceNgn,
          unwindPayableNgn: split.unwindPayableNgn,
        },
      });
      syncAccountsPayableFromPurchaseOrder(db, fresh.poId);
      result = {
        ok: true,
        movementId: current.row.id,
        previousAmountNgn: current.oldPaidNgn,
        amountNgn,
        deltaPaidNgn,
        settlementNgn: split.settlementNgn,
        advanceNgn: split.advanceNgn,
        unwindAdvanceNgn: split.unwindAdvanceNgn,
        unwindPayableNgn: split.unwindPayableNgn,
        position: supplierCashPosition(db, fresh.poId),
      };
    })();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
