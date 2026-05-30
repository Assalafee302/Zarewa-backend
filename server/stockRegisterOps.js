/**
 * Month-end stock register — DB orchestration and sign-off workflow.
 */

import { buildStockRegisterPack, periodBoundsFromEndDate, previousPeriodEndIso, enrichStockRegisterValuation } from '../shared/lib/stockRegisterCore.js';
import { appendAuditLog } from './controlOps.js';
function newPeriodId() {
  return `SRP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
import { listCoilLots, listInventoryCoilSnapshots, listProducts, listProductionJobs, listStockMovements } from './readModel.js';
import { listMasterData } from './masterData.js';
import { listInTransitLoads } from './inTransitOps.js';
import { listProductionJobCoils } from './productionTraceability.js';
import { isBranchManagerApprovalAuthority, isExecutiveRoleKey } from '../shared/workspaceGovernance.js';
import { purchaseWeightedAvgUnitPriceLastDays, purchaseUnitPriceMapByProductPrefix, resolveBranchCoilCostPerKg } from './materialPricingOps.js';

function nowIso() {
  return new Date().toISOString();
}

function tableReady(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function mapPeriodRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    branchId: row.branch_id,
    periodKey: row.period_key,
    periodEndIso: row.period_end_iso,
    status: row.status,
    printedAtISO: row.printed_at_iso || '',
    storeConfirmedAtISO: row.store_confirmed_at_iso || '',
    storeConfirmedByName: row.store_confirmed_by_name || '',
    bmApprovedAtISO: row.bm_approved_at_iso || '',
    bmApprovedByName: row.bm_approved_by_name || '',
    mdApprovedAtISO: row.md_approved_at_iso || '',
    mdApprovedByName: row.md_approved_by_name || '',
    lockedAtISO: row.locked_at_iso || '',
    countNotes: row.count_notes || '',
    updatedAtISO: row.updated_at_iso || '',
  };
}

function getPeriodRow(db, branchId, periodKey) {
  if (!tableReady(db, 'stock_register_periods')) return null;
  return db
    .prepare(`SELECT * FROM stock_register_periods WHERE branch_id = ? AND period_key = ?`)
    .get(String(branchId || '').trim(), String(periodKey || '').trim());
}

function upsertPeriodRow(db, branchId, periodKey, periodEnd, patch = {}) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const now = nowIso();
  let row = getPeriodRow(db, bid, pk);
  if (!row) {
    const id = newPeriodId();
    db.prepare(
      `INSERT INTO stock_register_periods (
        id, branch_id, period_key, period_end_iso, status, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?)`
    ).run(id, bid, pk, periodEnd, patch.status || 'draft', now, now);
    row = getPeriodRow(db, bid, pk);
  }
  const sets = [];
  const args = [];
  for (const [col, val] of Object.entries(patch)) {
    sets.push(`${col} = ?`);
    args.push(val);
  }
  if (sets.length) {
    sets.push('updated_at_iso = ?');
    args.push(now);
    db.prepare(`UPDATE stock_register_periods SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
    row = getPeriodRow(db, bid, pk);
  }
  return row;
}

function openingMapsFromSnapshots(db, branchId, asAtIso) {
  const stone = new Map();
  const accessory = new Map();
  if (!tableReady(db, 'inventory_product_snapshots')) return { stone, accessory };
  const rows = db
    .prepare(
      `SELECT product_id, stock_level, section_kind FROM inventory_product_snapshots
       WHERE as_at_iso = ? AND branch_id = ?`
    )
    .all(String(asAtIso || '').slice(0, 10), String(branchId || '').trim());
  for (const r of rows) {
    const pid = String(r.product_id || '').trim();
    const lvl = Number(r.stock_level) || 0;
    if (r.section_kind === 'stone') stone.set(pid, lvl);
    else if (r.section_kind === 'accessory') accessory.set(pid, lvl);
  }
  return { stone, accessory };
}

function listCoilControlEventsInPeriod(db, branchId, start, end) {
  if (!tableReady(db, 'coil_control_events')) return [];
  const bid = String(branchId || '').trim();
  const rows = db
    .prepare(
      `SELECT * FROM coil_control_events
       WHERE branch_id = ? AND date_iso >= ? AND date_iso <= ?
       ORDER BY date_iso ASC, id ASC`
    )
    .all(bid, start, end);
  return rows.map((row) => ({
    coilNo: row.coil_no ?? '',
    kgCoilDelta: Number(row.kg_coil_delta) || 0,
    dateISO: row.date_iso ?? '',
    createdAtISO: row.created_at_iso ?? '',
  }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {string} periodEndIso
 */
export function buildStockRegisterForBranch(db, branchId, periodEndIso) {
  const bid = String(branchId || '').trim();
  const { periodKey, start, end } = periodBoundsFromEndDate(periodEndIso);
  if (!periodKey || !end) return { ok: false, error: 'Valid period end date required (YYYY-MM-DD).' };

  const prevEnd = previousPeriodEndIso(end);
  const prevSnapshots = listInventoryCoilSnapshots(db, prevEnd, bid);
  const coilLots = listCoilLots(db, bid);
  const masterData = listMasterData(db);
  const products = listProducts(db, bid);
  const movements = listStockMovements(db, bid);
  const jobs = listProductionJobs(db, bid);
  const jobCoils = listProductionJobCoils(db, bid, { limit: 0 });
  const controlEvents = listCoilControlEventsInPeriod(db, bid, start, end);
  const inTransit = listInTransitLoads(db, bid);

  const { stone: stoneOpeningByProduct, accessory: accessoryOpeningByProduct } = openingMapsFromSnapshots(
    db,
    bid,
    prevEnd
  );

  const pack = buildStockRegisterPack({
    branchId: bid,
    periodEnd: end,
    coilLots,
    prevClosingSnapshots: prevSnapshots,
    productionJobs: jobs,
    productionJobCoils: jobCoils,
    coilControlEvents: controlEvents,
    products,
    stockMovements: movements,
    inTransitLoads: inTransit,
    masterData,
    stoneOpeningByProduct,
    accessoryOpeningByProduct,
  });

  const lookbackDays = 31;
  const aluResolved = resolveBranchCoilCostPerKg(db, 'COIL-ALU', bid, lookbackDays);
  const aluzResolved = resolveBranchCoilCostPerKg(db, 'PRD-102', bid, lookbackDays);
  const stonePriceMap = purchaseUnitPriceMapByProductPrefix(db, bid, 'STONE%', lookbackDays);
  const accessoryPriceMap = purchaseUnitPriceMapByProductPrefix(db, bid, 'ACC%', lookbackDays);

  let stoneFallback = null;
  if (stonePriceMap.size) {
    let sw = 0;
    let sv = 0;
    for (const p of stonePriceMap.values()) {
      sw += 1;
      sv += p;
    }
    stoneFallback = sw > 0 ? Math.round(sv / sw) : null;
  }

  let accessoryFallback = null;
  if (accessoryPriceMap.size) {
    let aw = 0;
    let av = 0;
    for (const p of accessoryPriceMap.values()) {
      aw += 1;
      av += p;
    }
    accessoryFallback = aw > 0 ? Math.round(av / aw) : null;
  }

  enrichStockRegisterValuation(pack, {
    aluminiumUnitCostNgnPerKg: aluResolved.cost,
    aluzincUnitCostNgnPerKg: aluzResolved.cost,
    stoneUnitPriceByProduct: stonePriceMap,
    stoneFallbackUnitPriceNgnPerM: stoneFallback,
    accessoryUnitPriceByProduct: accessoryPriceMap,
    accessoryFallbackUnitPriceNgn: accessoryFallback,
    priceLookbackDays: lookbackDays,
    priceSources: {
      aluminium: aluResolved.source,
      aluzinc: aluzResolved.source,
      stoneCoated: stonePriceMap.size ? 'receipt_avg' : 'none',
      accessories: accessoryPriceMap.size ? 'receipt_avg' : 'none',
    },
  });

  const periodRow = getPeriodRow(db, bid, periodKey);
  return {
    ok: true,
    register: pack,
    workflow: mapPeriodRow(periodRow) || { status: 'draft', periodKey, periodEndIso: end, branchId: bid },
  };
}

export function getStockRegisterWorkflow(db, branchId, periodKey) {
  const row = getPeriodRow(db, String(branchId || '').trim(), String(periodKey || '').trim());
  return { ok: true, workflow: mapPeriodRow(row) || null };
}

export function saveStockRegisterPrintSnapshot(db, branchId, periodEndIso, actor) {
  const built = buildStockRegisterForBranch(db, branchId, periodEndIso);
  if (!built.ok) return built;
  const { periodKey, end } = periodBoundsFromEndDate(periodEndIso);
  const uid = String(actor?.id || actor?.userId || '').trim();
  const now = nowIso();
  upsertPeriodRow(db, branchId, periodKey, end, {
    status: 'printed',
    register_json: JSON.stringify(built.register),
    print_snapshot_json: JSON.stringify(built.register),
    printed_at_iso: now,
    printed_by_user_id: uid || null,
  });
  appendAuditLog(db, {
    actor,
    action: 'stock_register.print',
    entityKind: 'stock_register_period',
    entityId: `${branchId}:${periodKey}`,
    note: `Print snapshot saved for ${periodKey}`,
  });
  return { ok: true, register: built.register, workflow: mapPeriodRow(getPeriodRow(db, branchId, periodKey)) };
}

function actorName(actor) {
  return String(actor?.displayName || actor?.display_name || actor?.username || '').trim() || 'User';
}

export function advanceStockRegisterWorkflow(db, branchId, periodKey, action, body = {}, actor = null) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const row = getPeriodRow(db, bid, pk);
  if (!row) return { ok: false, error: 'Register period not found. Print the register first.' };

  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  const now = nowIso();
  const notes = String(body?.countNotes ?? body?.notes ?? '').trim();

  if (action === 'store_confirm') {
    if (!['printed', 'draft', 'store_confirmed'].includes(String(row.status))) {
      return { ok: false, error: 'Register must be printed before store confirmation.' };
    }
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'store_confirmed',
      store_confirmed_at_iso: now,
      store_confirmed_by_user_id: actor?.id || null,
      store_confirmed_by_name: actorName(actor),
      count_notes: notes || row.count_notes,
    });
  } else if (action === 'bm_approve') {
    if (!isBranchManagerApprovalAuthority(rk) && !isExecutiveRoleKey(rk)) {
      return { ok: false, error: 'Branch manager approval required.' };
    }
    if (!['store_confirmed', 'bm_approved'].includes(String(row.status))) {
      return { ok: false, error: 'Store must confirm the physical count before branch manager approval.' };
    }
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'bm_approved',
      bm_approved_at_iso: now,
      bm_approved_by_user_id: actor?.id || null,
      bm_approved_by_name: actorName(actor),
    });
  } else if (action === 'md_approve') {
    if (!isExecutiveRoleKey(rk)) {
      return { ok: false, error: 'Managing director approval required.' };
    }
    if (String(row.status) !== 'bm_approved') {
      return { ok: false, error: 'Branch manager must approve before MD sign-off.' };
    }
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'md_approved',
      md_approved_at_iso: now,
      md_approved_by_user_id: actor?.id || null,
      md_approved_by_name: actorName(actor),
    });
  } else {
    return { ok: false, error: 'Unknown workflow action.' };
  }

  appendAuditLog(db, {
    actor,
    action: `stock_register.${action}`,
    entityKind: 'stock_register_period',
    entityId: `${bid}:${pk}`,
    note: action,
  });
  return { ok: true, workflow: mapPeriodRow(getPeriodRow(db, bid, pk)) };
}

/**
 * Capture closing coil lines after MD approval — feeds next month opening.
 */
export function captureStockRegisterClosing(db, branchId, periodEndIso, actor) {
  const bid = String(branchId || '').trim();
  const { periodKey, end } = periodBoundsFromEndDate(periodEndIso);
  const row = getPeriodRow(db, bid, periodKey);
  if (!row) return { ok: false, error: 'Register period not found.' };
  if (String(row.status) !== 'md_approved') {
    return { ok: false, error: 'MD approval required before capturing closing stock.' };
  }

  const built = buildStockRegisterForBranch(db, bid, end);
  if (!built.ok) return built;
  const reg = built.register;
  const now = nowIso();

  if (!tableReady(db, 'inventory_coil_snapshots')) {
    return { ok: false, error: 'Snapshot table missing; run migrations.' };
  }

  const allCoilRows = [
    ...(reg.coilSections?.aluminium?.groups || []).flatMap((g) => g.rows),
    ...(reg.coilSections?.aluzinc?.groups || []).flatMap((g) => g.rows),
  ];

  db.transaction(() => {
    db.prepare(`DELETE FROM inventory_coil_snapshots WHERE as_at_iso = ? AND branch_id = ?`).run(end, bid);
    const ins = db.prepare(
      `INSERT INTO inventory_coil_snapshots (
        as_at_iso, branch_id, coil_no, current_weight_kg, colour, gauge_label, material_type_name,
        product_id, po_id, supplier_name, unit_cost_ngn_per_kg, captured_at_iso,
        opening_kg, received_kg, used_kg, stock_form, is_finished, remark
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const line of allCoilRows) {
      if (line.finishedInPeriod) {
        ins.run(
          end,
          bid,
          line.coilNo,
          0,
          line.colourAbbrev,
          line.gaugeLabel,
          line.materialFamily === 'aluzinc' ? 'Aluzinc' : 'Aluminium',
          null,
          null,
          null,
          line.unitCostNgnPerKg,
          now,
          line.openingKg,
          line.receivedKg,
          line.usedKg,
          line.stockForm,
          1,
          line.remarkSuggested || ''
        );
        continue;
      }
      if (line.closingKg == null || line.closingKg <= 0) continue;
      const lot = db.prepare(`SELECT product_id, po_id, supplier_name FROM coil_lots WHERE coil_no = ?`).get(line.coilNo);
      ins.run(
        end,
        bid,
        line.coilNo,
        line.closingKg,
        line.colourAbbrev,
        line.gaugeLabel,
        line.materialFamily === 'aluzinc' ? 'Aluzinc' : 'Aluminium',
        lot?.product_id || null,
        lot?.po_id || null,
        lot?.supplier_name || null,
        line.unitCostNgnPerKg,
        now,
        line.openingKg,
        line.receivedKg,
        line.usedKg,
        line.stockForm,
        0,
        line.remarkSuggested || ''
      );
    }

    if (tableReady(db, 'inventory_product_snapshots')) {
      db.prepare(`DELETE FROM inventory_product_snapshots WHERE as_at_iso = ? AND branch_id = ?`).run(end, bid);
      const pins = db.prepare(
        `INSERT INTO inventory_product_snapshots (as_at_iso, branch_id, product_id, section_kind, stock_level, captured_at_iso)
         VALUES (?,?,?,?,?,?)`
      );
      for (const g of reg.stoneCoated?.groups || []) {
        for (const r of g.rows || []) {
          pins.run(end, bid, r.productID, 'stone', r.remainingM, now);
        }
      }
      for (const r of reg.accessories?.rows || []) {
        for (const pid of r.productIds || []) {
          const p = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(pid);
          pins.run(end, bid, pid, 'accessory', Number(p?.stock_level) || 0, now);
        }
      }
    }

    upsertPeriodRow(db, bid, periodKey, end, {
      status: 'locked',
      locked_at_iso: now,
      register_json: JSON.stringify(reg),
    });
  })();

  appendAuditLog(db, {
    actor,
    action: 'stock_register.capture_closing',
    entityKind: 'stock_register_period',
    entityId: `${bid}:${periodKey}`,
    note: `Captured closing stock for ${periodKey}`,
    details: { coilLineCount: allCoilRows.length },
  });

  return {
    ok: true,
    periodKey,
    periodEndIso: end,
    coilLineCount: allCoilRows.length,
    workflow: mapPeriodRow(getPeriodRow(db, bid, periodKey)),
  };
}

export function patchCoilStockForm(db, coilNo, stockForm, opts = {}) {
  const cn = String(coilNo || '').trim();
  const form = String(stockForm || '').trim().toLowerCase();
  if (!cn) return { ok: false, error: 'Coil number required.' };
  if (form !== 'coil' && form !== 'roll') {
    return { ok: false, error: 'stockForm must be coil or roll.' };
  }
  const row = db.prepare(`SELECT coil_no FROM coil_lots WHERE coil_no = ?`).get(cn);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const cols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
  if (!cols.some((c) => c.name === 'stock_form')) {
    return { ok: false, error: 'stock_form column missing; run migrations.' };
  }
  db.prepare(`UPDATE coil_lots SET stock_form = ? WHERE coil_no = ?`).run(form, cn);
  appendAuditLog(db, {
    actor: opts.actor,
    action: 'coil.stock_form',
    entityKind: 'coil_lot',
    entityId: cn,
    note: `Marked as ${form}`,
  });
  return { ok: true, coilNo: cn, stockForm: form };
}
