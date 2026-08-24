/**
 * Close coil PO lines that were goods-received short but never snapped,
 * then mark fully received POs as Received so they drop out of open commitment.
 */
import { inferLineTypeFromProduct } from '../../shared/lib/poLineTypes.js';
import { mapPoLineFromDb, poLinesFullyReceived } from '../../shared/lib/inTransitVisibility.js';

function isCoilPoLineRow(row) {
  const mapped = mapPoLineFromDb(row);
  const lt = inferLineTypeFromProduct(mapped.productID, null, mapped);
  return lt === 'coil_kg' || lt === 'coil_meter';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {{ linesClosed: number; posReceived: number }}
 */
export function closeHangingCoilShortReceipts(db) {
  const empty = { linesClosed: 0, posReceived: 0 };
  try {
    db.prepare(`SELECT po_id FROM purchase_order_lines LIMIT 1`).get();
  } catch {
    return empty;
  }

  let linesClosed = 0;
  const shortLines = db
    .prepare(
      `SELECT po_id, line_key, product_id, line_type, qty_ordered, qty_received,
              meters_offered, unit_price_per_kg_ngn
       FROM purchase_order_lines
       WHERE COALESCE(qty_received, 0) > 0
         AND COALESCE(qty_received, 0) < COALESCE(qty_ordered, 0)`
    )
    .all();

  const snap = db.prepare(
    `UPDATE purchase_order_lines SET qty_received = qty_ordered
     WHERE po_id = ? AND line_key = ?`
  );

  for (const row of shortLines) {
    if (!isCoilPoLineRow(row)) continue;
    snap.run(row.po_id, row.line_key);
    linesClosed += 1;
  }

  let posReceived = 0;
  const openPos = db
    .prepare(
      `SELECT po_id FROM purchase_orders
       WHERE status IS NOT NULL
         AND LOWER(TRIM(status)) NOT IN ('received', 'rejected', 'cancelled', 'canceled', 'closed')`
    )
    .all();
  const linesStmt = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`);
  const markReceived = db.prepare(`UPDATE purchase_orders SET status = 'Received' WHERE po_id = ?`);

  for (const po of openPos) {
    const lines = linesStmt.all(po.po_id);
    if (!lines.length) continue;
    if (poLinesFullyReceived(lines, mapPoLineFromDb)) {
      markReceived.run(po.po_id);
      posReceived += 1;
    }
  }

  return { linesClosed, posReceived };
}
