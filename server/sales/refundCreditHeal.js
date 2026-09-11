/**
 * Heal refund credit_applied when Confirm payment already spent reserved overpay
 * (RF-KD-26-9578: OVERPAY_REVERSAL on the quote but till queue still shows Still to pay).
 * No ledger writes — only customer_refunds bookkeeping + payout repair.
 */
import {
  REFUND_CREDIT_CONFIRMATION_STATUS,
  refundCreditOpenAmountFromStoredRefund,
  refundOverpayConsumedNgn,
} from '../../shared/lib/refundCreditApply.js';
import { quotationOverpaymentExcessNgn } from '../../shared/lib/refundQuotationMoney.js';
import { quotationPaymentCashBreakdownByRef } from '../quotationPaymentCash.js';
import { refundTreasuryPaidNgn } from '../refundCreditApplyOps.js';
import { refundCashOutstandingNgn, repairRefundPayoutStateTx } from './refundPayoutStatus.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function mapRefundRowShape(row) {
  let calculationLines = [];
  try {
    calculationLines = JSON.parse(row.calculation_lines_json || '[]');
  } catch {
    calculationLines = [];
  }
  return {
    refundID: row.refund_id,
    status: row.status,
    reasonCategory: row.reason_category,
    calculationLines,
    amountNgn: roundMoney(row.amount_ngn),
    approvedAmountNgn: roundMoney(row.approved_amount_ngn),
    paidAmountNgn: roundMoney(row.paid_amount_ngn),
    creditAppliedNgn: roundMoney(row.credit_applied_ngn),
    paidAtISO: row.paid_at_iso,
    paidBy: row.paid_by,
  };
}

/** Unlinked overpay apps that exceeded leftover capacity (spent refund-reserved cash). */
function unlinkedOverpayOvershootNgn(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return 0;
  const q = db.prepare(`SELECT id, total_ngn FROM quotations WHERE id = ?`).get(qid);
  if (!q) return 0;

  let unlinkedOut = 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE source_quotation_ref = ?
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')
           AND TRIM(IFNULL(refund_id, '')) = ''`
      )
      .get(qid);
    unlinkedOut = roundMoney(row?.s);
  } catch {
    return 0;
  }
  if (!(unlinkedOut > 0)) return 0;

  const cash = quotationPaymentCashBreakdownByRef(db, [qid]).get(qid);
  const economic = quotationOverpaymentExcessNgn({
    cashInNgn: cash?.cashInNgn || 0,
    quoteTotalNgn: q.total_ngn,
  });
  const refunds = db
    .prepare(
      `SELECT * FROM customer_refunds
       WHERE quotation_ref = ?
         AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
    )
    .all(qid);
  let refundOpen = 0;
  let refundConsumed = 0;
  for (const row of refunds) {
    refundOpen += refundCreditOpenAmountFromStoredRefund(row);
    refundConsumed += refundOverpayConsumedNgn(
      mapRefundRowShape(row),
      refundTreasuryPaidNgn(db, row.refund_id)
    );
  }
  const capacity = Math.max(0, economic - refundOpen - refundConsumed);
  return Math.max(0, unlinkedOut - capacity);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 */
export function healRefundCreditAppliedFromApplicationsTx(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return { ok: false, changed: false, error: 'refundId required' };

  const fresh = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
  if (!fresh) return { ok: false, changed: false, error: 'Refund not found.' };

  const status = String(fresh.status || '').trim();
  if (!['Approved', 'Partially paid', 'Paid', 'Pending'].includes(status)) {
    return { ok: true, changed: false };
  }

  let priorCredit = roundMoney(fresh.credit_applied_ngn);
  let nextCredit = priorCredit;
  let dest = String(fresh.credit_applied_to_quotation_ref || '').trim();

  try {
    const linkedSumRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE refund_id = ?
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')`
      )
      .get(rid);
    const linkedSum = roundMoney(linkedSumRow?.s);
    if (linkedSum > nextCredit) {
      nextCredit = linkedSum;
      const linkedDest = db
        .prepare(
          `SELECT target_quotation_ref AS t
           FROM refund_credit_applications
           WHERE refund_id = ?
             AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')
           ORDER BY created_at_iso DESC, application_id DESC
           LIMIT 1`
        )
        .get(rid);
      const t = String(linkedDest?.t || '').trim();
      if (t) dest = t;
    }
  } catch {
    /* applications table may be absent */
  }

  if (['Approved', 'Partially paid'].includes(status)) {
    const qref = String(fresh.quotation_ref || '').trim();
    if (qref) {
      const cashOut = refundCashOutstandingNgn(db, { ...fresh, credit_applied_ngn: nextCredit });
      if (cashOut > 0) {
        const overshoot = unlinkedOverpayOvershootNgn(db, qref);
        if (overshoot > 0) {
          const siblings = db
            .prepare(
              `SELECT * FROM customer_refunds
               WHERE quotation_ref = ?
                 AND LOWER(TRIM(COALESCE(status, ''))) IN ('approved', 'partially paid')
               ORDER BY requested_at_iso ASC, refund_id ASC`
            )
            .all(qref);
          let left = overshoot;
          for (const sib of siblings) {
            if (left <= 0) break;
            const sibCredit =
              String(sib.refund_id) === rid ? nextCredit : roundMoney(sib.credit_applied_ngn);
            const sibOpen = refundCashOutstandingNgn(db, { ...sib, credit_applied_ngn: sibCredit });
            const take = Math.min(left, sibOpen);
            if (take <= 0) continue;
            if (String(sib.refund_id) === rid) {
              nextCredit += take;
              if (!dest) {
                try {
                  const tgt = db
                    .prepare(
                      `SELECT target_quotation_ref AS t FROM refund_credit_applications
                       WHERE source_quotation_ref = ?
                         AND TRIM(IFNULL(refund_id, '')) = ''
                         AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('reversed', 'cancelled')
                       ORDER BY created_at_iso DESC LIMIT 1`
                    )
                    .get(qref);
                  dest = String(tgt?.t || '').trim();
                } catch {
                  /* ignore */
                }
              }
            }
            left -= take;
          }
        }
      }
    }
  }

  const delta = nextCredit - priorCredit;
  if (!(delta > 0)) {
    return { ok: true, changed: false, creditAppliedNgn: priorCredit };
  }

  const paidFresh = roundMoney(fresh.paid_amount_ngn);
  const approvedFresh =
    roundMoney(fresh.approved_amount_ngn) ||
    (status === 'Approved' || status === 'Partially paid' || status === 'Paid'
      ? roundMoney(fresh.amount_ngn)
      : 0);
  const nextPaid = paidFresh + delta;
  const nextStatus = approvedFresh > 0 && nextPaid >= approvedFresh ? 'Paid' : status === 'Pending' ? 'Pending' : 'Approved';
  const noteBit = `${REFUND_CREDIT_CONFIRMATION_STATUS}: ₦${delta.toLocaleString('en-NG')} applied to ${
    dest || 'prior receipt'
  } (healed from prior Confirm payment)`;
  const prevNote = String(fresh.payment_note || '').trim();
  const paymentNote = prevNote.includes(noteBit) ? prevNote : prevNote ? `${prevNote} · ${noteBit}` : noteBit;
  const atIso = new Date().toISOString();

  const paidAtOut =
    String(fresh.paid_at_iso || '').trim() ||
    (nextStatus === 'Paid' || status === 'Partially paid' ? atIso : '');

  db.prepare(
    `UPDATE customer_refunds
     SET status = ?,
         approved_amount_ngn = ?,
         paid_amount_ngn = ?,
         paid_at_iso = ?,
         paid_by = CASE WHEN TRIM(IFNULL(paid_by, '')) = '' THEN ? ELSE paid_by END,
         payment_note = ?,
         credit_applied_ngn = ?,
         credit_applied_to_quotation_ref = ?,
         credit_confirmation_status = ?
     WHERE refund_id = ?`
  ).run(
    nextStatus,
    approvedFresh || roundMoney(fresh.approved_amount_ngn),
    nextPaid,
    paidAtOut,
    'System',
    paymentNote,
    nextCredit,
    dest || fresh.credit_applied_to_quotation_ref || null,
    REFUND_CREDIT_CONFIRMATION_STATUS,
    rid
  );

  repairRefundPayoutStateTx(db, rid);

  const after = db
    .prepare(`SELECT status, paid_amount_ngn, credit_applied_ngn FROM customer_refunds WHERE refund_id = ?`)
    .get(rid);
  return {
    ok: true,
    changed: true,
    creditAppliedNgn: roundMoney(after?.credit_applied_ngn),
    status: after?.status || null,
    paidAmountNgn: roundMoney(after?.paid_amount_ngn),
  };
}
