/**
 * Quotation validity: 10 calendar days from quote date, then auto-archive as Expired (no commitment).
 * Follow-up alert (UI): days 5–9 — see client helpers.
 * Master price change: void quotes under 2 days old with no commitment.
 */
import { branchPredicate } from './branchSql.js';

export const QUOTATION_VALIDITY_DAYS = 10;
export const QUOTATION_FOLLOWUP_START_DAY = 5;
/** Void quotes with age (0 or 1 full days since quote date) when list/default prices change. */
export const PRICE_CHANGE_VOID_MAX_AGE_DAYS = 2;

const TERMINAL_STATUSES = new Set(['Expired', 'Void']);

const EXPIRE_NOTE = `Auto-expired: ${QUOTATION_VALIDITY_DAYS}-day quotation validity ended (no payment, cutting list, ledger receipt, or production approval).`;
const VOID_PRICE_NOTE = `Auto-void: master price changed while quote was under ${PRICE_CHANGE_VOID_MAX_AGE_DAYS} days old with no commitment.`;

function parseIsoDate(s) {
  const t = String(s || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return new Date(`${t}T12:00:00.000Z`);
}

/** Full calendar days from quote date to today (UTC date parts). */
export function quotationAgeCalendarDays(quoteDateIso, todayIso) {
  const a = parseIsoDate(quoteDateIso);
  const b = parseIsoDate(todayIso);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row — quotations row
 */
export function quotationHasCommitment(db, row) {
  const id = String(row.id || '').trim();
  if (!id) return false;
  if (Number(row.paid_ngn) > 0) return true;
  const ps = String(row.payment_status || '').trim();
  if (ps && ps !== 'Unpaid') return true;
  if (String(row.manager_production_approved_at_iso || '').trim()) return true;

  const ledgerHit = db
    .prepare(
      `SELECT 1 AS x FROM ledger_entries 
       WHERE TRIM(COALESCE(quotation_ref,'')) = ? 
         AND amount_ngn > 0 
         AND type IN ('RECEIPT','RECEIPT_IN','ADVANCE_APPLIED','ADVANCE_IN','OVERPAY_ADVANCE')
       LIMIT 1`
    )
    .get(id);
  if (ledgerHit) return true;

  const clHit = db
    .prepare(`SELECT 1 AS x FROM cutting_lists WHERE TRIM(COALESCE(quotation_ref,'')) = ? LIMIT 1`)
    .get(id);
  if (clHit) return true;

  return false;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {string} [todayISO]
 * @returns {{ expired: number }}
 */
export function expireQuotationsPastValidity(db, branchScope, todayISO = new Date().toISOString().slice(0, 10)) {
  const bp = branchPredicate(db, 'quotations', branchScope);
  const rows = db
    .prepare(
      `SELECT * FROM quotations WHERE 1=1${bp.sql}
       AND (archived IS NULL OR archived = 0)
       AND (status IS NULL OR status NOT IN ('Expired','Void'))`
    )
    .all(...bp.args);

  const upd = db.prepare(
    `UPDATE quotations SET status = 'Expired', archived = 1, quotation_lifecycle_note = ? WHERE id = ?`
  );
  let expired = 0;
  for (const row of rows) {
    const age = quotationAgeCalendarDays(row.date_iso, todayISO);
    if (age == null || age < QUOTATION_VALIDITY_DAYS) continue;
    if (quotationHasCommitment(db, row)) continue;
    upd.run(EXPIRE_NOTE, row.id);
    expired += 1;
  }
  return { expired };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 * @param {string} [todayISO]
 * @returns {{ voided: number }}
 */
export function voidRecentQuotationsAfterMasterPriceChange(
  db,
  branchScope,
  todayISO = new Date().toISOString().slice(0, 10)
) {
  const bp = branchPredicate(db, 'quotations', branchScope);
  const rows = db
    .prepare(
      `SELECT * FROM quotations WHERE 1=1${bp.sql}
       AND (archived IS NULL OR archived = 0)
       AND (status IS NULL OR status NOT IN ('Expired','Void'))`
    )
    .all(...bp.args);

  const upd = db.prepare(
    `UPDATE quotations SET status = 'Void', archived = 1, quotation_lifecycle_note = ? WHERE id = ?`
  );
  let voided = 0;
  for (const row of rows) {
    const age = quotationAgeCalendarDays(row.date_iso, todayISO);
    if (age == null || age >= PRICE_CHANGE_VOID_MAX_AGE_DAYS) continue;
    if (quotationHasCommitment(db, row)) continue;
    upd.run(VOID_PRICE_NOTE, row.id);
    voided += 1;
  }
  return { voided };
}

export function isTerminalQuotationStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim());
}

/**
 * Run expiry pass (bootstrap / refresh). Price void is triggered from master-data saves only.
 */
export function runQuotationLifecycleMaintenance(db, branchScope) {
  return expireQuotationsPastValidity(db, branchScope);
}
