/**
 * Heal receipts that were finance-confirmed as new bank/cash while the same customer still
 * had leftover overpayment (often held only by a staff-payee overpayment refund).
 *
 * Opt-in repair only — Confirm payment never auto-diverts. Cashier must tick the overpay /
 * refund fund on the confirm screen when that ₦ should cover the receipt.
 *
 * Re-runs unconfirm + confirm with an explicit refundCreditApply payload.
 */
import { planCashierRefundOffset, allocateRefundCreditAcrossSources } from '../../shared/lib/refundCreditApply.js';
import {
  listEligibleRefundCredits,
  orderConfirmCreditSourcesForAutoOffset,
} from '../refundCreditApplyOps.js';
import {
  patchSalesReceiptFinanceSettlement,
  unconfirmSalesReceiptFinanceClearance,
} from '../writeOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number, receiptIds?: string[], customerId?: string }} [opts]
 */
export function listReceiptsNeedingOverpayConfirmHeal(db, opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const onlyIds = Array.isArray(opts.receiptIds)
    ? opts.receiptIds.map((id) => String(id || '').trim()).filter(Boolean)
    : null;
  const customerFilter = String(opts.customerId || '').trim();

  let rows;
  if (onlyIds?.length) {
    const ph = onlyIds.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT id, customer_id, quotation_ref, amount_ngn, bank_received_amount_ngn, status,
                finance_reconciliation_saved_at_iso, finance_delivery_cleared_at_iso, branch_id
         FROM sales_receipts
         WHERE id IN (${ph})
           AND TRIM(LOWER(COALESCE(status, ''))) NOT IN ('reversed')
           AND bank_received_amount_ngn IS NOT NULL
           AND bank_received_amount_ngn > 0
           AND finance_reconciliation_saved_at_iso IS NOT NULL
           AND TRIM(finance_reconciliation_saved_at_iso) != ''`
      )
      .all(...onlyIds);
  } else {
    const args = [];
    let sql = `
      SELECT id, customer_id, quotation_ref, amount_ngn, bank_received_amount_ngn, status,
             finance_reconciliation_saved_at_iso, finance_delivery_cleared_at_iso, branch_id
      FROM sales_receipts
      WHERE TRIM(LOWER(COALESCE(status, ''))) NOT IN ('reversed')
        AND bank_received_amount_ngn IS NOT NULL
        AND bank_received_amount_ngn > 0
        AND finance_reconciliation_saved_at_iso IS NOT NULL
        AND TRIM(finance_reconciliation_saved_at_iso) != ''`;
    if (customerFilter) {
      sql += ` AND customer_id = ?`;
      args.push(customerFilter);
    }
    sql += ` ORDER BY date_iso DESC, id DESC LIMIT ${limit}`;
    rows = db.prepare(sql).all(...args);
  }

  /** @type {Array<object>} */
  const candidates = [];
  for (const row of rows) {
    const bank = roundMoney(row.bank_received_amount_ngn);
    if (!(bank > 0)) continue;
    const listed = listEligibleRefundCredits(db, row.customer_id, row.quotation_ref, {
      branchId: row.branch_id,
    });
    if (!listed?.ok || !(listed.totalAvailableNgn > 0)) continue;
    const prior = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE source_receipt_id = ?
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')`
      )
      .get(row.id);
    if (roundMoney(prior?.s) > 0) continue;

    const plan = planCashierRefundOffset({
      receiptCashNgn: bank,
      availableNgn: listed.totalAvailableNgn,
    });
    if (!(plan.offsetNgn > 0)) continue;

    const ordered = orderConfirmCreditSourcesForAutoOffset(
      db,
      row.customer_id,
      listed.sources || []
    );

    candidates.push({
      receiptId: row.id,
      customerId: row.customer_id,
      quotationRef: row.quotation_ref,
      bankReceivedAmountNgn: bank,
      availableCreditNgn: listed.totalAvailableNgn,
      offsetNgn: plan.offsetNgn,
      cashToConfirmNgn: plan.cashToConfirmNgn,
      clearForDelivery: Boolean(row.finance_delivery_cleared_at_iso),
      sources: ordered.map((s) => ({
        id: s.id,
        availableNgn: s.availableNgn,
        kind: s.kind,
        refundId: s.refundId || null,
        sourceQuotationRef: s.sourceQuotationRef || null,
      })),
    });
  }
  return candidates;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {object | null} actor
 * @param {{ dryRun?: boolean }} [opts]
 */
export function healReceiptOverpayConfirmTx(db, receiptId, actor = null, opts = {}) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const dryRun = Boolean(opts.dryRun);

  const [candidate] = listReceiptsNeedingOverpayConfirmHeal(db, { receiptIds: [id] });
  if (!candidate) {
    return { ok: false, code: 'NOT_NEEDED', error: 'Receipt does not need overpay confirm heal.' };
  }

  if (dryRun) {
    return { ok: true, dryRun: true, candidate };
  }

  const un = unconfirmSalesReceiptFinanceClearance(db, id, actor, {
    reason: `Heal (explicit): divert ₦${candidate.offsetNgn.toLocaleString('en-NG')} overpay credit instead of bank cash`,
  });
  if (!un.ok && un.code !== 'NOT_CONFIRMED') {
    return { ok: false, error: un.error || 'Unconfirm failed.', unconfirm: un };
  }

  const ordered = orderConfirmCreditSourcesForAutoOffset(
    db,
    candidate.customerId,
    candidate.sources || []
  );
  const { allocations } = allocateRefundCreditAcrossSources(ordered, candidate.offsetNgn);
  const sourceIds = allocations.map((a) => String(a.id || '').trim()).filter(Boolean);
  if (!sourceIds.length) {
    return { ok: false, error: 'No credit source ids to apply for heal.', candidate };
  }

  const settled = patchSalesReceiptFinanceSettlement(
    db,
    id,
    {
      bankReceivedAmountNgn: candidate.cashToConfirmNgn,
      clearForDelivery: candidate.clearForDelivery,
      refundCreditApply: {
        amountNgn: candidate.offsetNgn,
        sourceIds,
      },
    },
    actor
  );
  if (!settled.ok) {
    return { ok: false, error: settled.error || 'Resettle failed.', settled, unconfirm: un };
  }

  return {
    ok: true,
    receiptId: id,
    candidate,
    unconfirm: un,
    settled,
    refundCreditAppliedNgn: settled.refundCreditAppliedNgn || 0,
    explicitCreditSourceIds: sourceIds,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {{ dryRun?: boolean, limit?: number, receiptIds?: string[], customerId?: string }} [opts]
 */
export function healReceiptsNeedingOverpayConfirm(db, actor = null, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const candidates = listReceiptsNeedingOverpayConfirmHeal(db, opts);
  if (dryRun) {
    return { ok: true, dryRun: true, count: candidates.length, candidates };
  }
  const results = [];
  for (const c of candidates) {
    results.push(healReceiptOverpayConfirmTx(db, c.receiptId, actor, { dryRun: false }));
  }
  return {
    ok: results.every((r) => r.ok),
    count: results.length,
    healed: results.filter((r) => r.ok).length,
    results,
  };
}
