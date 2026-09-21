/**
 * When till/bank payout of an overpayment refund is blocked because that quote's overpayment
 * was already used elsewhere, free residual so the bank payout can post:
 * 1) reverse Confirm-payment credit applications from the source quotation
 * 2) cancel other unpaid Pending/Approved overpayment refunds that still reserve the same cash
 *
 * Does not cancel refunds that already paid till/wallet/credit to a payee.
 */
import {
  listActiveRefundCreditApplicationsBySourceQuotation,
  reverseRefundCreditApplication,
} from '../refundCreditApplyOps.js';
import {
  overpaymentAlreadyRefundedNgn,
  overpaymentReservedOnRefund,
  quotationOverpaymentResidualNgn,
} from '../../shared/lib/refundQuotationMoney.js';
import {
  appendAuditLog,
  quotationCashInNgn,
  quotationUnlinkedOverpayCreditOutNgn,
} from '../controlOps.js';
import { voidPartnerWalletCreditsForRefundTx } from '../finance/partnerWalletCredit.js';
import { voidCompanyRetentionForRefundTx } from '../finance/refundCompanyRetentionLedger.js';

function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

/**
 * True payee cash already left the business for this refund (till/bank or wallet withdraw).
 * Confirm-payment / refund-fund credit is NOT counted here — those apps are reversed during
 * overpay pay release; counting them blocked auto-cancel of competing unpaid refunds.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 */
function refundPayeeSettledNgn(db, row) {
  const refundId = String(row?.refund_id || '').trim();
  if (!refundId) return 0;
  let treasury = 0;
  try {
    const t = db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN type = 'REFUND_PAYOUT' THEN ABS(amount_ngn)
             WHEN type = 'REFUND_PAYOUT_REVERSAL_IN' THEN -ABS(amount_ngn)
             ELSE 0
           END
         ), 0) AS s
         FROM treasury_movements
         WHERE source_kind = 'REFUND' AND source_id = ?`
      )
      .get(refundId);
    treasury = roundMoney(t?.s);
  } catch {
    treasury = 0;
  }
  let walletWithdrawn = 0;
  try {
    const w = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM partner_wallet_withdrawal_allocations
         WHERE refund_id = ?`
      )
      .get(refundId);
    walletWithdrawn = roundMoney(w?.s);
  } catch {
    walletWithdrawn = 0;
  }
  return Math.max(0, treasury + walletWithdrawn);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} excludeRefundId
 */
export function quotationOverpayResidualExcludingRefund(db, quotationRef, excludeRefundId) {
  const qref = String(quotationRef || '').trim();
  const exclude = String(excludeRefundId || '').trim();
  if (!qref) return 0;
  const others = db
    .prepare(
      `SELECT * FROM customer_refunds
       WHERE quotation_ref = ?
         AND refund_id != ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
    )
    .all(qref, exclude);
  return quotationOverpaymentResidualNgn({
    cashInNgn: quotationCashInNgn(db, qref),
    quoteTotalNgn: roundMoney(
      db.prepare(`SELECT total_ngn FROM quotations WHERE id = ?`).get(qref)?.total_ngn
    ),
    overpaymentAlreadyRefundedNgn: overpaymentAlreadyRefundedNgn(others),
    creditAppliedOutNgn: quotationUnlinkedOverpayCreditOutNgn(db, qref),
  });
}

/**
 * Other unpaid overpayment refunds that still reserve cash on this quote (block till pay).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {string} excludeRefundId
 */
export function listCancelableConflictingOverpayRefunds(db, quotationRef, excludeRefundId) {
  const qref = String(quotationRef || '').trim();
  const exclude = String(excludeRefundId || '').trim();
  if (!qref) return [];
  const rows = db
    .prepare(
      `SELECT * FROM customer_refunds
       WHERE quotation_ref = ?
         AND refund_id != ?
         AND TRIM(COALESCE(LOWER(status), '')) IN ('pending', 'approved')`
    )
    .all(qref, exclude || '');
  const out = [];
  for (const row of rows) {
    const reserved = overpaymentReservedOnRefund(row);
    if (reserved <= 0) continue;
    if (refundPayeeSettledNgn(db, row) > 0) continue;
    out.push({
      refundId: String(row.refund_id || '').trim(),
      status: String(row.status || '').trim(),
      reservedOverpayNgn: reserved,
      amountNgn: roundMoney(row.approved_amount_ngn || row.amount_ngn),
    });
  }
  return out.sort((a, b) => b.reservedOverpayNgn - a.reservedOverpayNgn);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 * @param {{ actor?: object, note?: string, payingRefundId?: string }} opts
 */
function cancelUnpaidOverpayRefundForPayout(db, row, opts = {}) {
  const refundId = String(row?.refund_id || '').trim();
  const status = String(row?.status || '').trim();
  const statusLower = status.toLowerCase();
  if (!refundId) return { ok: false, error: 'Refund id required.' };
  if (statusLower !== 'approved' && statusLower !== 'pending') {
    return { ok: false, error: `Refund ${refundId} is ${status || 'unknown'} — cannot auto-cancel.` };
  }
  const settled = refundPayeeSettledNgn(db, row);
  if (settled > 0) {
    return {
      ok: false,
      error: `Refund ${refundId} already has payee money out and cannot be auto-cancelled.`,
      code: 'REFUND_ALREADY_SETTLED',
    };
  }
  const payingRefundId = String(opts.payingRefundId || '').trim();
  const note =
    String(opts.note || '').trim() ||
    (payingRefundId
      ? `Auto-cancelled so ${payingRefundId} can pay from till/bank`
      : 'Auto-cancelled for overpayment till/bank payout');

  const voided = voidPartnerWalletCreditsForRefundTx(db, refundId);
  if (!voided.ok) {
    return { ok: false, error: voided.error || `Could not void partner wallet for ${refundId}.` };
  }
  if (voided.skipped) {
    const retentionVoid = voidCompanyRetentionForRefundTx(db, refundId);
    if (!retentionVoid.ok) {
      return {
        ok: false,
        error: retentionVoid.error || `Could not void company retention for ${refundId}.`,
      };
    }
  }

  db.prepare(
    `UPDATE customer_refunds
     SET status = 'Cancelled',
         manager_comments = ?,
         paid_amount_ngn = 0,
         paid_at_iso = '',
         paid_by = '',
         payment_note = ''
     WHERE refund_id = ?`
  ).run(note, refundId);

  appendAuditLog(db, {
    actor: opts.actor,
    action: 'refund.cancel_for_overpay_payout',
    entityKind: 'refund',
    entityId: refundId,
    note,
    details: {
      previousStatus: status,
      payingRefundId: payingRefundId || null,
      reservedOverpayNgn: overpaymentReservedOnRefund(row),
    },
  });

  return {
    ok: true,
    refundId,
    previousStatus: status,
    reservedOverpayNgn: overpaymentReservedOnRefund(row),
  };
}

/**
 * Reverse confirm-payment credit and cancel conflicting unpaid overpay refunds until residual covers need.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   sourceQuotationRef: string,
 *   excludeRefundId: string,
 *   needResidualNgn: number,
 *   actor?: object,
 *   dateISO?: string,
 *   note?: string,
 *   payingRefundId?: string,
 * }} opts
 */
export function releaseSourceQuoteOverpayCreditsForPayout(db, opts = {}) {
  const sourceQuotationRef = String(opts.sourceQuotationRef || '').trim();
  const excludeRefundId = String(opts.excludeRefundId || '').trim();
  const needResidualNgn = roundMoney(opts.needResidualNgn);
  if (!sourceQuotationRef) {
    return { ok: false, error: 'sourceQuotationRef is required.' };
  }
  if (needResidualNgn <= 0) {
    return {
      ok: true,
      reversed: [],
      cancelledRefunds: [],
      residualNgn: quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId),
    };
  }

  let residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
  if (residual >= needResidualNgn) {
    return { ok: true, reversed: [], cancelledRefunds: [], residualNgn: residual };
  }

  const payingRefundId = String(opts.payingRefundId || excludeRefundId || '').trim();
  const noteBit =
    String(opts.note || '').trim() ||
    (payingRefundId
      ? `Auto-released so ${payingRefundId} can pay from till/bank`
      : 'Auto-released for overpayment refund till/bank payout');
  const dateISO = String(opts.dateISO || '').trim().slice(0, 10) || undefined;
  const reversed = [];
  const cancelledRefunds = [];

  const apps = listActiveRefundCreditApplicationsBySourceQuotation(db, sourceQuotationRef).filter(
    (app) => String(app.refundId || app.refund_id || '').trim() !== payingRefundId
  );
  for (const app of apps) {
    residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
    if (residual >= needResidualNgn) break;

    const rev = reverseRefundCreditApplication(db, app.applicationId, {
      actor: opts.actor,
      note: noteBit,
      dateISO,
      releasedForRefundId: payingRefundId || undefined,
      reverseReason: payingRefundId
        ? `Confirm-payment credit of ₦${roundMoney(app.amountNgn).toLocaleString('en-NG')} on ${String(app.targetQuotationRef || '').trim() || 'quotation'} was released so overpayment refund ${payingRefundId} could be paid from till/bank. Re-confirm bank/cash on this quotation if the customer still owes.`
        : noteBit,
    });
    if (!rev.ok && rev.code !== 'ALREADY_REVERSED') {
      return {
        ok: false,
        error: rev.error || `Could not reverse credit apply ${app.applicationId}.`,
        code: rev.code || 'REFUND_CREDIT_REVERSE_FAILED',
        reversed,
        cancelledRefunds,
      };
    }
    if (rev.ok) {
      reversed.push({
        applicationId: app.applicationId,
        amountNgn: roundMoney(app.amountNgn || rev.amountNgn),
        targetQuotationRef: app.targetQuotationRef || rev.targetQuotationRef || null,
        sourceReceiptId: app.sourceReceiptId || null,
        refundId: app.refundId || rev.refundId || null,
        releasedForRefundId: rev.releasedForRefundId || payingRefundId || null,
        reverseReason: rev.reverseReason || noteBit || null,
      });
    }
  }

  residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
  if (residual < needResidualNgn) {
    const conflicting = listCancelableConflictingOverpayRefunds(db, sourceQuotationRef, excludeRefundId);
    for (const conflict of conflicting) {
      residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
      if (residual >= needResidualNgn) break;

      const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(conflict.refundId);
      if (!row) continue;
      const cancelled = cancelUnpaidOverpayRefundForPayout(db, row, {
        actor: opts.actor,
        payingRefundId,
        note:
          String(opts.note || '').trim() ||
          `Auto-cancelled unpaid overpayment refund so ${payingRefundId || 'till/bank payout'} can post`,
      });
      if (!cancelled.ok) {
        return {
          ok: false,
          error: cancelled.error || `Could not cancel conflicting refund ${conflict.refundId}.`,
          code: cancelled.code || 'REFUND_CONFLICT_CANCEL_FAILED',
          reversed,
          cancelledRefunds,
        };
      }
      cancelledRefunds.push({
        refundId: cancelled.refundId,
        previousStatus: cancelled.previousStatus,
        reservedOverpayNgn: conflict.reservedOverpayNgn,
      });
    }
  }

  residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
  return {
    ok: true,
    reversed,
    cancelledRefunds,
    residualNgn: residual,
    shortfallNgn: Math.max(0, needResidualNgn - residual),
  };
}

/**
 * Shape for API / settlement UI when pay is still blocked after (or without) credit release.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sourceQuotationRef
 * @param {number} residualNgn
 * @param {number} overpayClaimNgn — overpayment portion that must fit residual (not full multi-reason payout)
 * @param {string} [excludeRefundId]
 */
export function overpayPayoutSettledErrorPayload(
  db,
  sourceQuotationRef,
  residualNgn,
  overpayClaimNgn,
  excludeRefundId = ''
) {
  const residual = roundMoney(residualNgn);
  const claim = roundMoney(overpayClaimNgn);
  const apps = listActiveRefundCreditApplicationsBySourceQuotation(db, sourceQuotationRef);
  const conflicting = listCancelableConflictingOverpayRefunds(
    db,
    sourceQuotationRef,
    excludeRefundId
  );
  const qref = String(sourceQuotationRef || '').trim();
  const cashInNgn = qref ? quotationCashInNgn(db, qref) : 0;
  const quoteTotalNgn = qref
    ? roundMoney(db.prepare(`SELECT total_ngn FROM quotations WHERE id = ?`).get(qref)?.total_ngn)
    : 0;
  const excessNgn = Math.max(0, cashInNgn - quoteTotalNgn);
  return {
    ok: false,
    code: 'REFUND_OVERPAYMENT_ALREADY_SETTLED',
    error:
      excessNgn > 0 && claim > excessNgn
        ? `This quotation only has ₦${excessNgn.toLocaleString('en-NG')} cash above the quote total (cash in ₦${cashInNgn.toLocaleString('en-NG')} − quote ₦${quoteTotalNgn.toLocaleString('en-NG')}). Cannot pay ₦${claim.toLocaleString('en-NG')} as overpayment.`
        : residual <= 0
          ? 'Overpayment on this quotation is already fully refunded. Paying this would double-pay the customer.'
          : `Only ₦${residual.toLocaleString('en-NG')} overpayment remains after prior refunds on this quotation.`,
    overpaymentResidualNgn: residual,
    overpaymentExcessNgn: excessNgn,
    cashInNgn,
    quoteTotalNgn,
    payoutAmountNgn: claim,
    releasableCreditApplications: apps,
    cancelableConflictingRefunds: conflicting,
    hint:
      apps.length > 0 || conflicting.length > 0
        ? 'Retry pay — the system will undo confirm-payment credit and cancel other unpaid overpayment refunds on this quotation first, then post till/bank.'
        : excessNgn > 0 && claim > excessNgn
          ? 'Reduce the Overpayment line to the true excess, or cancel this refund if the customer was already paid outside the ERP.'
          : 'Another refund on this quotation already paid out this overpayment. Cancel this approved refund if the customer was already paid another way.',
  };
}
