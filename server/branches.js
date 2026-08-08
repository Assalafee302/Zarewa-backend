import {
  ACCOUNTING_OPENING_DATE_ISO,
  openingPeriodKeyFromDateISO,
} from '../shared/lib/accountingCutover.js';

/** Default branch for legacy rows and first login. */
export const DEFAULT_BRANCH_ID = 'BR-KD';

/** Suppliers and transport agents are shared company-wide (not per branch). */
export const GLOBAL_MASTER_DATA_BRANCH = '';

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ id: string; code: string; name: string; active: boolean; sortOrder: number; cuttingListMinPaidFraction: number }>}
 */
export function listBranches(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='branches'`).get()) {
    return [];
  }
  const cols = new Set(
    db
      .prepare(`PRAGMA table_info(branches)`)
      .all()
      .map((c) => c.name)
  );
  const hasFrac = cols.has('cutting_list_min_paid_fraction');
  return db
    .prepare(`SELECT * FROM branches WHERE active = 1 ORDER BY sort_order ASC, id ASC`)
    .all()
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      active: Boolean(row.active),
      sortOrder: Number(row.sort_order) || 0,
      cuttingListMinPaidFraction: hasFrac
        ? Math.min(1, Math.max(0.05, Number(row.cutting_list_min_paid_fraction) || 0.7))
        : 0.7,
    }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
/** Branch display name for print payloads and labels. */
export function branchDisplayName(db, branchId) {
  const id = String(branchId || '').trim();
  if (!id) return '';
  try {
    const row = db.prepare(`SELECT name FROM branches WHERE id = ?`).get(id);
    return String(row?.name || '').trim() || id;
  } catch {
    return id;
  }
}

export function getBranch(db, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT * FROM branches WHERE id = ?`).get(id);
  if (!row) return null;
  const cols = new Set(
    db
      .prepare(`PRAGMA table_info(branches)`)
      .all()
      .map((c) => c.name)
  );
  const hasFrac = cols.has('cutting_list_min_paid_fraction');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order) || 0,
    cuttingListMinPaidFraction: hasFrac
      ? Math.min(1, Math.max(0.05, Number(row.cutting_list_min_paid_fraction) || 0.7))
      : 0.7,
  };
}

/**
 * Minimum fraction of quotation total that must be paid (cash receipts + applied advance) before
 * creating a cutting list without manager production approval. Stored per branch (0.05–1.0).
 * @param {import('better-sqlite3').Database} db
 */
export function setBranchCuttingListMinPaidFraction(db, branchId, fraction) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'branchId is required.' };
  const f = Number(fraction);
  if (!Number.isFinite(f) || f < 0.05 || f > 1) {
    return { ok: false, error: 'cuttingListMinPaidFraction must be between 0.05 and 1.0.' };
  }
  const exists = db.prepare(`SELECT 1 FROM branches WHERE id = ?`).get(bid);
  if (!exists) return { ok: false, error: 'Branch not found.' };
  db.prepare(`UPDATE branches SET cutting_list_min_paid_fraction = ? WHERE id = ?`).run(f, bid);
  return { ok: true, branchId: bid, cuttingListMinPaidFraction: f };
}

/**
 * Per-branch accounting opening cutover (defaults to HQ signed go-live date).
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @returns {{ dateISO: string; periodKey: string }}
 */
export function resolveBranchOpeningCutover(db, branchId) {
  const bid = String(branchId || '').trim();
  let dateISO = ACCOUNTING_OPENING_DATE_ISO;
  if (bid) {
    try {
      const cols = new Set(
        db
          .prepare(`PRAGMA table_info(branches)`)
          .all()
          .map((c) => c.name)
      );
      if (cols.has('opening_cutover_date_iso')) {
        const row = db
          .prepare(`SELECT opening_cutover_date_iso AS dateISO FROM branches WHERE id = ?`)
          .get(bid);
        const raw = String(row?.dateISO || '').trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) dateISO = raw;
      }
    } catch {
      /* table mid-migrate */
    }
  }
  return { dateISO, periodKey: openingPeriodKeyFromDateISO(dateISO) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {string} dateISO
 */
export function setBranchOpeningCutoverDate(db, branchId, dateISO) {
  const bid = String(branchId || '').trim();
  const d = String(dateISO || '').trim().slice(0, 10);
  if (!bid) return { ok: false, error: 'branchId is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'opening cutover date must be YYYY-MM-DD.' };
  const exists = db.prepare(`SELECT 1 FROM branches WHERE id = ?`).get(bid);
  if (!exists) return { ok: false, error: 'Branch not found.' };
  try {
    const cols = new Set(
      db
        .prepare(`PRAGMA table_info(branches)`)
        .all()
        .map((c) => c.name)
    );
    if (!cols.has('opening_cutover_date_iso')) {
      return { ok: false, error: 'opening_cutover_date_iso column not migrated yet.' };
    }
    db.prepare(`UPDATE branches SET opening_cutover_date_iso = ? WHERE id = ?`).run(d, bid);
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not set opening cutover date.' };
  }
  return { ok: true, branchId: bid, ...resolveBranchOpeningCutover(db, bid) };
}
