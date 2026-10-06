/**
 * Stained-lot kg still belongs to the coil catalogue SKU. Reconciles that set
 * products.stock_level from coil_lots.qty_remaining alone must add this balance,
 * or the next reconcile drops metal that was only moved off the prime coil.
 */

function stainedLotsTableExists(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stained_lots'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string | null} branchId null sums every branch (global coil SKUs)
 */
export function stainedOnHandKg(db, productId, branchId) {
  const pid = String(productId || '').trim();
  if (!pid || !stainedLotsTableExists(db)) return 0;
  const bid = branchId == null ? '' : String(branchId).trim();
  if (!bid) {
    return (
      Number(db.prepare(`SELECT COALESCE(SUM(qty_kg), 0) AS s FROM stained_lots WHERE product_id = ?`).get(pid)?.s) ||
      0
    );
  }
  return (
    Number(
      db
        .prepare(`SELECT COALESCE(SUM(qty_kg), 0) AS s FROM stained_lots WHERE product_id = ? AND branch_id = ?`)
        .get(pid, bid)?.s
    ) || 0
  );
}
