/**
 * Month-end stock register — pure row builders (server + client mirror).
 * Sections: aluminium coils, aluzinc coils, stone-coated (m), accessories, summary, in-transit.
 */

import { displayCoilNumber } from './reportDisplayFormat.js';

export const SPOOL_KG_DEFAULT = { aluminium: 35, aluzinc: 60 };

/** Short management groups for accessory lines. */
export const ACCESSORY_REGISTER_TYPES = [
  { key: 'nails_fasteners', label: 'Nails & fasteners', patterns: [/nail/i, /fastener/i, /tapping screw/i] },
  { key: 'screws_clips', label: 'Screws & clips', patterns: [/screw/i, /clip/i, /washer/i] },
  { key: 'ridge_cap', label: 'Ridge & cap', patterns: [/ridge/i, /\bcap\b/i, /capping/i] },
  { key: 'flashing_trim', label: 'Flashing & trim', patterns: [/flash/i, /trim/i, /barge/i, /fascia/i, /gutter/i] },
  { key: 'sealants', label: 'Sealants & adhesives', patterns: [/silicone/i, /sealant/i, /adhesive/i, /glue/i] },
  { key: 'underlay', label: 'Underlay / membrane', patterns: [/underlay/i, /membrane/i, /felt/i] },
  { key: 'stone_accessories', label: 'Stone-coated accessories', patterns: [/stone nail/i, /stone-coated acc/i] },
  { key: 'other', label: 'Other', patterns: [] },
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toIsoDate(v) {
  return String(v || '').slice(0, 10);
}

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** @returns {'aluminium'|'aluzinc'|null} */
export function coilMaterialFamily(materialTypeName) {
  const k = normKey(materialTypeName);
  if (!k) return null;
  if (k.includes('aluzinc')) return 'aluzinc';
  if (k.includes('aluminium') || k.includes('aluminum') || k === 'alu') return 'aluminium';
  return null;
}

export function periodKeyFromEndDate(endDate) {
  const iso = toIsoDate(endDate);
  if (!iso || iso.length < 7) return '';
  return iso.slice(0, 7);
}

export function periodBoundsFromEndDate(endDate) {
  const end = toIsoDate(endDate);
  if (!end) return { periodKey: '', start: '', end: '' };
  const [y, m] = end.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  return { periodKey: end.slice(0, 7), start, end };
}

export function previousPeriodEndIso(endDate) {
  const end = toIsoDate(endDate);
  if (!end) return '';
  const [y, m] = end.split('-').map(Number);
  const d = new Date(y, m - 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function gaugeSortKey(gaugeLabel) {
  const m = String(gaugeLabel || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 999;
}

/**
 * @param {{ colours?: { abbreviation?: string; name?: string }[] } | null} masterData
 * @param {string} rawColour
 */
export function colourAbbrevForRegister(masterData, rawColour) {
  const raw = String(rawColour || '').trim();
  if (!raw) return '—';
  const colours = masterData?.colours || [];
  const nk = normKey(raw);
  for (const c of colours) {
    const abbr = String(c.abbreviation || '').trim();
    const name = String(c.name || '').trim();
    if (abbr && normKey(abbr) === nk) return abbr;
    if (name && normKey(name) === nk) return abbr || name.slice(0, 4).toUpperCase();
  }
  if (raw.length <= 5 && /^[A-Za-z]+$/.test(raw)) return raw.toUpperCase();
  return raw.slice(0, 5).toUpperCase();
}

/** Full colour name for stone-coated register lines (not abbreviated). */
export function colourFullNameForRegister(masterData, rawColour) {
  const raw = String(rawColour || '').trim();
  if (!raw) return '—';
  const colours = masterData?.colours || [];
  const nk = normKey(raw);
  for (const c of colours) {
    const name = String(c.name || '').trim();
    const abbr = String(c.abbreviation || '').trim();
    if (name && normKey(name) === nk) return name;
    if (abbr && normKey(abbr) === nk) return name || abbr;
  }
  return raw;
}

export function accessoryRegisterTypeKey(productName) {
  const name = String(productName || '').trim();
  for (const t of ACCESSORY_REGISTER_TYPES) {
    if (t.key === 'other') continue;
    if (t.patterns.some((p) => p.test(name))) return t.key;
  }
  return 'other';
}

export function accessoryRegisterTypeLabel(key) {
  return ACCESSORY_REGISTER_TYPES.find((t) => t.key === key)?.label || 'Other';
}

/**
 * Gross closing kg → net kg for valuation (rolls are already net).
 * @param {number} grossKg
 * @param {'aluminium'|'aluzinc'} materialFamily
 * @param {'coil'|'roll'} stockForm
 * @param {{ aluminium?: number; aluzinc?: number }} [spoolKg]
 */
export function netKgFromGrossClosing(grossKg, materialFamily, stockForm, spoolKg = SPOOL_KG_DEFAULT) {
  const gross = Math.max(0, Number(grossKg) || 0);
  if (stockForm === 'roll') return round2(gross);
  const spool = Number(spoolKg?.[materialFamily]) || 0;
  if (gross <= spool) return 0;
  return round2(gross - spool);
}

function inPeriod(iso, start, end) {
  const d = toIsoDate(iso);
  if (!d) return false;
  return (!start || d >= start) && (!end || d <= end);
}

/**
 * @param {object[]} productionJobs
 * @param {object[]} productionJobCoils
 */
export function coilProductionUsedByCoil(productionJobs, productionJobCoils, start, end) {
  const completed = new Set();
  for (const j of productionJobs || []) {
    if (String(j.status || '').trim() !== 'Completed') continue;
    const d = toIsoDate(j.completedAtISO || j.endDateISO);
    if (!inPeriod(d, start, end)) continue;
    completed.add(String(j.jobID || j.job_id || '').trim());
  }
  const byCoil = new Map();
  for (const c of productionJobCoils || []) {
    const jid = String(c.jobID || c.job_id || '').trim();
    if (!completed.has(jid)) continue;
    const cn = String(c.coilNo || c.coil_no || '').trim();
    if (!cn) continue;
    const used = Number(c.consumedWeightKg ?? c.consumed_weight_kg) || 0;
    byCoil.set(cn, round2((byCoil.get(cn) || 0) + used));
  }
  return byCoil;
}

/** Coil control scrap/adjustment outflows (kg). */
export function coilControlUsedByCoil(coilControlEvents, start, end) {
  const byCoil = new Map();
  for (const e of coilControlEvents || []) {
    const d = toIsoDate(e.dateISO || e.date_iso || e.createdAtISO || e.created_at_iso);
    if (!inPeriod(d, start, end)) continue;
    const cn = String(e.coilNo || e.coil_no || '').trim();
    if (!cn) continue;
    const delta = Number(e.kgCoilDelta ?? e.kg_coil_delta) || 0;
    if (delta >= 0) continue;
    byCoil.set(cn, round2((byCoil.get(cn) || 0) + Math.abs(delta)));
  }
  return byCoil;
}

function mergeUsedMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [k, v] of m) out.set(k, round2((out.get(k) || 0) + v));
  }
  return out;
}

function coilReceivedInPeriod(coilLots, start, end) {
  const byCoil = new Map();
  for (const lot of coilLots || []) {
    const cn = String(lot.coilNo || '').trim();
    const rd = toIsoDate(lot.receivedAtISO);
    if (!cn || !inPeriod(rd, start, end)) continue;
    const kg = Number(lot.weightKg ?? lot.qtyReceived) || 0;
    byCoil.set(cn, round2(kg));
  }
  return byCoil;
}

function openingFromPrevSnapshot(prevSnapshots) {
  const map = new Map();
  for (const row of prevSnapshots || []) {
    const cn = String(row.coilNo || row.coil_no || '').trim();
    if (!cn) continue;
    const kg = Number(row.currentWeightKg ?? row.current_weight_kg ?? row.closingKg) || 0;
    map.set(cn, round2(kg));
  }
  return map;
}

function systemTagsForCoilRow(row) {
  const tags = [];
  if (row.receivedKg > 0 && row.openingKg <= 0) tags.push('NEW');
  if (row.finishedInPeriod) tags.push('FINISHED');
  if (row.stockForm === 'roll') tags.push('ROLL');
  if (row.countVarianceKg != null && Math.abs(row.countVarianceKg) >= 0.5) tags.push('COUNT_VAR');
  return tags;
}

function buildCoilLine(lot, ctx) {
  const cn = String(lot.coilNo || '').trim();
  const family = coilMaterialFamily(lot.materialTypeName);
  if (!family) return null;

  const openingKg = round2(ctx.openingByCoil.get(cn) || 0);
  const receivedKg = round2(ctx.receivedByCoil.get(cn) || 0);
  const usedKg = round2(ctx.usedByCoil.get(cn) || 0);
  const stockForm = String(lot.stockForm || lot.stock_form || 'coil').toLowerCase() === 'roll' ? 'roll' : 'coil';

  const liveKg = Number(lot.currentWeightKg) || 0;
  const closingCalc = round2(openingKg + receivedKg - usedKg);
  const consumedNow = liveKg <= 0.0001 || String(lot.currentStatus || '').trim() === 'Consumed';
  const finishedInPeriod = consumedNow && (usedKg > 0 || receivedKg > 0 || openingKg > 0);

  if (!finishedInPeriod && openingKg <= 0 && receivedKg <= 0 && usedKg <= 0 && liveKg <= 0.0001) {
    return null;
  }
  if (consumedNow && !finishedInPeriod && openingKg <= 0 && receivedKg <= 0 && usedKg <= 0) {
    return null;
  }

  const closingKg = finishedInPeriod ? null : closingCalc > 0 ? closingCalc : liveKg > 0 ? round2(liveKg) : 0;
  const countVarianceKg =
    closingKg != null && liveKg > 0 && Math.abs(closingCalc - liveKg) >= 0.5 ? round2(liveKg - closingCalc) : null;

  const row = {
    colourAbbrev: colourAbbrevForRegister(ctx.masterData, lot.colour),
    coilNo: cn,
    coilNoDisplay: displayCoilNumber(cn) || cn,
    gaugeLabel: String(lot.gaugeLabel || '').trim() || '—',
    materialFamily: family,
    openingKg,
    receivedKg,
    usedKg,
    closingKg,
    closingBlank: finishedInPeriod,
    finishedInPeriod,
    stockForm,
    remark: '',
    unitCostNgnPerKg: lot.unitCostNgnPerKg != null ? Math.round(Number(lot.unitCostNgnPerKg)) : null,
    countVarianceKg,
  };
  row.systemTags = systemTagsForCoilRow(row);
  row.remarkSuggested = row.systemTags.length ? row.systemTags.join(', ') : '';
  return row;
}

function groupCoilRowsByGauge(rows) {
  const byGauge = new Map();
  for (const r of rows) {
    const g = r.gaugeLabel || '—';
    if (!byGauge.has(g)) byGauge.set(g, []);
    byGauge.get(g).push(r);
  }
  return [...byGauge.entries()]
    .sort((a, b) => gaugeSortKey(a[0]) - gaugeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
    .map(([gaugeLabel, coilRows]) => ({
      gaugeLabel,
      rows: coilRows.sort(
        (a, b) =>
          String(a.colourAbbrev).localeCompare(String(b.colourAbbrev)) ||
          String(a.coilNo).localeCompare(String(b.coilNo))
      ),
      subtotalOpeningKg: round2(coilRows.reduce((s, r) => s + r.openingKg, 0)),
      subtotalUsedKg: round2(coilRows.reduce((s, r) => s + r.usedKg, 0)),
      subtotalClosingKg: round2(coilRows.reduce((s, r) => s + (r.closingKg ?? 0), 0)),
    }));
}

function buildCoilSections(coilLots, ctx) {
  const alu = [];
  const aluz = [];
  for (const lot of coilLots || []) {
    const line = buildCoilLine(lot, ctx);
    if (!line) continue;
    if (line.materialFamily === 'aluminium') alu.push(line);
    else if (line.materialFamily === 'aluzinc') aluz.push(line);
  }
  return {
    aluminium: { groups: groupCoilRowsByGauge(alu), rowCount: alu.length },
    aluzinc: { groups: groupCoilRowsByGauge(aluz), rowCount: aluz.length },
  };
}

function isStoneProduct(p) {
  const pid = String(p.productID || p.product_id || '');
  const unit = String(p.unit || '').toLowerCase();
  const attrs = p.dashboardAttrs || {};
  if (pid.startsWith('STONE-')) return true;
  if (attrs.inventoryModel === 'stone_meter') return true;
  if (attrs.stoneDesign || attrs.stoneFlatsheet) return true;
  if (unit === 'm' && attrs.materialType && normKey(attrs.materialType).includes('stone')) return true;
  return false;
}

function isAccessoryProduct(p) {
  const pid = String(p.productID || '');
  if (pid.startsWith('ACC-')) return true;
  const attrs = p.dashboardAttrs || {};
  if (attrs.inventoryModel === 'consumable') return true;
  const mt = normKey(attrs.materialType || p.name);
  return mt.includes('accessory') || pid.includes('ACC');
}

function productMovementsInPeriod(movements, productId, start, end) {
  let received = 0;
  let used = 0;
  for (const m of movements || []) {
    if (String(m.productID || m.product_id || '') !== productId) continue;
    const d = toIsoDate(m.dateISO || m.date_iso || m.atISO || m.at_iso);
    if (!inPeriod(d, start, end)) continue;
    const qty = Number(m.qty) || 0;
    if (qty > 0) received += qty;
    else if (qty < 0) used += Math.abs(qty);
  }
  return { received: round2(received), used: round2(used) };
}

function buildStoneSection(products, movements, openingByProduct, start, end, masterData) {
  const rows = [];
  for (const p of products || []) {
    if (!isStoneProduct(p)) continue;
    const pid = String(p.productID || '');
    const stock = Number(p.stockLevel) || 0;
    if (stock <= 0.0001) {
      const mv = productMovementsInPeriod(movements, pid, start, end);
      if (mv.received <= 0 && mv.used <= 0 && !(openingByProduct.get(pid) > 0)) continue;
    }
    const gauge = String(p.dashboardAttrs?.gauge || '').trim() || '—';
    const colour = String(p.dashboardAttrs?.colour || p.name || '').trim();
    const opening = round2(openingByProduct.get(pid) || 0);
    const { received, used } = productMovementsInPeriod(movements, pid, start, end);
    const total = round2(opening + received);
    const remaining = round2(total - used);
    if (opening <= 0 && received <= 0 && used <= 0 && remaining <= 0) continue;
    rows.push({
      gaugeLabel: gauge,
      colour,
      colourDisplay: colourFullNameForRegister(masterData, colour),
      colourAbbrev: colourAbbrevForRegister(masterData, colour),
      productID: pid,
      openingM: opening,
      receivedM: received,
      totalM: total,
      usedM: used,
      remainingM: remaining,
      remark: '',
    });
  }
  const byGauge = new Map();
  for (const r of rows) {
    if (!byGauge.has(r.gaugeLabel)) byGauge.set(r.gaugeLabel, []);
    byGauge.get(r.gaugeLabel).push(r);
  }
  const groups = [...byGauge.entries()]
    .sort((a, b) => gaugeSortKey(a[0]) - gaugeSortKey(b[0]))
    .map(([gaugeLabel, stoneRows]) => ({
      gaugeLabel,
      rows: stoneRows.sort((a, b) => String(a.colourDisplay).localeCompare(String(b.colourDisplay))),
    }));
  return { groups, rowCount: rows.length };
}

function buildAccessorySection(products, movements, openingByProduct, start, end, displayNameByProduct = null) {
  const rows = [];
  for (const p of products || []) {
    if (!isAccessoryProduct(p)) continue;
    const pid = String(p.productID || '');
    const unit = String(p.unit || 'unit').trim();
    const catalogName = String(p.name || '').trim() || pid;
    const itemName = String(displayNameByProduct?.get(pid) || catalogName).trim() || pid;
    const opening = round2(openingByProduct.get(pid) || 0);
    const { received, used } = productMovementsInPeriod(movements, pid, start, end);
    const balance = round2(Number(p.stockLevel) || opening + received - used);
    if (opening <= 0 && received <= 0 && used <= 0 && balance <= 0) continue;
    rows.push({
      productID: pid,
      itemName,
      unit,
      opening,
      received,
      used,
      balance,
      remark: '',
    });
  }
  rows.sort((a, b) => String(a.itemName).localeCompare(String(b.itemName)));
  return { rows, rowCount: rows.length };
}

function buildInTransitAppendix(inTransitLoads, branchId) {
  const bid = String(branchId || '').trim();
  const rows = [];
  for (const load of inTransitLoads || []) {
    const st = String(load.status || '').toLowerCase();
    if (st === 'received' || st === 'cancelled') continue;
    if (bid && String(load.destinationBranchId || load.branchId || '').trim() !== bid) continue;
    for (const line of load.lines || []) {
      const qtyExpected = round2(Math.max(0, Number(line.qtyLoaded) - Number(line.qtyReceived)));
      if (qtyExpected <= 0) continue;
      rows.push({
        referenceNo: load.referenceNo || load.id,
        poId: load.purchaseOrderId || '',
        itemName: line.itemName || line.productId || '',
        qtyExpected,
        unit: line.unit || '',
        waybillRef: load.waybillRef || load.transportReference || '',
        etaDateIso: load.etaDateIso || '',
        status: load.status,
        remark: load.exceptionNote || '',
      });
    }
  }
  return rows;
}

function coilSectionSummary(groups, materialFamily, spoolKg, fallbackUnitCostNgnPerKg = null) {
  let grossClosingKg = 0;
  let netClosingKg = 0;
  let valueNgn = 0;
  const fallback = Number(fallbackUnitCostNgnPerKg) || 0;
  for (const g of groups || []) {
    for (const r of g.rows || []) {
      if (r.closingKg == null) continue;
      const gross = Number(r.closingKg) || 0;
      grossClosingKg += gross;
      const net = netKgFromGrossClosing(gross, materialFamily, r.stockForm, spoolKg);
      netClosingKg += net;
      const uc = Number(r.unitCostNgnPerKg) || fallback;
      if (uc > 0) valueNgn += Math.round(net * uc);
    }
  }
  const spoolAdj = round2(grossClosingKg - netClosingKg);
  return {
    materialFamily,
    grossClosingKg: round2(grossClosingKg),
    spoolAdjustmentKg: spoolAdj,
    netClosingKg: round2(netClosingKg),
    valueNgn: Math.round(valueNgn),
    unitCostNgnPerKg: fallback > 0 ? Math.round(fallback) : null,
  };
}

/**
 * Apply purchase / receipt unit prices to summary closing values (coils, stone, accessories).
 * @param {ReturnType<typeof buildStockRegisterPack>} register
 * @param {{
 *   aluminiumUnitCostNgnPerKg?: number|null;
 *   aluzincUnitCostNgnPerKg?: number|null;
 *   stoneUnitPriceByProduct?: Map<string, number>;
 *   stoneFallbackUnitPriceNgnPerM?: number|null;
 *   accessoryUnitPriceByProduct?: Map<string, number>;
 *   accessoryFallbackUnitPriceNgn?: number|null;
 *   priceLookbackDays?: number;
 *   priceSources?: Record<string, string>;
 * }} pricing
 */
export function enrichStockRegisterValuation(register, pricing = {}) {
  if (!register) return register;
  const spoolKg = pricing.spoolKg || SPOOL_KG_DEFAULT;
  const lookback = pricing.priceLookbackDays ?? 31;
  const sources = pricing.priceSources || {};

  const aluCost = Number(pricing.aluminiumUnitCostNgnPerKg) || 0;
  const aluzCost = Number(pricing.aluzincUnitCostNgnPerKg) || 0;

  register.summary = register.summary || {};
  register.summary.aluminium = coilSectionSummary(
    register.coilSections?.aluminium?.groups,
    'aluminium',
    spoolKg,
    aluCost
  );
  register.summary.aluminium.unitCostNgnPerKg = aluCost > 0 ? Math.round(aluCost) : null;
  register.summary.aluminium.priceSource = sources.aluminium || (aluCost > 0 ? 'purchase_avg' : 'none');
  register.summary.aluminium.priceLookbackDays = lookback;

  register.summary.aluzinc = coilSectionSummary(
    register.coilSections?.aluzinc?.groups,
    'aluzinc',
    spoolKg,
    aluzCost
  );
  register.summary.aluzinc.unitCostNgnPerKg = aluzCost > 0 ? Math.round(aluzCost) : null;
  register.summary.aluzinc.priceSource = sources.aluzinc || (aluzCost > 0 ? 'purchase_avg' : 'none');
  register.summary.aluzinc.priceLookbackDays = lookback;

  const stoneMap = pricing.stoneUnitPriceByProduct || new Map();
  const stoneFallback = Number(pricing.stoneFallbackUnitPriceNgnPerM) || 0;
  let stoneRemainingM = 0;
  let stoneValueNgn = 0;
  let stonePriceWeighted = 0;
  let stonePriceWeight = 0;
  for (const g of register.stoneCoated?.groups || []) {
    for (const r of g.rows || []) {
      const price = Number(stoneMap.get(r.productID)) || stoneFallback;
      r.unitPriceNgnPerM = price > 0 ? Math.round(price) : null;
      r.closingValueNgn = price > 0 ? Math.round((Number(r.remainingM) || 0) * price) : 0;
      stoneRemainingM += Number(r.remainingM) || 0;
      stoneValueNgn += r.closingValueNgn;
      if (price > 0 && r.remainingM > 0) {
        stonePriceWeighted += price * r.remainingM;
        stonePriceWeight += r.remainingM;
      }
    }
  }
  register.summary.stoneCoated = {
    totalRemainingM: round2(stoneRemainingM),
    valueNgn: Math.round(stoneValueNgn),
    unitPriceNgnPerM:
      stonePriceWeight > 0 ? Math.round(stonePriceWeighted / stonePriceWeight) : stoneFallback > 0 ? Math.round(stoneFallback) : null,
    priceSource: sources.stoneCoated || (stoneValueNgn > 0 ? 'receipt_avg' : 'none'),
    priceLookbackDays: lookback,
  };

  const accMap = pricing.accessoryUnitPriceByProduct || new Map();
  const accFallback = Number(pricing.accessoryFallbackUnitPriceNgn) || 0;
  let accValueNgn = 0;
  let accPriceWeighted = 0;
  let accPriceWeight = 0;
  for (const r of register.accessories?.rows || []) {
    const price = Number(accMap.get(r.productID)) || accFallback;
    r.unitPriceNgn = price > 0 ? Math.round(price) : null;
    r.closingValueNgn = price > 0 ? Math.round((Number(r.balance) || 0) * price) : 0;
    accValueNgn += r.closingValueNgn;
    if (price > 0 && r.balance > 0) {
      accPriceWeighted += price * r.balance;
      accPriceWeight += r.balance;
    }
  }
  register.summary.accessories = {
    rowCount: register.accessories?.rowCount || 0,
    valueNgn: Math.round(accValueNgn),
    unitPriceNgn: accPriceWeight > 0 ? Math.round(accPriceWeighted / accPriceWeight) : accFallback > 0 ? Math.round(accFallback) : null,
    priceSource: sources.accessories || (accValueNgn > 0 ? 'receipt_avg' : 'none'),
    priceLookbackDays: lookback,
  };

  register.summary.totalClosingValueNgn = Math.round(
    (register.summary.aluminium?.valueNgn || 0) +
      (register.summary.aluzinc?.valueNgn || 0) +
      (register.summary.stoneCoated?.valueNgn || 0) +
      (register.summary.accessories?.valueNgn || 0)
  );

  return register;
}

/**
 * @param {object} opts
 * @param {string} opts.branchId
 * @param {string} opts.periodEnd
 * @param {object[]} opts.coilLots
 * @param {object[]} [opts.prevClosingSnapshots]
 * @param {object[]} opts.productionJobs
 * @param {object[]} opts.productionJobCoils
 * @param {object[]} opts.coilControlEvents
 * @param {object[]} opts.products
 * @param {object[]} opts.stockMovements
 * @param {object[]} [opts.inTransitLoads]
 * @param {object|null} [opts.masterData]
 * @param {Map<string, number>} [opts.stoneOpeningByProduct]
 * @param {Map<string, number>} [opts.accessoryOpeningByProduct]
 * @param {Map<string, string>} [opts.accessoryDisplayNameByProduct]
 * @param {{ aluminium?: number; aluzinc?: number }} [opts.spoolKg]
 */
export function buildStockRegisterPack(opts = {}) {
  const { start, end, periodKey } = periodBoundsFromEndDate(opts.periodEnd);
  const spoolKg = opts.spoolKg || SPOOL_KG_DEFAULT;

  const openingByCoil = openingFromPrevSnapshot(opts.prevClosingSnapshots);
  const receivedByCoil = coilReceivedInPeriod(opts.coilLots, start, end);
  const usedByCoil = mergeUsedMaps(
    coilProductionUsedByCoil(opts.productionJobs, opts.productionJobCoils, start, end),
    coilControlUsedByCoil(opts.coilControlEvents, start, end)
  );

  for (const lot of opts.coilLots || []) {
    const cn = String(lot.coilNo || '').trim();
    if (!cn || openingByCoil.has(cn)) continue;
    const rd = toIsoDate(lot.receivedAtISO);
    if (rd && rd < start) {
      const live = Number(lot.currentWeightKg) || 0;
      const rec = receivedByCoil.get(cn) || 0;
      const used = usedByCoil.get(cn) || 0;
      openingByCoil.set(cn, round2(Math.max(0, live + used - rec)));
    }
  }

  const ctx = {
    openingByCoil,
    receivedByCoil,
    usedByCoil,
    masterData: opts.masterData || null,
  };

  const coilSections = buildCoilSections(opts.coilLots, ctx);
  const stone = buildStoneSection(
    opts.products,
    opts.stockMovements,
    opts.stoneOpeningByProduct || new Map(),
    start,
    end,
    opts.masterData
  );
  const accessories = buildAccessorySection(
    opts.products,
    opts.stockMovements,
    opts.accessoryOpeningByProduct || new Map(),
    start,
    end,
    opts.accessoryDisplayNameByProduct || null
  );
  const inTransit = buildInTransitAppendix(opts.inTransitLoads, opts.branchId);

  const summary = {
    aluminium: coilSectionSummary(coilSections.aluminium.groups, 'aluminium', spoolKg, null),
    aluzinc: coilSectionSummary(coilSections.aluzinc.groups, 'aluzinc', spoolKg, null),
    stoneCoated: {
      totalRemainingM: round2(
        stone.groups.flatMap((g) => g.rows).reduce((s, r) => s + r.remainingM, 0)
      ),
      valueNgn: 0,
      unitPriceNgnPerM: null,
      priceSource: 'none',
    },
    accessories: {
      rowCount: accessories.rowCount,
      valueNgn: 0,
      unitPriceNgn: null,
      priceSource: 'none',
    },
    totalClosingValueNgn: 0,
  };

  return {
    branchId: opts.branchId || '',
    periodKey,
    periodStart: start,
    periodEnd: end,
    businessDateRule: 'Movements included by business date (dateISO / completion date), not system post time.',
    coilSections,
    stoneCoated: stone,
    accessories,
    inTransit,
    summary,
    meta: {
      openingSource: (opts.prevClosingSnapshots || []).length ? 'previous_capture' : 'derived_live',
      coilRowCount: coilSections.aluminium.rowCount + coilSections.aluzinc.rowCount,
    },
  };
}
