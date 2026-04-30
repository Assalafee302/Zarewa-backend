/**
 * Client / UAT: skip transactional demo seeds (customers, POs, receipts, etc.).
 * Set ZAREWA_EMPTY_SEED=1 (or true) before starting the API after a fresh DB.
 */

/**
 * @returns {boolean}
 */
export function isEmptySeedMode() {
  const v = process.env.ZAREWA_EMPTY_SEED;
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Minimal rows so core flows work on an otherwise empty DB (e.g. post a receipt).
 * @param {import('better-sqlite3').Database} db
 */
export function seedEmptyClientMinimal(db) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM treasury_accounts`).get().c;
  if (n > 0) return;
  db.prepare(
    `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no) VALUES (?,?,?,?,?)`
  ).run('Main bank', '', 0, 'Bank', '');
}
