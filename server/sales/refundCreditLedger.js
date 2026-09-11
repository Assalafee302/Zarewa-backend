/**
 * Credit applied off a refund, read from the application ledger rather than the counter
 * cached on the refund row.
 *
 * Leaf module on purpose: the settlement maths, the approval gate and the apply path all
 * need this figure, and routing it through refundCreditApplyOps would put a cycle between
 * that module and controlOps.
 */
import { REFUND_CREDIT_REVERSED_STATUS } from '../../shared/lib/refundCreditApply.js';

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
           AND LOWER(TRIM(COALESCE(status, ''))) != ?`
      )
      .get(rid, REFUND_CREDIT_REVERSED_STATUS.toLowerCase());
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
           AND LOWER(TRIM(COALESCE(status, ''))) != ?
         GROUP BY refund_id`
      )
      .all(...ids, REFUND_CREDIT_REVERSED_STATUS.toLowerCase());
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
           AND LOWER(TRIM(COALESCE(status, ''))) != ?
         ORDER BY created_at_iso ASC`
      )
      .all(rid, REFUND_CREDIT_REVERSED_STATUS.toLowerCase());
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
