/**
 * Repair receipts finance-confirmed as new bank/cash while the same customer still had an
 * open overpayment refund on the payout queue (RF-KD-26-9693: ₦555,000 + ₦72,300 booked as
 * cash while ₦861,575 stayed payable).
 *
 * Only cross-job refund-backed fund is diverted — not the original overpay receipt, and not
 * a confirm where the cashier wrote why the cash was genuinely new.
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

function receiptSkippedRefundFundOnPurpose(db, receiptId) {
  const id = String(receiptId || '').trim();
  if (!id) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM audit_log
         WHERE entity_id = ? AND action = 'receipt.refund_fund_not_used'
         LIMIT 1`
      )
      .get(id);
    return Boolean(row);
  } catch {
    return false;
  }
}

function crossJobRefundSources(listed) {
  return (listed?.sources || []).filter(
    (s) =>
      s?.kind === 'refund' &&
      s?.sameQuotation !== true &&
      Math.round(Number(s?.availableNgn) || 0) > 0
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number, receiptIds?: string[], customerId?: string, afterIso?: string }} [opts]
 */
export function listReceiptsNeedingOverpayConfirmHeal(db, opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const onlyIds = Array.isArray(opts.receiptIds)
    ? opts.receiptIds.map((id) => String(id || '').trim()).filter(Boolean)
    : null;
  const customerFilter = String(opts.customerId || '').trim();
  const afterIso = String(opts.afterIso || '').trim();

  let rows;
  if (onlyIds?.length) {
    const ph = onlyIds.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT id, customer_id, quotation_ref, amount_ngn, bank_received_amount_ngn, status, date_iso,
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
      SELECT id, customer_id, quotation_ref, amount_ngn, bank_received_amount_ngn, status, date_iso,
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
    sql += ` ORDER BY date_iso ASC, id ASC LIMIT ${limit}`;
    rows = db.prepare(sql).all(...args);
  }
  if (onlyIds?.length) {
    rows = [...rows].sort((a, b) => {
      const da = String(a.date_iso || '');
      const dbIso = String(b.date_iso || '');
      if (da !== dbIso) return da.localeCompare(dbIso);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  /** @type {Array<object>} */
  const candidates = [];
  for (const row of rows) {
    const bank = roundMoney(row.bank_received_amount_ngn);
    if (!(bank > 0)) continue;
    const confirmedAt = String(row.finance_reconciliation_saved_at_iso || '').trim();
    if (afterIso && confirmedAt && confirmedAt < afterIso) continue;
    if (receiptSkippedRefundFundOnPurpose(db, row.id)) continue;

    const listed = listEligibleRefundCredits(db, row.customer_id, row.quotation_ref, {
      branchId: row.branch_id,
    });
    if (!listed?.ok || listed.targetBlocksExternalCredit) continue;
    const refundSources = crossJobRefundSources(listed);
    const availableNgn = refundSources.reduce((sum, s) => sum + roundMoney(s.availableNgn), 0);
    if (!(availableNgn > 0)) continue;
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
      availableNgn,
    });
    if (!(plan.offsetNgn > 0)) continue;

    const ordered = orderConfirmCreditSourcesForAutoOffset(db, row.customer_id, refundSources);

    candidates.push({
      receiptId: row.id,
      customerId: row.customer_id,
      quotationRef: row.quotation_ref,
      bankReceivedAmountNgn: bank,
      availableCreditNgn: availableNgn,
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
 * @param {{ dryRun?: boolean, afterIso?: string }} [opts]
 */
export function healReceiptOverpayConfirmTx(db, receiptId, actor = null, opts = {}) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const dryRun = Boolean(opts.dryRun);

  const [candidate] = listReceiptsNeedingOverpayConfirmHeal(db, {
    receiptIds: [id],
    afterIso: opts.afterIso,
  });
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
 * @param {{ dryRun?: boolean, limit?: number, receiptIds?: string[], customerId?: string, afterIso?: string }} [opts]
 */
export function healReceiptsNeedingOverpayConfirm(db, actor = null, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const candidates = listReceiptsNeedingOverpayConfirmHeal(db, opts);
  if (dryRun) {
    return { ok: true, dryRun: true, count: candidates.length, candidates };
  }
  const results = [];
  for (const c of candidates) {
    results.push(
      healReceiptOverpayConfirmTx(db, c.receiptId, actor, { dryRun: false, afterIso: opts.afterIso })
    );
  }
  return {
    ok: results.every((r) => r.ok),
    count: results.length,
    healed: results.filter((r) => r.ok).length,
    results,
  };
}
