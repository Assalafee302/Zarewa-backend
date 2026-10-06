/**
 * Physical coil count. The signed difference between the count and the on-hand
 * cache posts as COIL_COUNT_VARIANCE (inventory variance), never as scrap.
 * Stock side effect: coil qty_remaining / current_weight_kg, the linked product
 * stock_level, one stock movement, and the inventory-variance journal when the
 * coil has a unit cost.
 */
import { actorId } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import { tryPostInventoryVarianceJournal } from '../glOps.js';
import { nextStockMovementHumanId } from '../humanId.js';
import { isGlobalCoilCatalogProductId } from '../productBranchInventory.js';
import { stainedOnHandKg } from './stainedLotBalance.js';
import { insertStockMovementTx } from '../stockMovementOps.js';
import { assertCoilInWorkspaceBranch } from '../writeOps.js';

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function applyCoilOnHand(db, coilNo, qtyRemaining, qtyReserved) {
  const reserved = Math.min(Math.max(0, qtyReserved), qtyRemaining);
  const currentStatus =
    qtyRemaining <= 0.0001
      ? 'Consumed'
      : reserved >= qtyRemaining - 0.0001 && reserved > 0
        ? 'Reserved'
        : 'Available';
  db.prepare(
    `UPDATE coil_lots SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, current_status = ? WHERE coil_no = ?`
  ).run(qtyRemaining, reserved, qtyRemaining, currentStatus, coilNo);
  return currentStatus;
}

function applyLinkedProductStock(db, productId, branchId, deltaKg) {
  const pid = String(productId || '').trim();
  if (!pid) throw new Error('Coil product id missing.');
  if (isGlobalCoilCatalogProductId(pid)) {
    const exists = db.prepare(`SELECT 1 AS x FROM products WHERE product_id = ? LIMIT 1`).get(pid);
    if (!exists) throw new Error(`Raw material product ${pid} not found.`);
    const coilSum =
      Number(db.prepare(`SELECT COALESCE(SUM(qty_remaining), 0) AS s FROM coil_lots WHERE product_id = ?`).get(pid)?.s) ||
      0;
    const total = Math.round(coilSum + stainedOnHandKg(db, pid, null));
    db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(total, pid);
    return total;
  }
  const bid = String(branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const row = db.prepare(`SELECT stock_level FROM products WHERE product_id = ? AND branch_id = ?`).get(pid, bid);
  if (!row) throw new Error(`Raw material product ${pid} not found for branch ${bid}.`);
  const next = Math.round((Number(row.stock_level) || 0) + deltaKg);
  if (next < -1e-6) throw new Error('Raw material product stock would go negative — check coil vs book stock.');
  db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(next, pid, bid);
  return next;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ coilNo?: string, countedKg?: number, countedBy?: string, dateISO?: string, note?: string }} payload
 * @param {{ workspaceBranchId?: string, actor?: object }} [opts]
 */
export function postCoilPhysicalCount(db, payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? '').trim();
  const countedBy = String(payload.countedBy ?? payload.counted_by ?? '').trim();
  const note = String(payload.note ?? '').trim();
  const dateISO = String(payload.dateISO ?? payload.date_iso ?? payload.countedAtISO ?? '').trim().slice(0, 10);
  const countedKg = roundKg3(payload.countedKg ?? payload.counted_kg);

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(countedKg) || countedKg < 0) return { ok: false, error: 'Counted kg must be zero or greater.' };
  if (!countedBy) return { ok: false, error: 'Counted by is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: 'Count date is required (YYYY-MM-DD).' };
  if (!note) return { ok: false, error: 'Enter a note for the physical count.' };

  try {
    assertPeriodOpen(db, dateISO, 'Physical count date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = assertCoilInWorkspaceBranch(row, opts.workspaceBranchId);
  if (!br.ok) return br;

  const bookKg = roundKg3(Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0));
  const reservedKg = roundKg3(Math.max(0, Number(row.qty_reserved) || 0));
  if (countedKg + 0.001 < reservedKg) {
    return {
      ok: false,
      error: `Counted ${countedKg.toFixed(3)} kg is below ${reservedKg.toFixed(3)} kg reserved on this coil. Release the reservation first.`,
    };
  }

  const varianceKg = roundKg3(countedKg - bookKg);
  const actor = opts.actor || null;
  const unitCost = Number(row.unit_cost_ngn_per_kg) || 0;
  const stockBranch = String(row.branch_id || opts.workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  try {
    const result = db.transaction(() => {
      const status = applyCoilOnHand(db, coilNo, countedKg, reservedKg);
      const productStockLevel = applyLinkedProductStock(db, row.product_id, stockBranch, varianceKg);
      let movementId = null;
      let glJournalId = null;
      let glSkipped = true;
      if (Math.abs(varianceKg) >= 0.001) {
        movementId = nextStockMovementHumanId(db);
        const valueNgn = Math.round(varianceKg * unitCost);
        insertStockMovementTx(db, {
          id: movementId,
          type: 'COIL_COUNT_VARIANCE',
          productID: row.product_id,
          qty: varianceKg,
          ref: coilNo,
          dateISO,
          branchId: stockBranch,
          unitPriceNgn: unitCost || null,
          valueNgn,
          detail: `${coilNo} physical count ${countedKg.toFixed(3)} kg (book ${bookKg.toFixed(3)} kg) by ${countedBy} — ${note}`.slice(0, 500),
        });
        if (unitCost > 0) {
          const gl = tryPostInventoryVarianceJournal(db, {
            entryDateISO: dateISO,
            amountNgn: Math.abs(valueNgn),
            direction: varianceKg < 0 ? 'shortage' : 'gain',
            branchId: stockBranch,
            createdByUserId: actorId(actor),
            sourceId: movementId,
            memo: `Coil count ${coilNo} ${varianceKg > 0 ? '+' : ''}${varianceKg.toFixed(3)} kg`,
            sourceKind: 'COIL_COUNT_VARIANCE_GL',
          });
          if (!gl.ok) throw new Error(gl.error || 'Inventory variance GL posting failed.');
          glJournalId = gl.journalId ?? null;
          glSkipped = Boolean(gl.skipped);
        }
      }
      appendAuditLog(db, {
        actor,
        action: 'coil.physical_count',
        entityKind: 'coil_lot',
        entityId: coilNo,
        note: `${countedKg.toFixed(3)} kg counted by ${countedBy}`,
        details: {
          coilNo,
          bookKg,
          countedKg,
          varianceKg,
          countedBy,
          dateISO,
          note,
          movementId,
          movementType: Math.abs(varianceKg) >= 0.001 ? 'COIL_COUNT_VARIANCE' : null,
          glJournalId,
          glSkipped,
          status,
        },
      });
      return {
        ok: true,
        coilNo,
        bookKg,
        countedKg,
        varianceKg,
        status,
        movementId,
        movementType: movementId ? 'COIL_COUNT_VARIANCE' : null,
        productStockLevel,
        glJournalId,
      };
    })();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
