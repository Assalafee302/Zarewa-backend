/**
 * Credit applied off a refund, read from the application ledger rather than the counter
 * cached on the refund row.
 *
 * Leaf module on purpose: the settlement maths, the approval gate and the apply path all
 * need this figure, and routing it through refundCreditApplyOps would put a cycle between
 * that module and controlOps.
 */
import {
  REFUND_CREDIT_PAYEE_APPLY_SQL,
  refundAbsorbsQuoteToQuoteOverpay,
  refundCreditOpenAmountFromStoredRefund,
  refundOverpayConsumedNgn,
} from '../../shared/lib/refundCreditApply.js';
import { quotationOverpaymentExcessNgn } from '../../shared/lib/refundQuotationMoney.js';
import { quotationPaymentCashBreakdownByRef } from '../quotationPaymentCash.js';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * Refunds already reported as drifted this process.
 *
 * A mismatch is a property of the row, not of the request, so re-reporting it every time
 * a desk list is rebuilt turns a useful signal into hundreds of identical lines per poll.
 * One line per refund per process is enough to find them; the set resets on restart.
 */
const warnedRefundIds = new Set();

/** @param {string} refundId @param {number} stored @param {number} ledger */
function warnMismatchOnce(refundId, stored, ledger) {
  if (warnedRefundIds.has(refundId)) return;
  warnedRefundIds.add(refundId);
  console.warn(
    `[zarewa] refund ${refundId} credit mismatch — counter ₦${stored}, applications ₦${ledger}; settling on ₦${Math.max(stored, ledger)}`
  );
}

/**
 * Sum of live credit applications against this refund.
 *
 * The counterpart to refundTreasuryPaidNgn: derived from history on every read, so it
 * cannot drift the way a hand-maintained counter does. Reversal is a status change on the
 * original application rather than a compensating insert, so reversed rows are excluded
 * rather than netted out.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 */
export function refundCreditAppliedNgn(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE refund_id = ?
           AND ${REFUND_CREDIT_PAYEE_APPLY_SQL}`
      )
      .get(rid);
    return Math.max(0, roundMoney(row?.s));
  } catch {
    // Table or column missing on this host (migration pending) — caller falls back to
    // the stored counter, which is what shipped before this module existed.
    return 0;
  }
}

/**
 * Live credit totals for many refunds in one query.
 *
 * The single-refund form is a per-row query, and the refund list mapper runs once per
 * row — so calling it from a list turns one request into hundreds on a database layer
 * that serializes them. List callers batch here and hand the map down, the way the
 * payout-history and wallet lookups beside it already do.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} refundIds
 * @returns {Map<string, number>}
 */
export function refundCreditAppliedByIds(db, refundIds) {
  const ids = [...new Set((refundIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const ph = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT refund_id, COALESCE(SUM(amount_ngn), 0) AS s
         FROM refund_credit_applications
         WHERE refund_id IN (${ph})
           AND ${REFUND_CREDIT_PAYEE_APPLY_SQL}
         GROUP BY refund_id`
      )
      .all(...ids);
    for (const row of rows) {
      map.set(String(row.refund_id), Math.max(0, roundMoney(row.s)));
    }
  } catch {
    // Table missing on this host — callers fall back to the stored counter per row.
  }
  return map;
}

/**
 * Every quotation this refund's credit went to, oldest first.
 *
 * `customer_refunds.credit_applied_to_quotation_ref` holds one ref and is overwritten by
 * each apply, so a refund split across two jobs names only the second. The applications
 * table has held the full list all along.
 *
 * Deliberately not used in list mappers — one query per row would be N+1 on a desk pack.
 * For a single refund being approved, reviewed, or disputed, it is the honest answer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @returns {string[]}
 */
export function refundCreditTargetsFor(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return [];
  try {
    const rows = db
      .prepare(
        `SELECT target_quotation_ref FROM refund_credit_applications
         WHERE refund_id = ?
           AND ${REFUND_CREDIT_PAYEE_APPLY_SQL}
         ORDER BY created_at_iso ASC`
      )
      .all(rid);
    const seen = [];
    for (const r of rows) {
      const ref = String(r?.target_quotation_ref || '').trim();
      if (ref && !seen.includes(ref)) seen.push(ref);
    }
    return seen;
  } catch {
    return [];
  }
}

/**
 * Credit that has discharged this refund, trusting whichever record is higher.
 *
 * Not every stamp writes an application row — the leftover-overpay path bumps the counter
 * directly — so the ledger alone would understate historical credit and the till would pay
 * that money out a second time. Equally a lost counter update (two applies racing on the
 * same refund across workers) leaves the counter short while both application rows land.
 * Either record showing credit means credit moved, so the higher of the two is the figure
 * to settle against.
 *
 * Divergence is logged rather than absorbed silently: it means one of the two writers
 * missed, and the pair is meant to agree.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row a customer_refunds row, snake or camel case
 */
function refundRowForOverpayConsumed(row) {
  let calculationLines = row?.calculationLines;
  if (!Array.isArray(calculationLines)) {
    try {
      calculationLines = JSON.parse(String(row?.calculation_lines_json || '[]'));
    } catch {
      calculationLines = [];
    }
  }
  return {
    ...row,
    reasonCategory: row?.reasonCategory ?? row?.reason_category,
    calculationLines,
    amountNgn: row?.amountNgn ?? row?.amount_ngn,
    paidAmountNgn: row?.paidAmountNgn ?? row?.paid_amount_ngn,
    paidAtISO: row?.paidAtISO ?? row?.paid_at_iso,
    paidBy: row?.paidBy ?? row?.paid_by,
  };
}

function treasuryPaidNgn(db, refundId) {
  const rid = String(refundId || '').trim();
  if (!rid) return 0;
  try {
    const row = db
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
      .get(rid);
    return Math.max(0, roundMoney(row?.s));
  } catch {
    return 0;
  }
}

/**
 * Unlinked confirm-payment credit on this quotation that spent cash an open refund still
 * shows as payable. Genuine leftover beyond the refund open is not included.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
function unlinkedOverpayOvershootNgn(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return 0;
  let q;
  try {
    q = db.prepare(`SELECT id, total_ngn FROM quotations WHERE id = ?`).get(qid);
  } catch {
    return 0;
  }
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

  let economic = 0;
  try {
    const cash = quotationPaymentCashBreakdownByRef(db, [qid]).get(qid);
    economic = quotationOverpaymentExcessNgn({
      cashInNgn: cash?.cashInNgn || 0,
      quoteTotalNgn: q.total_ngn,
    });
  } catch {
    economic = 0;
  }

  let refundOpen = 0;
  let refundConsumed = 0;
  try {
    const refunds = db
      .prepare(
        `SELECT * FROM customer_refunds
         WHERE quotation_ref = ?
           AND TRIM(COALESCE(LOWER(status), '')) NOT IN ('rejected', 'cancelled')`
      )
      .all(qid);
    for (const row of refunds) {
      refundOpen += refundCreditOpenAmountFromStoredRefund(row);
      refundConsumed += refundOverpayConsumedNgn(
        refundRowForOverpayConsumed(row),
        treasuryPaidNgn(db, row.refund_id)
      );
    }
  } catch {
    return 0;
  }
  const capacity = Math.max(0, economic - refundOpen - refundConsumed);
  return Math.max(0, unlinkedOut - capacity);
}

function openPayoutBeforeUnlinkedNgn(db, row) {
  const approved = Math.max(
    0,
    roundMoney(row?.approved_amount_ngn ?? row?.approvedAmountNgn ?? row?.amount_ngn ?? row?.amountNgn)
  );
  const stored = Math.max(0, roundMoney(row?.credit_applied_ngn ?? row?.creditAppliedNgn));
  const linked = refundCreditAppliedNgn(db, row?.refund_id || row?.refundID);
  const credit = Math.max(stored, linked);
  const treasury = treasuryPaidNgn(db, row?.refund_id || row?.refundID);
  return Math.max(0, approved - treasury - credit);
}

/**
 * How much unlinked receipt credit should come off each open refund, oldest first.
 * Empty when nothing on the page needs it. Safe to call once per list.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Map<string, number>}
 */
export function unlinkedReceiptCreditByRefundId(db, rows) {
  const map = new Map();
  const quotes = new Set();
  for (const row of rows || []) {
    const status = String(row?.status || '').trim();
    if (status !== 'Approved' && status !== 'Partially paid') continue;
    const qref = String(row?.quotation_ref || row?.quotationRef || '').trim();
    if (qref) quotes.add(qref);
  }
  for (const qref of quotes) {
    const overshoot = unlinkedOverpayOvershootNgn(db, qref);
    if (!(overshoot > 0)) continue;
    let siblings = [];
    try {
      siblings = db
        .prepare(
          `SELECT * FROM customer_refunds
           WHERE quotation_ref = ?
             AND LOWER(TRIM(COALESCE(status, ''))) IN ('approved', 'partially paid')
           ORDER BY requested_at_iso ASC, refund_id ASC`
        )
        .all(qref);
    } catch {
      siblings = [];
    }
    let left = overshoot;
    for (const sib of siblings) {
      if (left <= 0) break;
      if (!refundAbsorbsQuoteToQuoteOverpay(sib)) continue;
      const open = openPayoutBeforeUnlinkedNgn(db, sib);
      const take = Math.min(left, open);
      if (take > 0) map.set(String(sib.refund_id), take);
      left -= take;
    }
  }
  return map;
}

/** Unlinked receipt credit that should reduce this one refund's payout. */
export function unlinkedReceiptCreditAttributedNgn(db, row) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  if (!refundId) return 0;
  const status = String(row?.status || '').trim();
  if (status !== 'Approved' && status !== 'Partially paid') return 0;
  return unlinkedReceiptCreditByRefundId(db, [row]).get(refundId) || 0;
}

export function refundCreditSettledNgn(db, row, ledgerByRefundId = null) {
  const refundId = String(row?.refund_id || row?.refundID || '').trim();
  const stored = Math.max(0, roundMoney(row?.credit_applied_ngn ?? row?.creditAppliedNgn));
  if (!refundId) return stored;
  // A caller walking a list passes the batched map; a caller holding one refund does not.
  const ledger = ledgerByRefundId
    ? Math.max(0, roundMoney(ledgerByRefundId.get(refundId)))
    : refundCreditAppliedNgn(db, refundId);
  if (ledger !== stored) warnMismatchOnce(refundId, stored, ledger);
  return Math.max(stored, ledger);
}
