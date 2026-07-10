/**
 * Month-end stock register — DB orchestration and sign-off workflow.
 */

import {
  applyBmAdjustmentsToRegister,
  applyProcurementPricingToRegister,
  buildStockRegisterPack,
  coilProductionJobsInPeriod,
  enrichStockRegisterValuation,
  parseBmAdjustments,
  periodBoundsFromEndDate,
  prepareRegisterForView,
  previousPeriodEndIso,
} from '../shared/lib/stockRegisterCore.js';
import {
  applyLineClearanceToRegister,
  buildAdjustmentsFromClearance,
  enumerateRegisterLineKeys,
  FINISHED_CONFIRM,
  lineEligibleForClosing,
  LINE_STATUS,
  parseLineClearance,
  parseStoreChecklist,
  validateBmApprove,
  validateStoreChecklist,
} from '../shared/lib/stockRegisterLineClearance.js';
import { appendAuditLog } from './controlOps.js';
function newPeriodId() {
  return `SRP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
import { listCoilLots, listInventoryCoilSnapshots, listProducts, listProductionJobs, listStockMovements } from './readModel.js';
import { listMasterData } from './masterData.js';
import { listInTransitLoads } from './inTransitOps.js';
import { getProductRowForWorkspace } from './productBranchInventory.js';
import { listProductionJobCoils } from './productionTraceability.js';
import { isBranchManagerApprovalAuthority, isExecutiveRoleKey } from '../shared/workspaceGovernance.js';
import { purchaseUnitPriceMapByProductPrefix, resolveBranchCoilCostPerKg } from './materialPricingOps.js';
import { materialIncidentDamageSummaryForPeriod } from './materialIncidentOps.js';

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
    forwardedToManagerAtISO: row.forwarded_to_manager_at_iso || '',
    procurementCostedAtISO: row.procurement_costed_at_iso || '',
    procurementCostedByName: row.procurement_costed_by_name || '',
    bmAdjustments: parseBmAdjustments(row.bm_adjustments_json),
    procurementPricing: parseBmAdjustments(row.procurement_pricing_json),
    lineClearance: parseLineClearance(row.line_clearance_json),
    storeChecklist: parseStoreChecklist(row.store_checklist_json),
    countCutoffIso: row.count_cutoff_iso || '',
    printVersion: Number(row.print_version) || 1,
  };
}

function buildPackWithPeriodContext(db, branchId, periodEndIso, opts = {}) {
  const bid = String(branchId || '').trim();
  const viewMode = String(opts.viewMode || 'store').toLowerCase();
  const { periodKey, start, end } = periodBoundsFromEndDate(periodEndIso);
  if (!periodKey || !end) return { ok: false, error: 'Valid period end date required (YYYY-MM-DD).' };

  const prevEnd = previousPeriodEndIso(end);
  const prevSnapshots = listInventoryCoilSnapshots(db, prevEnd, bid);
  const { stone: stoneOpeningByProduct, accessory: accessoryOpeningByProduct } = openingMapsFromSnapshots(
    db,
    bid,
    prevEnd
  );
  const pack = buildStockRegisterPack({
    branchId: bid,
    periodEnd: end,
    coilLots: listCoilLots(db, bid),
    prevClosingSnapshots: prevSnapshots,
    productionJobs: listProductionJobs(db, bid),
    productionJobCoils: listProductionJobCoils(db, bid, { limit: 0 }),
    coilControlEvents: listCoilControlEventsInPeriod(db, bid, start, end),
    products: listProducts(db, bid),
    stockMovements: listStockMovements(db, bid),
    inTransitLoads: listInTransitLoads(db, bid),
    masterData: listMasterData(db),
    stoneOpeningByProduct,
    accessoryOpeningByProduct,
  });

  const periodRow = getPeriodRow(db, bid, periodKey);
  const adjustments = parseBmAdjustments(periodRow?.bm_adjustments_json);
  if (adjustments) applyBmAdjustmentsToRegister(pack, adjustments);
  applyLineClearanceToRegister(pack, periodRow?.line_clearance_json);

  const procurementPricing = parseBmAdjustments(periodRow?.procurement_pricing_json);
  const needsAutoValuation = viewMode === 'finance' && !procurementPricing;

  if (needsAutoValuation) {
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
  } else if (procurementPricing) {
    applyProcurementPricingToRegister(pack, procurementPricing);
  }

  const register =
    viewMode === 'finance' ? pack : prepareRegisterForView(pack, viewMode === 'procurement' ? 'procurement' : viewMode);

  const materialDamageSummary = materialIncidentDamageSummaryForPeriod(db, bid, start, end);
  register.materialDamageSummary = materialDamageSummary;

  return {
    ok: true,
    register,
    periodKey,
    periodEnd: end,
    workflow: mapPeriodRow(periodRow) || { status: 'draft', periodKey, periodEndIso: end, branchId: bid },
    fullPack: pack,
    materialDamageSummary,
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
 * @param {{ viewMode?: string }} [opts]
 */
export function buildStockRegisterForBranch(db, branchId, periodEndIso, opts = {}) {
  const built = buildPackWithPeriodContext(db, branchId, periodEndIso, opts);
  if (!built.ok) return built;
  return {
    ok: true,
    register: built.register,
    workflow: built.workflow,
    procurementSummary: built.register?.procurementSummary || built.fullPack?.procurementSummary,
  };
}

export function getStockRegisterWorkflow(db, branchId, periodKey) {
  const row = getPeriodRow(db, String(branchId || '').trim(), String(periodKey || '').trim());
  return { ok: true, workflow: mapPeriodRow(row) || null };
}

export function saveStockRegisterPrintSnapshot(db, branchId, periodEndIso, actor) {
  const built = buildStockRegisterForBranch(db, branchId, periodEndIso, { viewMode: 'store' });
  if (!built.ok) return built;
  const { periodKey, end } = periodBoundsFromEndDate(periodEndIso);
  const uid = String(actor?.id || actor?.userId || '').trim();
  const now = nowIso();
  const existing = getPeriodRow(db, branchId, periodKey);
  const print_version = (Number(existing?.print_version) || 0) + 1;
  const patch = {
    status: existing?.status && !['draft'].includes(String(existing.status)) ? existing.status : 'printed',
    register_json: JSON.stringify(built.register),
    print_snapshot_json: JSON.stringify(built.register),
    printed_at_iso: now,
    printed_by_user_id: uid || null,
    print_version,
  };
  upsertPeriodRow(db, branchId, periodKey, end, patch);
  appendAuditLog(db, {
    actor,
    action: 'stock_register.print',
    entityKind: 'stock_register_period',
    entityId: `${branchId}:${periodKey}`,
    note: `Print snapshot v${patch.print_version} for ${periodKey} (clearance preserved)`,
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

  if (action === 'store_confirm' || action === 'forward_to_manager') {
    if (!['printed', 'draft', 'store_confirmed'].includes(String(row.status))) {
      return { ok: false, error: 'Register must be printed before store confirmation.' };
    }
    const checklist = body?.storeChecklist || parseStoreChecklist(row.store_checklist_json);
    const checklistOk = validateStoreChecklist(checklist);
    if (!checklistOk.ok) return checklistOk;
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'store_confirmed',
      store_confirmed_at_iso: now,
      store_confirmed_by_user_id: actor?.id || null,
      store_confirmed_by_name: actorName(actor),
      count_notes: notes || row.count_notes,
      forwarded_to_manager_at_iso: now,
      store_checklist_json: JSON.stringify(checklist),
      count_cutoff_iso: String(body?.countCutoffIso || row.count_cutoff_iso || now).slice(0, 19),
    });
  } else if (action === 'bm_return_to_store') {
    if (!isBranchManagerApprovalAuthority(rk) && !isExecutiveRoleKey(rk)) {
      return { ok: false, error: 'Branch manager required to return register to store.' };
    }
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'printed',
      bm_approved_at_iso: null,
      bm_approved_by_user_id: null,
      bm_approved_by_name: null,
    });
  } else if (action === 'bm_approve') {
    if (!isBranchManagerApprovalAuthority(rk) && !isExecutiveRoleKey(rk)) {
      return { ok: false, error: 'Branch manager approval required.' };
    }
    if (!['store_confirmed', 'bm_approved'].includes(String(row.status))) {
      return { ok: false, error: 'Store must confirm the physical count before branch manager approval.' };
    }
    const built = buildPackWithPeriodContext(db, bid, row.period_end_iso, { viewMode: 'manager' });
    if (!built.ok) return built;
    const reg = built.fullPack || built.register;
    const clearanceRaw = body?.lineClearance || row.line_clearance_json;
    const approveCheck = validateBmApprove(reg, clearanceRaw, row.bm_adjustments_json);
    if (!approveCheck.ok) return approveCheck;
    const adjFromClearance = buildAdjustmentsFromClearance(reg, clearanceRaw);
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'bm_approved',
      bm_approved_at_iso: now,
      bm_approved_by_user_id: actor?.id || null,
      bm_approved_by_name: actorName(actor),
      bm_adjustments_json: JSON.stringify(adjFromClearance),
      line_clearance_json: typeof clearanceRaw === 'string' ? clearanceRaw : JSON.stringify(clearanceRaw || parseLineClearance(row.line_clearance_json)),
    });
    syncCoilProductionBlocks(db, reg, clearanceRaw, actor);
  } else if (action === 'procurement_lock' || action === 'procurement_cost') {
    if (!['procurement.manage', 'operations.manage'].some(() => false)) {
      /* permission checked at HTTP layer */
    }
    if (String(row.status) !== 'bm_approved') {
      return { ok: false, error: 'Branch manager must approve before procurement costing.' };
    }
    const pricing = body?.pricing || body?.procurementPricing;
    if (!pricing || typeof pricing !== 'object') {
      return { ok: false, error: 'Procurement pricing required.' };
    }
    upsertPeriodRow(db, bid, pk, row.period_end_iso, {
      status: 'procurement_costed',
      procurement_pricing_json: JSON.stringify(pricing),
      procurement_costed_at_iso: now,
      procurement_costed_by_user_id: actor?.id || null,
      procurement_costed_by_name: actorName(actor),
    });
  } else if (action === 'md_approve') {
    if (!isExecutiveRoleKey(rk)) {
      return { ok: false, error: 'Managing director approval required.' };
    }
    if (String(row.status) !== 'procurement_costed') {
      return { ok: false, error: 'Procurement must complete costing before MD approval.' };
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
  const st = String(row.status);
  if (st !== 'md_approved') {
    return { ok: false, error: 'MD approval required before capturing closing stock.' };
  }

  const built = buildPackWithPeriodContext(db, bid, end, { viewMode: 'finance' });
  if (!built.ok) return built;
  const reg = built.fullPack || built.register;
  const now = nowIso();

  if (!tableReady(db, 'inventory_coil_snapshots')) {
    return { ok: false, error: 'Snapshot table missing; run migrations.' };
  }

  const clearanceRaw = row.line_clearance_json;
  const lineItems = enumerateRegisterLineKeys(reg);
  const eligibleCoils = new Set(
    lineItems.filter((it) => it.kind === 'coil' && lineEligibleForClosing(it, clearanceRaw)).map((it) => it.row.coilNo)
  );
  const eligibleFinished = new Set(
    lineItems.filter((it) => it.kind === 'finished' && lineEligibleForClosing(it, clearanceRaw)).map((it) => it.row.coilNo)
  );

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
        if (!eligibleFinished.has(line.coilNo)) continue;
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
      if (!eligibleCoils.has(line.coilNo)) continue;
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
          const p = getProductRowForWorkspace(db, pid, bid);
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
  const row = db.prepare(`SELECT coil_no, branch_id FROM coil_lots WHERE coil_no = ?`).get(cn);
  if (!row) return { ok: false, error: 'Coil not found.' };
  const ws = String(opts.workspaceBranchId || '').trim();
  if (ws && ws !== 'ALL') {
    const coilBranch = String(row.branch_id || '').trim();
    if (coilBranch && coilBranch !== ws) {
      return { ok: false, error: 'This coil belongs to another branch workspace.' };
    }
  }
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

export function saveStockRegisterBmAdjustments(db, branchId, periodKey, adjustments, actor) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  if (!isBranchManagerApprovalAuthority(rk) && !isExecutiveRoleKey(rk)) {
    return { ok: false, error: 'Only a branch manager or executive can save BM stock-register adjustments.' };
  }
  const row = getPeriodRow(db, bid, pk);
  if (!row) return { ok: false, error: 'Register period not found. Print the register first.' };
  if (!['store_confirmed', 'printed', 'bm_approved'].includes(String(row.status))) {
    return { ok: false, error: 'Register must be with store or manager before saving adjustments.' };
  }
  upsertPeriodRow(db, bid, pk, row.period_end_iso, {
    bm_adjustments_json: JSON.stringify(adjustments || {}),
  });
  appendAuditLog(db, {
    actor,
    action: 'stock_register.bm_adjustments',
    entityKind: 'stock_register_period',
    entityId: `${bid}:${pk}`,
    note: 'BM stock count adjustments saved',
  });
  return { ok: true, workflow: mapPeriodRow(getPeriodRow(db, bid, pk)) };
}

export function saveStockRegisterLineClearance(db, branchId, periodKey, lineClearance, actor) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  if (!isBranchManagerApprovalAuthority(rk) && !isExecutiveRoleKey(rk)) {
    return { ok: false, error: 'Only a branch manager or executive can save stock-register line clearance.' };
  }
  const row = getPeriodRow(db, bid, pk);
  if (!row) return { ok: false, error: 'Register period not found. Print the register first.' };
  if (!['store_confirmed', 'printed', 'bm_approved'].includes(String(row.status))) {
    return { ok: false, error: 'Register must be with store or manager before saving line clearance.' };
  }
  const payload = typeof lineClearance === 'string' ? lineClearance : JSON.stringify(lineClearance || { lines: {} });
  upsertPeriodRow(db, bid, pk, row.period_end_iso, { line_clearance_json: payload });
  const built = buildPackWithPeriodContext(db, bid, row.period_end_iso, { viewMode: 'manager' });
  const adj = buildAdjustmentsFromClearance(built.fullPack || built.register, payload);
  upsertPeriodRow(db, bid, pk, row.period_end_iso, { bm_adjustments_json: JSON.stringify(adj) });
  appendAuditLog(db, {
    actor,
    action: 'stock_register.line_clearance',
    entityKind: 'stock_register_period',
    entityId: `${bid}:${pk}`,
    note: 'Line clearance saved',
  });
  return { ok: true, workflow: mapPeriodRow(getPeriodRow(db, bid, pk)), adjustments: adj };
}

export function saveStockRegisterStoreChecklist(db, branchId, periodKey, checklist, _actor) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const row = getPeriodRow(db, bid, pk);
  if (!row) return { ok: false, error: 'Register period not found.' };
  upsertPeriodRow(db, bid, pk, row.period_end_iso, {
    store_checklist_json: JSON.stringify(checklist || {}),
    count_cutoff_iso: String(checklist?.countCutoffIso || row.count_cutoff_iso || '').slice(0, 19) || null,
  });
  return { ok: true, workflow: mapPeriodRow(getPeriodRow(db, bid, pk)) };
}

export function getStockRegisterLineDetail(db, branchId, periodKey, lineKey) {
  const bid = String(branchId || '').trim();
  const pk = String(periodKey || '').trim();
  const row = getPeriodRow(db, bid, pk);
  if (!row) return { ok: false, error: 'Register period not found.' };
  const built = buildPackWithPeriodContext(db, bid, row.period_end_iso, { viewMode: 'manager' });
  if (!built.ok) return built;
  const reg = built.fullPack || built.register;
  const { start, end } = periodBoundsFromEndDate(row.period_end_iso);
  const item = enumerateRegisterLineKeys(reg).find((it) => it.key === lineKey);
  if (!item) return { ok: false, error: 'Line not found on register.' };
  const clearance = parseLineClearance(row.line_clearance_json);
  let productionJobs = [];
  if (item.kind === 'coil' || item.kind === 'finished') {
    productionJobs = coilProductionJobsInPeriod(
      listProductionJobs(db, bid),
      listProductionJobCoils(db, bid, { limit: 0 }),
      item.row.coilNo,
      start,
      end
    );
  }
  return {
    ok: true,
    lineKey,
    item,
    entry: clearance.lines[lineKey] || null,
    productionJobs,
    workflow: mapPeriodRow(row),
  };
}

function syncCoilProductionBlocks(db, register, clearanceRaw, actor) {
  const clearance = parseLineClearance(clearanceRaw);
  if (!tableReady(db, 'coil_lots')) return;
  const hasBlockCol = db.prepare(`PRAGMA table_info(coil_lots)`).all().some((c) => c.name === 'production_blocked');
  if (!hasBlockCol) return;
  const now = nowIso();
  const stmtBlock = db.prepare(
    `UPDATE coil_lots SET production_blocked = 1, production_block_reason = ?, production_block_set_at_iso = ? WHERE coil_no = ?`
  );
  const stmtUnblock = db.prepare(
    `UPDATE coil_lots SET production_blocked = 0, production_block_reason = NULL, production_block_set_at_iso = NULL WHERE coil_no = ?`
  );
  for (const item of enumerateRegisterLineKeys(register)) {
    if (item.kind !== 'finished') continue;
    const entry = clearance.lines[item.key] || {};
    const cn = item.row.coilNo;
    if (entry.finishedConfirm === FINISHED_CONFIRM.DISPUTED) {
      stmtBlock.run('Stock register: finished disputed — still on floor', now, cn);
      appendAuditLog(db, {
        actor,
        action: 'coil.production_block',
        entityKind: 'coil_lot',
        entityId: cn,
        note: 'Blocked pending stock register resolution',
      });
    } else if (entry.finishedConfirm === FINISHED_CONFIRM.CONFIRMED) {
      stmtUnblock.run(cn);
    }
  }
}

export function isCoilProductionBlocked(db, coilNo) {
  const cn = String(coilNo || '').trim();
  if (!cn || !tableReady(db, 'coil_lots')) return false;
  const cols = db.prepare(`PRAGMA table_info(coil_lots)`).all();
  if (!cols.some((c) => c.name === 'production_blocked')) return false;
  const row = db.prepare(`SELECT production_blocked FROM coil_lots WHERE coil_no = ?`).get(cn);
  return Boolean(row?.production_blocked);
}

export function listStockRegisterInbox(db, branchId, queue = 'manager') {
  const bid = String(branchId || '').trim();
  if (!tableReady(db, 'stock_register_periods')) return { ok: true, items: [] };
  let statuses;
  if (queue === 'procurement') statuses = ['bm_approved'];
  else if (queue === 'md') statuses = ['procurement_costed'];
  else if (queue === 'capture') statuses = ['md_approved'];
  else statuses = ['store_confirmed'];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM stock_register_periods
       WHERE branch_id = ? AND status IN (${placeholders})
       ORDER BY period_key DESC`
    )
    .all(bid, ...statuses);
  return {
    ok: true,
    items: rows.map((r) => mapPeriodRow(r)),
  };
}
