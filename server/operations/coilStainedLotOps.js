/**
 * Mark stained/damaged coil kg into a stained lot that keeps the same coil number,
 * colour, gauge, and unit cost. The metal stays in inventory: the coil loses kg,
 * the stained lot gains the same kg, and the catalogue SKU stock_level does not move.
 * Scrap stays for metal that is thrown away or sold as scrap.
 *
 * Movements: two COIL_TO_STAINED rows. The coil leg is ref = coil no, qty negative,
 * and is part of the coil book (ancillary). The stained-lot leg is ref = STAINED:<coil>,
 * qty positive, so a later book reconcile does not put the kg back on the prime coil.
 */
import { actorId } from '../auth.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { appendAuditLog, assertPeriodOpen } from '../controlOps.js';
import { nextStockMovementHumanId } from '../humanId.js';
import { insertStockMovementTx } from '../stockMovementOps.js';

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function coilInWorkspace(row, workspaceBranchId) {
  const expected = String(workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const got = String(row?.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (got !== expected) return { ok: false, error: 'Coil is not in your current workspace branch.' };
  return { ok: true, branchId: got };
}

function applyCoilOnHand(db, coilNo, qtyRemaining, qtyReserved, landedCostNgn) {
  const reserved = Math.min(Math.max(0, qtyReserved), Math.max(0, qtyRemaining));
  const currentStatus =
    qtyRemaining <= 0.0001
      ? 'Consumed'
      : reserved >= qtyRemaining - 0.0001 && reserved > 0
        ? 'Reserved'
        : 'Available';
  db.prepare(
    `UPDATE coil_lots
     SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, current_status = ?, landed_cost_ngn = ?
     WHERE coil_no = ?`
  ).run(qtyRemaining, reserved, qtyRemaining, currentStatus, landedCostNgn, coilNo);
  return currentStatus;
}

/**
 * Move kg off a prime coil into its stained lot.
 * @param {import('better-sqlite3').Database} db
 * @param {{ coilNo?: string, kg?: number, reason?: string, by?: string, markedBy?: string, dateISO?: string }} payload
 * @param {{ workspaceBranchId?: string, actor?: object }} [opts]
 */
export function markCoilStainedDamaged(db, payload = {}, opts = {}) {
  const coilNo = String(payload.coilNo ?? '').trim();
  const reason = String(payload.reason ?? '').trim();
  const markedBy = String(payload.markedBy ?? payload.by ?? payload.marked_by ?? '').trim();
  const dateISO = String(payload.dateISO ?? payload.date_iso ?? new Date().toISOString().slice(0, 10))
    .trim()
    .slice(0, 10);
  const kg = roundKg3(payload.kg);

  if (!coilNo) return { ok: false, error: 'Coil number is required.' };
  if (!Number.isFinite(kg) || kg <= 0) return { ok: false, error: 'Stained kg must be a positive number.' };
  if (!reason) return { ok: false, error: 'A reason is required.' };
  if (!markedBy) return { ok: false, error: 'Marked by is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: 'Date is required (YYYY-MM-DD).' };

  try {
    assertPeriodOpen(db, dateISO, 'Stained metal date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const br = coilInWorkspace(row, opts.workspaceBranchId);
  if (!br.ok) return br;

  const qtyRem = Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0);
  const qtyRes = Math.max(0, Number(row.qty_reserved) || 0);
  const available = qtyRem - qtyRes;
  if (kg > available + 1e-6) {
    return {
      ok: false,
      error: `Cannot mark more than ${available.toFixed(3)} kg stained (unreserved balance on this coil).`,
    };
  }

  const unit = Math.round(Number(row.unit_cost_ngn_per_kg) || 0);
  const movedCost = unit > 0 ? Math.round(kg * unit) : 0;
  const prevLanded = Math.round(Number(row.landed_cost_ngn) || 0);
  const nextLanded = Math.max(0, prevLanded - movedCost);
  const nextRem = roundKg3(qtyRem - kg);
  const atISO = `${dateISO}T12:00:00.000Z`;
  const colour = row.colour ?? null;
  const gauge = row.gauge_label ?? null;
  const productId = row.product_id;

  try {
    const result = db.transaction(() => {
      const status = applyCoilOnHand(db, coilNo, nextRem, qtyRes, nextLanded);
      const existing = db.prepare(`SELECT qty_kg, cost_ngn FROM stained_lots WHERE coil_no = ?`).get(coilNo);
      let stainedQty;
      if (!existing) {
        stainedQty = kg;
        db.prepare(
          `INSERT INTO stained_lots (
            coil_no, branch_id, product_id, colour, gauge_label, unit_cost_ngn_per_kg,
            qty_kg, cost_ngn, created_at_iso, updated_at_iso
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(coilNo, br.branchId, productId, colour, gauge, unit, kg, movedCost, atISO, atISO);
      } else {
        stainedQty = roundKg3((Number(existing.qty_kg) || 0) + kg);
        const nextCost = Math.round(Number(existing.cost_ngn) || 0) + movedCost;
        db.prepare(
          `UPDATE stained_lots
           SET qty_kg = ?, cost_ngn = ?, colour = ?, gauge_label = ?, unit_cost_ngn_per_kg = ?, updated_at_iso = ?
           WHERE coil_no = ?`
        ).run(stainedQty, nextCost, colour, gauge, unit, atISO, coilNo);
      }

      const coilMv = nextStockMovementHumanId(db);
      const lotMv = nextStockMovementHumanId(db);
      insertStockMovementTx(db, {
        id: coilMv,
        atISO,
        type: 'COIL_TO_STAINED',
        ref: coilNo,
        productID: productId,
        qty: -kg,
        dateISO,
        branchId: br.branchId,
        unitPriceNgn: unit || null,
        valueNgn: movedCost ? -movedCost : null,
        detail: `${coilNo} to stained lot. ${kg.toFixed(3)} kg. ${reason}. By ${markedBy}.`,
      });
      insertStockMovementTx(db, {
        id: lotMv,
        atISO,
        type: 'COIL_TO_STAINED',
        ref: `STAINED:${coilNo}`,
        productID: productId,
        qty: kg,
        dateISO,
        branchId: br.branchId,
        unitPriceNgn: unit || null,
        valueNgn: movedCost || null,
        detail: `Stained lot ${coilNo} +${kg.toFixed(3)} kg. ${reason}. By ${markedBy}.`,
      });

      appendAuditLog(db, {
        actor: opts.actor,
        action: 'coil.mark_stained',
        entityKind: 'coil_lot',
        entityId: coilNo,
        note: `${kg.toFixed(3)} kg stained/damaged. ${reason}. By ${markedBy}.`,
        details: {
          coilNo,
          kg,
          reason,
          markedBy,
          dateISO,
          stainedQtyKg: stainedQty,
          coilQtyRemaining: nextRem,
          movedCostNgn: movedCost,
          coilMovementId: coilMv,
          stainedMovementId: lotMv,
          actorUserId: actorId(opts.actor),
        },
      });

      return {
        ok: true,
        coilNo,
        kg,
        reason,
        markedBy,
        dateISO,
        status,
        coilQtyRemaining: nextRem,
        stainedQtyKg: stainedQty,
        unitCostNgnPerKg: unit,
        colour,
        gaugeLabel: gauge,
        coilMovementId: coilMv,
        stainedMovementId: lotMv,
      };
    })();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Draw metres and kg from a stained lot for a production job. Caller owns the
 * transaction, the catalogue stock delta, and the production COGS journal.
 * The consumption detail starts with "Stained lot" so the prime coil book does not
 * count this kg a second time.
 * @param {import('better-sqlite3').Database} db
 */
export function drawStainedLotTx(db, args = {}) {
  const coilNo = String(args.coilNo ?? '').trim();
  const jobId = String(args.jobId ?? '').trim();
  const kg = roundKg3(args.kg);
  const meters = Number(args.meters);
  const atISO = String(args.atISO || new Date().toISOString());
  const dateISO = String(args.dateISO || atISO).slice(0, 10);
  const branchId = String(args.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

  if (!coilNo) throw new Error('Stained lot coil number is required.');
  if (!jobId) throw new Error('Production job is required.');
  if (!Number.isFinite(kg) || kg <= 0) throw new Error('Stained consumption kg must be a positive number.');
  if (!Number.isFinite(meters) || meters <= 0) throw new Error('Stained consumption metres must be a positive number.');

  const lot = db.prepare(`SELECT * FROM stained_lots WHERE coil_no = ?`).get(coilNo);
  if (!lot) throw new Error(`Stained lot ${coilNo} was not found.`);
  const lotBranch = String(lot.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (lotBranch !== branchId) throw new Error('Stained lot is not in your current workspace branch.');

  const onHand = Number(lot.qty_kg) || 0;
  if (kg > onHand + 1e-6) {
    throw new Error(`Stained lot ${coilNo} only has ${onHand.toFixed(3)} kg.`);
  }

  const unit = Math.round(Number(lot.unit_cost_ngn_per_kg) || 0);
  const cogsNgn = unit > 0 ? Math.round(kg * unit) : 0;
  const nextQty = roundKg3(onHand - kg);
  const nextCost = Math.max(0, Math.round(Number(lot.cost_ngn) || 0) - cogsNgn);
  db.prepare(`UPDATE stained_lots SET qty_kg = ?, cost_ngn = ?, updated_at_iso = ? WHERE coil_no = ?`).run(
    nextQty,
    nextCost,
    atISO,
    coilNo
  );

  const movementId = nextStockMovementHumanId(db);
  insertStockMovementTx(db, {
    id: movementId,
    atISO,
    type: 'COIL_CONSUMPTION',
    ref: jobId,
    productID: lot.product_id,
    qty: -kg,
    dateISO,
    branchId,
    unitPriceNgn: unit || null,
    valueNgn: cogsNgn || null,
    detail: `Stained lot ${coilNo} consumed for ${meters.toFixed(2)} m on ${jobId}`,
  });

  return {
    coilNo,
    jobId,
    kg,
    meters,
    cogsNgn,
    productId: lot.product_id,
    movementId,
    qtyKg: nextQty,
    unitCostNgnPerKg: unit,
  };
}
