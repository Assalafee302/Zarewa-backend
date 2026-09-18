/**
 * Read-side branch refund lock window — quotations and receipts in the date range
 * are not refundable. No controlOps import (used from refund create/eligibility).
 */
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import {
  branchHasRefundLockWindow,
  formatBranchRefundsFrozenError,
  quotationHitsBranchRefundLockWindow,
} from '../../shared/lib/branchRefundFreeze.js';

function freezeColumnsReady(db) {
  return hasColumn(db, 'branches', 'refunds_blocked_from_iso');
}

function toColumnReady(db) {
  return hasColumn(db, 'branches', 'refunds_blocked_to_iso');
}

function mapFreezeRow(row, hasTo) {
  const toIso = hasTo ? row.refunds_blocked_to_iso || null : null;
  return {
    branchId: row.id,
    name: row.name,
    refundsBlockedFromISO: row.refunds_blocked_from_iso || null,
    refundsBlockedToISO: toIso,
    refundsBlockedReason: row.refunds_blocked_reason || '',
    refundsBlockedByUserId: row.refunds_blocked_by_user_id || null,
    refundsBlockedByName: row.refunds_blocked_by_name || '',
    refundsBlockedSetAtISO: row.refunds_blocked_set_at_iso || null,
    refunds_blocked_from_iso: row.refunds_blocked_from_iso || null,
    refunds_blocked_to_iso: toIso,
    refunds_blocked_reason: row.refunds_blocked_reason || '',
    frozen: branchHasRefundLockWindow(row),
  };
}

function emptyFreeze(row) {
  return {
    branchId: row.id,
    name: row.name,
    refundsBlockedFromISO: null,
    refundsBlockedToISO: null,
    refundsBlockedReason: '',
    refundsBlockedByUserId: null,
    refundsBlockedByName: '',
    refundsBlockedSetAtISO: null,
    refunds_blocked_from_iso: null,
    refunds_blocked_to_iso: null,
    refunds_blocked_reason: '',
    frozen: false,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function loadBranchRefundFreeze(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return null;
  if (!freezeColumnsReady(db)) {
    const row = db.prepare(`SELECT id, name FROM branches WHERE id = ?`).get(bid);
    return row ? emptyFreeze(row) : null;
  }
  const hasTo = toColumnReady(db);
  const toSql = hasTo ? ', refunds_blocked_to_iso' : '';
  const row = db
    .prepare(
      `SELECT id, name, refunds_blocked_from_iso, refunds_blocked_reason,
              refunds_blocked_by_user_id, refunds_blocked_by_name, refunds_blocked_set_at_iso
              ${toSql}
       FROM branches WHERE id = ?`
    )
    .get(bid);
  if (!row) return null;
  return mapFreezeRow(row, hasTo);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, ReturnType<typeof loadBranchRefundFreeze>>}
 */
export function loadAllBranchRefundLocks(db) {
  const out = new Map();
  if (!freezeColumnsReady(db)) return out;
  const hasTo = toColumnReady(db);
  const toSql = hasTo ? ', refunds_blocked_to_iso' : '';
  const rows = db
    .prepare(
      `SELECT id, name, refunds_blocked_from_iso, refunds_blocked_reason,
              refunds_blocked_by_user_id, refunds_blocked_by_name, refunds_blocked_set_at_iso
              ${toSql}
       FROM branches
       WHERE TRIM(COALESCE(refunds_blocked_from_iso, '')) != ''`
    )
    .all();
  for (const row of rows) {
    out.set(String(row.id), mapFreezeRow(row, hasTo));
  }
  return out;
}

function reversedReceiptSql() {
  return `(status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @returns {string[]}
 */
export function receiptDateIsosForQuotation(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return [];
  return db
    .prepare(
      `SELECT date_iso FROM sales_receipts WHERE quotation_ref = ? AND ${reversedReceiptSql()}`
    )
    .all(ref)
    .map((r) => String(r.date_iso || '').trim())
    .filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} quoteIds
 * @returns {Map<string, string[]>}
 */
export function receiptDateIsosByQuotationRef(db, quoteIds) {
  const byRef = new Map();
  const ids = [...new Set((quoteIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return byRef;
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT quotation_ref, date_iso FROM sales_receipts
       WHERE quotation_ref IN (${ph}) AND ${reversedReceiptSql()}`
    )
    .all(...ids);
  for (const row of rows) {
    const ref = String(row.quotation_ref || '').trim();
    const day = String(row.date_iso || '').trim();
    if (!ref || !day) continue;
    const list = byRef.get(ref) || [];
    list.push(day);
    byRef.set(ref, list);
  }
  return byRef;
}

function freezeError(freeze) {
  return {
    ok: false,
    error: formatBranchRefundsFrozenError(freeze, freeze?.name),
    code: 'BRANCH_REFUNDS_FROZEN',
    refundsBlocked: true,
    freeze,
  };
}

/**
 * Lock when this quotation (or any of its receipts) falls in the branch window.
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} quotationRef
 * @param {string | null | undefined} [fallbackBranchId]
 */
export function assertQuotationBranchRefundsNotFrozen(db, quotationRef, fallbackBranchId) {
  const ref = String(quotationRef || '').trim();
  let bid = String(fallbackBranchId || '').trim();
  let quotationDateISO = '';
  if (ref) {
    const q = db.prepare(`SELECT branch_id, date_iso FROM quotations WHERE id = ?`).get(ref);
    const qBid = String(q?.branch_id || '').trim();
    if (qBid) bid = qBid;
    quotationDateISO = String(q?.date_iso || '').trim();
  }
  if (!bid) return { ok: true, freeze: null };
  const freeze = loadBranchRefundFreeze(db, bid);
  if (!freeze || !branchHasRefundLockWindow(freeze)) return { ok: true, freeze };
  const receiptDateISOs = ref ? receiptDateIsosForQuotation(db, ref) : [];
  if (quotationHitsBranchRefundLockWindow({ quotationDateISO, receiptDateISOs }, freeze)) {
    return freezeError(freeze);
  }
  return { ok: true, freeze };
}

/**
 * No-quotation fallback: lock when the request/as-of calendar day is inside the window.
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} branchId
 * @param {string | null | undefined} [asOfISO]
 */
export function assertBranchRefundsNotFrozen(db, branchId, asOfISO) {
  const freeze = loadBranchRefundFreeze(db, branchId);
  if (!freeze || !branchHasRefundLockWindow(freeze)) return { ok: true, freeze };
  if (!quotationHitsBranchRefundLockWindow({ quotationDateISO: asOfISO, receiptDateISOs: [] }, freeze)) {
    return { ok: true, freeze };
  }
  return freezeError(freeze);
}

/**
 * @param {object} row quotation SQL row (`id`, `branch_id`, `date_iso`)
 * @param {Map<string, object>} freezeByBranch
 * @param {Map<string, string[]>} receiptDatesByRef
 */
export function quotationRowHitsBranchRefundLock(row, freezeByBranch, receiptDatesByRef) {
  const bid = String(row?.branch_id || '').trim();
  const freeze = freezeByBranch?.get(bid);
  if (!freeze) return false;
  const ref = String(row?.id || '').trim();
  return quotationHitsBranchRefundLockWindow(
    {
      quotationDateISO: row?.date_iso,
      receiptDateISOs: receiptDatesByRef?.get(ref) || [],
    },
    freeze
  );
}

/**
 * Branches that have a lock window configured (not "every quote on the branch").
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
export function frozenRefundBranchIdSet(db) {
  return new Set(loadAllBranchRefundLocks(db).keys());
}
