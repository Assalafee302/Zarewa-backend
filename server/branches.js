/** Default branch for legacy rows and first login. */
export const DEFAULT_BRANCH_ID = 'BR-KD';

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
