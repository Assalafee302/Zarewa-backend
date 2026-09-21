/**
 * When till/bank payout of an overpayment refund is blocked because that quote's overpayment
 * was already used to confirm another receipt (refund credit apply), reverse those applies
 * so residual reopens and the bank payout can post.
 *
 * Does not cancel other refunds — only reverses active refund_credit_applications from the
 * source quotation. If other refunds still consume residual after reverse, pay stays blocked.
 */
import {
  listActiveRefundCreditApplicationsBySourceQuotation,
  reverseRefundCreditApplication,
} from '../refundCreditApplyOps.js';
import {
  overpaymentAlreadyRefundedNgn,
  quotationOverpaymentResidualNgn,
} from '../../shared/lib/refundQuotationMoney.js';
import { quotationCashInNgn, quotationUnlinkedOverpayCreditOutNgn } from '../controlOps.js';

function roundMoney(v) {
  return Math.round(Number(v) || 0);
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
 * Reverse active credit applications from this source quote until residual covers needNgn
 * (or all apps are reversed). Newest applications first.
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
    return { ok: true, reversed: [], residualNgn: quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId) };
  }

  let residual = quotationOverpayResidualExcludingRefund(db, sourceQuotationRef, excludeRefundId);
  if (residual >= needResidualNgn) {
    return { ok: true, reversed: [], residualNgn: residual };
  }

  const apps = listActiveRefundCreditApplicationsBySourceQuotation(db, sourceQuotationRef);
  if (!apps.length) {
    return {
      ok: true,
      reversed: [],
      residualNgn: residual,
      shortfallNgn: Math.max(0, needResidualNgn - residual),
    };
  }

  const payingRefundId = String(opts.payingRefundId || excludeRefundId || '').trim();
  const noteBit =
    String(opts.note || '').trim() ||
    (payingRefundId
      ? `Auto-released so ${payingRefundId} can pay from till/bank`
      : 'Auto-released for overpayment refund till/bank payout');
  const dateISO = String(opts.dateISO || '').trim().slice(0, 10) || undefined;
  const reversed = [];

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
  return {
    ok: true,
    reversed,
    residualNgn: residual,
    shortfallNgn: Math.max(0, needResidualNgn - residual),
  };
}

/**
 * Shape for API / settlement UI when pay is still blocked after (or without) credit release.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sourceQuotationRef
 * @param {number} residualNgn
 * @param {number} payoutAmountNgn
 */
export function overpayPayoutSettledErrorPayload(db, sourceQuotationRef, residualNgn, payoutAmountNgn) {
  const residual = roundMoney(residualNgn);
  const payout = roundMoney(payoutAmountNgn);
  const apps = listActiveRefundCreditApplicationsBySourceQuotation(db, sourceQuotationRef);
  return {
    ok: false,
    code: 'REFUND_OVERPAYMENT_ALREADY_SETTLED',
    error:
      residual <= 0
        ? 'Overpayment on this quotation is already fully refunded. Paying this would double-pay the customer.'
        : `Only ₦${residual.toLocaleString('en-NG')} overpayment remains after prior refunds on this quotation.`,
    overpaymentResidualNgn: residual,
    payoutAmountNgn: payout,
    releasableCreditApplications: apps,
    hint:
      apps.length > 0
        ? 'Overpayment was used to confirm another receipt. Retry pay — the system will undo those confirmations first, then post till/bank.'
        : 'Cancel conflicting overpayment refunds on this quotation, or cancel this approved refund if the customer was already paid another way.',
  };
}
