/**
 * Coil register (Reports Phase 1, material register). Pure: coil lots + stock movements + POs + jobs in →
 * stock at any date, PO kg ordered vs received, period consumption and exceptions out.
 *
 * - Stock per coil at date D = current kg rolled back by every coil movement dated after D (movement dateISO,
 *   never the job's completion date). Stock-check corrections (ADJUSTMENT / COIL_SCRAP / COIL_RETURN dated on
 *   or after `stockCheckCorrectionsFromISO`) are treated as true at every earlier date, so they are not rolled
 *   back. A coil is in stock at D when it was received on or before D and its rolled-back kg is above zero.
 * - Gross kg and kg net of the spool (Aluzinc incl. PPGI 65 kg, Aluminium 45 kg per coil; a coil lighter than its
 *   spool is nil net). Value at the coil's unitCostNgnPerKg; an opening coil with no cost takes the price recorded
 *   on the other coils of its material type in the same opening batch (listed as an exception).
 * - Received-date corrections are report annotations only (data unchanged): the ERP figure is always shown, and
 *   a second "with received-date corrections" figure when a correction applies.
 */

import { METRE_PRICE_THRESHOLD_NGN, purchaseUnitForLine } from './coilPurchaseUnit.js';

export { METRE_PRICE_THRESHOLD_NGN, purchaseUnitForLine };

/** Spool weight per coil. Aluminium bought by the metre arrives without a spool (owner, 2026-10-14). */
export const SPOOL_KG = { aluminium: 45, aluzinc: 65, aluminiumByMetre: 0 };

/**
 * Opening aluminium coils (no PO) are treated as bought by the metre (no spool) unless listed here as bought by
 * kg (owner, 2026-10-14). Report rule only; Phase 4 adds an explicit unit to coils and PO lines.
 */
export const OPENING_ALUMINIUM_BOUGHT_BY_KG = ['CL-KD-APR-1918'];


/** Oct 2026 stock-check corrections (owner, 2026-10-14): true at every earlier date. */
export const STOCK_CHECK_CORRECTIONS_FROM_ISO = '2026-10-01';

/** Report-only received-date notes (do not change data). */
export const COIL_RECEIVED_DATE_CORRECTIONS = [
  {
    coilNo: 'CL-26-2096',
    receivedISO: '2026-09-12',
    note: 'Delivered 12 Sep 2026 with PO-KD-26-0078; booked in the ERP on 12 Oct 2026 (owner note 2026-10-14).',
  },
];

/** Price differences above this share of the PO price per kg received are exceptions (spool alone is 2–4%). */
export const COIL_PRICE_TOLERANCE = 0.1;

/** A coil received this many days after the first coil of its PO is flagged as possibly booked late. */
export const COIL_LATE_BOOKING_DAYS = 7;

const COIL_MOVEMENT_TYPES = new Set(['COIL_CONSUMPTION', 'COIL_SCRAP', 'COIL_RETURN', 'STORE_GRN', 'ADJUSTMENT']);
const CORRECTION_TYPES = new Set(['ADJUSTMENT', 'COIL_SCRAP', 'COIL_RETURN']);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(num(n) * 100) / 100;
const ngn = (n) => Math.round(num(n));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** "2026-09-15", "2026-09-15T…", "4/30/26" (M/D/YY) or an Excel serial → "YYYY-MM-DD". */
export function normaliseDateISO(value) {
  if (typeof value === 'number' && value > 20000) {
    return new Date(Math.round((value - 25569) * 864e5)).toISOString().slice(0, 10);
  }
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return '';
}

function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((db - da) / 864e5);
}

/** 'aluminium' | 'aluzinc' | '' from the coil's material type (Aluzinc includes PPGI). */
export function coilFamily(materialTypeName, productID = '') {
  const t = norm(materialTypeName);
  if (/alumin/.test(t)) return 'aluminium';
  if (/aluzinc|ppgi/.test(t)) return 'aluzinc';
  if (productID === 'COIL-ALU') return 'aluminium';
  if (productID === 'PRD-102') return 'aluzinc';
  return '';
}

/** Aluzinc (incl. PPGI) 65 kg; aluminium bought by kg 45 kg; aluminium bought by metre 0. */
export function spoolKgForCoil(coil, boughtBy = 'kg') {
  const fam = coilFamily(coil?.materialTypeName, coil?.productID);
  if (fam === 'aluminium' && boughtBy === 'metre') return SPOOL_KG.aluminiumByMetre;
  return fam ? SPOOL_KG[fam] : 0;
}


/** Gross kg → { spoolKg, netKg }: a coil lighter than its spool is nil net. */
export function splitSpool(grossKg, spoolKg) {
  const g = Math.max(0, num(grossKg));
  const s = Math.min(g, Math.max(0, num(spoolKg)));
  return { spoolKg: round2(s), netKg: round2(g - s) };
}

/** Index movements by the coil they touch (coil no in ref or detail; longest numbers first). */
function indexCoilMovements(stockMovements, coilNos) {
  const sorted = [...coilNos].sort((a, b) => b.length - a.length);
  const byCoil = new Map();
  for (const m of stockMovements || []) {
    if (!COIL_MOVEMENT_TYPES.has(m.type)) continue;
    const ref = String(m.ref || '').trim();
    const coilNo = coilNos.has(ref) ? ref : sorted.find((c) => `${ref} ${m.detail || ''}`.includes(c)) || '';
    if (!coilNo) continue;
    const row = { ...m, coilNo, date: normaliseDateISO(m.dateISO || m.atISO), qty: num(m.qty) };
    const list = byCoil.get(coilNo) || [];
    list.push(row);
    byCoil.set(coilNo, list);
  }
  return byCoil;
}

/** Most common recorded unit cost among coils of one family received on one date. */
function openingBatchPrices(coils) {
  const counts = new Map();
  for (const c of coils) {
    const u = num(c.unitCostNgnPerKg);
    if (!(u > 0)) continue;
    const key = `${c.family}|${c.receivedISO}`;
    const m = counts.get(key) || new Map();
    m.set(u, (m.get(u) || 0) + 1);
    counts.set(key, m);
  }
  const out = new Map();
  for (const [key, m] of counts) out.set(key, [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]);
  return out;
}

/**
 * @param {object} input
 * @param {object[]} input.coilLots
 * @param {object[]} input.stockMovements — all movements up to today (roll-back needs those after the period)
 * @param {object[]} [input.purchaseOrders] — with `lines`
 * @param {object[]} [input.productionJobs]
 * @param {object[]} [input.quotations]
 * @param {string} input.startDate
 * @param {string} input.endDate
 * @param {{ coilNo: string, receivedISO: string, note?: string }[]} [input.receivedDateCorrections]
 * @param {string} [input.stockCheckCorrectionsFromISO]
 */
export function buildCoilRegister(input = {}) {
  const {
    coilLots = [],
    stockMovements = [],
    purchaseOrders = [],
    productionJobs = [],
    quotations = [],
    startDate = '',
    endDate = '',
    receivedDateCorrections = COIL_RECEIVED_DATE_CORRECTIONS,
    stockCheckCorrectionsFromISO = STOCK_CHECK_CORRECTIONS_FROM_ISO,
  } = input;
  const inPeriod = (iso) => Boolean(iso) && iso >= startDate && iso <= endDate;

  const coils = coilLots
    .map((c) => ({
      ...c,
      coilNo: String(c.coilNo || '').trim(),
      family: coilFamily(c.materialTypeName, c.productID),
      receivedISO: normaliseDateISO(c.receivedAtISO),
    }))
    .filter((c) => c.coilNo);
  const coilByNo = new Map(coils.map((c) => [c.coilNo, c]));
  const movesByCoil = indexCoilMovements(stockMovements, new Set(coilByNo.keys()));
  const batchPrice = openingBatchPrices(coils);
  const correctionByCoil = new Map((receivedDateCorrections || []).map((c) => [String(c.coilNo).trim(), c]));
  const isCorrection = (m) => CORRECTION_TYPES.has(m.type) && Boolean(stockCheckCorrectionsFromISO) && m.date >= stockCheckCorrectionsFromISO;

  const unitCost = (c) => {
    const line = lineOfCoil.get(c.coilNo);
    if (line && line.unit === 'metre' && line.costPerKg > 0) {
      return { unitCostNgnPerKg: round2(line.costPerKg), costSource: 'PO line amount ÷ kg received (bought by metre)' };
    }
    const own = num(c.unitCostNgnPerKg);
    if (own > 0) return { unitCostNgnPerKg: own, costSource: 'coil' };
    const landed = num(c.landedCostNgn);
    const w = num(c.weightKg) || num(c.qtyReceived);
    if (landed > 0 && w > 0) return { unitCostNgnPerKg: round2(landed / w), costSource: 'landed cost ÷ kg received' };
    const batch = batchPrice.get(`${c.family}|${c.receivedISO}`);
    if (batch) return { unitCostNgnPerKg: batch, costSource: `opening batch price (${c.receivedISO})` };
    return { unitCostNgnPerKg: 0, costSource: 'none' };
  };

  const coilsByPo = new Map();
  for (const c of coils) {
    if (!c.poID) continue;
    const list = coilsByPo.get(c.poID) || [];
    list.push(c);
    coilsByPo.set(c.poID, list);
  }
  const isCoilLine = (l) => /coil/i.test(String(l.productName || '')) || ['COIL-ALU', 'PRD-102'].includes(l.productID) || l.lineType === 'coil_kg';
  const linePrice = (l) => num(l.unitPricePerKgNgn) || num(l.unitPriceNgn);

  /**
   * Match each coil of a PO to a PO line: same gauge and colour first (closest kg), then any line still
   * without a coil, then the closest kg. A coil whose spec differs from its line is noted.
   */
  const matchCoilsToLines = (lines, poCoils) => {
    const coilsOfLine = lines.map(() => []);
    const kgOf = (c) => num(c.weightKg) || num(c.qtyReceived);
    const closest = (idxs, c) =>
      idxs.sort((a, b) => Math.abs(num(lines[a].qtyReceived) - kgOf(c)) - Math.abs(num(lines[b].qtyReceived) - kgOf(c)))[0];
    const all = lines.map((_, i) => i);
    for (const c of poCoils) {
      const same = all.filter((i) => norm(c.gaugeLabel) === norm(lines[i].gauge) && norm(c.colour) === norm(lines[i].color));
      const sameFree = same.filter((i) => !coilsOfLine[i].length);
      const free = all.filter((i) => !coilsOfLine[i].length);
      // A free line whose received kg is exactly this coil's weight wins, even when the coil spec was keyed differently.
      const exactKg = free.filter((i) => num(lines[i].qtyReceived) > 0 && Math.abs(num(lines[i].qtyReceived) - kgOf(c)) < 0.5);
      const pick = exactKg.length
        ? closest(exactKg, c)
        : sameFree.length
          ? closest(sameFree, c)
          : same.length
            ? closest(same, c)
            : free.length
              ? closest(free, c)
              : closest(all, c);
      const specMatches = same.includes(pick);
      coilsOfLine[pick].push({
        coilNo: c.coilNo,
        weightKg: round2(kgOf(c)),
        receivedISO: c.receivedISO,
        specNote: specMatches ? '' : `Coil is ${c.gaugeLabel} ${c.colour}; PO line is ${lines[pick].gauge} ${lines[pick].color}`,
      });
    }
    return coilsOfLine;
  };
  /**
   * Coil no → its PO line: purchase unit, line amount and cost per kg = line amount ÷ kg actually received on
   * that line (coil weights; metre lines store metres in the received field).
   */
  const lineOfCoil = new Map();
  const coilsOfLineByPo = new Map();
  for (const po of purchaseOrders) {
    const poID = String(po.poID || '').trim();
    const lines = (po.lines || []).filter(isCoilLine);
    if (!lines.length) continue;
    const coilsOfLine = matchCoilsToLines(lines, coilsByPo.get(poID) || []);
    coilsOfLineByPo.set(poID, coilsOfLine);
    lines.forEach((l, i) => {
      const { unit, rule } = purchaseUnitForLine(l);
      const amountNgn = num(l.qtyOrdered) * linePrice(l);
      const coilKg = coilsOfLine[i].reduce((sum, c) => sum + num(c.weightKg), 0);
      const kgReceived = coilKg > 0 ? coilKg : num(l.qtyReceived);
      for (const c of coilsOfLine[i]) {
        lineOfCoil.set(c.coilNo, {
          poID,
          unit,
          rule,
          linePrice: linePrice(l),
          amountNgn,
          kgReceived,
          costPerKg: kgReceived > 0 ? amountNgn / kgReceived : 0,
        });
      }
    });
  }
  /** Bought by kg / metre (opening coils with no PO: aluminium recorded at ≥ the metre threshold). */
  const boughtByOf = (c) => {
    const line = lineOfCoil.get(c.coilNo);
    if (line) return { boughtBy: line.unit, boughtByRule: line.rule };
    if (c.family === 'aluminium') {
      if (OPENING_ALUMINIUM_BOUGHT_BY_KG.includes(c.coilNo)) return { boughtBy: 'kg', boughtByRule: 'opening coil listed as bought by kg' };
      return { boughtBy: 'metre', boughtByRule: 'opening aluminium coil (no PO) — treated as bought by metre' };
    }
    return { boughtBy: 'kg', boughtByRule: 'no PO line' };
  };

  // --- Stock at a date -----------------------------------------------------------------------
  const stockAt = (asAtISO, { applyReceivedDateCorrections = false } = {}) => {
    const rows = [];
    for (const c of coils) {
      const corr = applyReceivedDateCorrections ? correctionByCoil.get(c.coilNo) : null;
      const received = corr?.receivedISO || c.receivedISO;
      if (!received || received > asAtISO) continue;
      let kg = num(c.currentWeightKg);
      for (const m of movesByCoil.get(c.coilNo) || []) {
        if (m.date > asAtISO && !isCorrection(m)) kg -= m.qty;
      }
      // Booked late: the GRN dated after D is the booking of a coil already on site at D.
      if (corr && received <= asAtISO) {
        for (const m of movesByCoil.get(c.coilNo) || []) if (m.type === 'STORE_GRN' && m.date > asAtISO) kg += m.qty;
      }
      kg = round2(kg);
      if (!(kg > 0)) continue;
      const { boughtBy, boughtByRule } = boughtByOf(c);
      const spool = spoolKgForCoil(c, boughtBy);
      const { spoolKg, netKg } = splitSpool(kg, spool);
      const { unitCostNgnPerKg, costSource } = unitCost(c);
      rows.push({
        coilNo: c.coilNo,
        family: c.family,
        boughtBy,
        boughtByRule,
        erpUnitCostNgnPerKg: num(c.unitCostNgnPerKg) || null,
        gaugeLabel: c.gaugeLabel || '',
        colour: c.colour || '',
        poID: c.poID || '',
        supplierName: c.supplierName || '',
        receivedISO: received,
        kgGross: kg,
        spoolKg,
        kgNet: netKg,
        unitCostNgnPerKg,
        costSource,
        valueGrossNgn: ngn(kg * unitCostNgnPerKg),
        spoolValueNgn: ngn(spoolKg * unitCostNgnPerKg),
        valueNetNgn: ngn(kg * unitCostNgnPerKg) - ngn(spoolKg * unitCostNgnPerKg),
        receivedDateNote: corr && corr.receivedISO !== c.receivedISO ? corr.note || `Received ${corr.receivedISO}` : '',
      });
    }
    rows.sort((a, b) => a.family.localeCompare(b.family) || a.coilNo.localeCompare(b.coilNo, undefined, { numeric: true }));
    const total = (list) => ({
      coilCount: list.length,
      kgGross: round2(list.reduce((s, r) => s + r.kgGross, 0)),
      spoolKg: round2(list.reduce((s, r) => s + r.spoolKg, 0)),
      kgNet: round2(list.reduce((s, r) => s + r.kgNet, 0)),
      valueGrossNgn: list.reduce((s, r) => s + r.valueGrossNgn, 0),
      spoolValueNgn: list.reduce((s, r) => s + r.spoolValueNgn, 0),
      valueNetNgn: list.reduce((s, r) => s + r.valueNetNgn, 0),
    });
    return {
      asAtISO,
      withReceivedDateCorrections: applyReceivedDateCorrections,
      rows,
      totals: total(rows),
      byFamily: {
        aluminium: total(rows.filter((r) => r.family === 'aluminium')),
        aluzinc: total(rows.filter((r) => r.family === 'aluzinc')),
      },
    };
  };

  const openingDate = dayBefore(startDate);
  const opening = stockAt(openingDate);
  const closing = stockAt(endDate);
  const openingCorrected = stockAt(openingDate, { applyReceivedDateCorrections: true });
  const closingCorrected = stockAt(endDate, { applyReceivedDateCorrections: true });
  const sameTotals = (a, b) => a.totals.coilCount === b.totals.coilCount && a.totals.kgGross === b.totals.kgGross;

  // --- Period consumption from COIL_CONSUMPTION movements --------------------------------------
  const jobById = new Map(productionJobs.map((j) => [String(j.jobID || '').trim(), j]));
  const consumptionLines = [];
  const coilConsumptionJobIds = new Set();
  /** "jobID|coilNo" → kg drawn by COIL_CONSUMPTION, any date (per-job rows use it whatever the job date). */
  const byJobCoilAllDates = {};
  for (const [coilNo, moves] of movesByCoil) {
    const c = coilByNo.get(coilNo);
    for (const m of moves) {
      if (m.type !== 'COIL_CONSUMPTION') continue;
      const jobRef = String(m.ref || '').trim();
      if (jobById.has(jobRef)) coilConsumptionJobIds.add(jobRef);
      const allKey = `${jobRef}|${coilNo}`;
      byJobCoilAllDates[allKey] = round2((byJobCoilAllDates[allKey] || 0) - m.qty);
      if (!inPeriod(m.date)) continue;
      consumptionLines.push({
        movementId: m.id,
        dateISO: m.date,
        jobID: jobRef,
        jobKnown: jobById.has(jobRef),
        coilNo,
        family: c?.family || '',
        kg: round2(-m.qty),
        detail: m.detail || '',
      });
    }
  }
  consumptionLines.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.coilNo.localeCompare(b.coilNo));
  const kgOf = (list) => round2(list.reduce((s, l) => s + l.kg, 0));
  const consumptionByJobCoil = new Map();
  for (const l of consumptionLines) {
    const key = `${l.jobID}|${l.coilNo}`;
    consumptionByJobCoil.set(key, round2((consumptionByJobCoil.get(key) || 0) + l.kg));
  }

  const quoteById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const stoneJobIds = new Set();
  let stoneConsumedM = 0;
  for (const m of stockMovements) {
    if (m.type !== 'STONE_CONSUMPTION' && m.type !== 'STONE_FLATSHEET_ISSUE') continue;
    stoneJobIds.add(String(m.ref || '').trim());
    if (m.type === 'STONE_CONSUMPTION' && inPeriod(normaliseDateISO(m.dateISO || m.atISO))) stoneConsumedM -= num(m.qty);
  }
  const jobDate = (j) => normaliseDateISO(j.completedAtISO || j.endDateISO);
  const jobsWithoutCoilConsumption = productionJobs
    .filter((j) => String(j.status || '').trim() === 'Completed' && inPeriod(jobDate(j)))
    .map((j) => ({ j, metres: num(j.actualMeters) || num(j.effectiveOutputMeters) }))
    .filter(({ j, metres }) => {
      const id = String(j.jobID || '').trim();
      if (!(metres > 0) || coilConsumptionJobIds.has(id) || stoneJobIds.has(id)) return false;
      return !quoteById.get(String(j.quotationRef || '').trim())?.stoneMeterQuote;
    })
    .map(({ j, metres }) => ({
      jobID: j.jobID,
      quotationRef: j.quotationRef,
      customerName: j.customerName || '',
      productName: j.productName || '',
      dateISO: jobDate(j),
      metres: round2(metres),
      actualWeightKg: round2(j.actualWeightKg),
      note: num(j.actualWeightKg) > 0 ? 'Weight recorded, no coil drawn (offcut / flat sheet?)' : 'No coil drawn and no weight recorded',
    }))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || String(a.jobID).localeCompare(String(b.jobID)));

  const consumption = {
    lines: consumptionLines,
    totals: {
      kg: kgOf(consumptionLines),
      aluminiumKg: kgOf(consumptionLines.filter((l) => l.family === 'aluminium')),
      aluzincKg: kgOf(consumptionLines.filter((l) => l.family === 'aluzinc')),
      lineCount: consumptionLines.length,
    },
    byJobCoil: Object.fromEntries(consumptionByJobCoil),
    byJobCoilAllDates,
    withoutJob: consumptionLines.filter((l) => !l.jobKnown),
    jobsWithoutCoilConsumption,
    stoneConsumedMetres: round2(stoneConsumedM),
  };

  // --- Per PO: kg ordered vs received -----------------------------------------------------------
  const grnInPeriodByPo = new Map();
  for (const [coilNo, moves] of movesByCoil) {
    for (const m of moves) {
      if (m.type !== 'STORE_GRN' || !inPeriod(m.date)) continue;
      const po = String(m.ref || coilByNo.get(coilNo)?.poID || '').trim();
      const list = grnInPeriodByPo.get(po) || [];
      list.push({ coilNo, kg: m.qty, dateISO: m.date });
      grnInPeriodByPo.set(po, list);
    }
  }
  const poRows = [];
  for (const po of purchaseOrders) {
    const poID = String(po.poID || '').trim();
    const lines = (po.lines || []).filter(isCoilLine);
    if (!lines.length) continue;
    const poCoils = coilsByPo.get(poID) || [];
    const coilsOfLine = coilsOfLineByPo.get(poID) || matchCoilsToLines(lines, poCoils);
    const ordered = normaliseDateISO(po.orderDateISO);
    const grn = grnInPeriodByPo.get(poID) || [];
    if (!inPeriod(ordered) && !grn.length) continue;
    const lineRows = lines.map((l, i) => {
      const kgOrdered = round2(l.qtyOrdered);
      const kgReceived = round2(l.qtyReceived);
      const price = linePrice(l);
      const { unit, rule } = purchaseUnitForLine(l);
      const coilKg = coilsOfLine[i].reduce((sum, c) => sum + num(c.weightKg), 0);
      const kgActual = coilKg > 0 ? coilKg : kgReceived;
      return {
        boughtBy: unit,
        boughtByRule: rule,
        coilKgReceived: round2(coilKg),
        costPerKgReceivedNgn: kgActual > 0 ? round2((kgOrdered * price) / kgActual) : null,
        notWeighed: kgReceived > 0 && kgReceived === kgOrdered,
        lineKey: l.lineKey || '',
        gauge: l.gauge || '',
        colour: l.color || '',
        productName: l.productName || '',
        kgOrdered,
        kgReceived,
        diffKg: round2(kgReceived - kgOrdered),
        unitPricePerKgNgn: price,
        lineValueNgn: ngn(kgOrdered * price),
        coils: coilsOfLine[i],
      };
    });
    const unmatchedCoils = [];
    const coilCount = poCoils.length;
    const kgOrdered = round2(lineRows.reduce((s, l) => s + l.kgOrdered, 0));
    const kgReceived = round2(lineRows.reduce((s, l) => s + l.kgReceived, 0));
    const poValueNgn = lineRows.reduce((s, l) => s + l.lineValueNgn, 0);
    poRows.push({
      poID,
      supplierName: po.supplierName || '',
      orderDateISO: ordered,
      orderedInPeriod: inPeriod(ordered),
      status: po.status || '',
      lines: lineRows,
      coilCount,
      unmatchedCoils,
      kgOrdered,
      kgReceived,
      diffKg: round2(kgReceived - kgOrdered),
      diffPerCoilKg: coilCount ? round2((kgReceived - kgOrdered) / coilCount) : null,
      poValueNgn,
      pricePerKgReceivedNgn: kgReceived > 0 ? round2(poValueNgn / kgReceived) : null,
      grnInPeriodKg: round2(grn.reduce((s, g) => s + g.kg, 0)),
      grnInPeriodValueNgn: grn.reduce((s, g) => s + ngn(g.kg * (unitCost(coilByNo.get(g.coilNo) || {}).unitCostNgnPerKg || 0)), 0),
    });
  }
  poRows.sort((a, b) => a.poID.localeCompare(b.poID, undefined, { numeric: true }));

  // --- Exceptions -----------------------------------------------------------------------------
  /** Every coil whose ERP cost/kg differs from its PO line amount ÷ kg received. */
  const costVsPurchase = [];
  for (const c of coils) {
    const line = lineOfCoil.get(c.coilNo);
    const erp = num(c.unitCostNgnPerKg);
    if (!line || !(line.costPerKg > 0) || !(erp > 0)) continue;
    const diff = erp - line.costPerKg;
    if (Math.abs(diff) < 1) continue;
    const kg = num(c.weightKg) || num(c.qtyReceived);
    costVsPurchase.push({
      coilNo: c.coilNo,
      poID: line.poID,
      boughtBy: line.unit,
      boughtByRule: line.rule,
      erpUnitCostNgnPerKg: erp,
      poLinePriceNgn: line.linePrice,
      costPerKgReceivedNgn: round2(line.costPerKg),
      differencePct: round2((diff / line.costPerKg) * 100),
      kgReceived: round2(kg),
      erpValueNgn: ngn(kg * erp),
      valueAtCostPerKgNgn: ngn(kg * line.costPerKg),
      note: `PO line ₦${ngn(line.amountNgn).toLocaleString('en-NG')} ÷ ${round2(line.kgReceived)} kg received`,
    });
  }
  costVsPurchase.sort((x, y) => Math.abs(y.differencePct) - Math.abs(x.differencePct) || x.coilNo.localeCompare(y.coilNo));

  const grnDateMismatch = [];
  for (const [coilNo, moves] of movesByCoil) {
    const c = coilByNo.get(coilNo);
    for (const m of moves) {
      if (m.type !== 'STORE_GRN' || !c?.receivedISO || m.date === c.receivedISO) continue;
      if (!inPeriod(m.date) && !inPeriod(c.receivedISO)) continue;
      grnDateMismatch.push({
        coilNo,
        poID: c.poID || String(m.ref || ''),
        coilReceivedISO: c.receivedISO,
        grnMovementISO: m.date,
        kg: round2(m.qty),
        note: 'Stock roll-back follows the movement date; the purchase register follows the coil received date',
      });
    }
  }
  /**
   * CHECK (owner, 2026-10-14): any coil, whatever the period, whose received date and GRN movement date fall in
   * different months. Month-end stock (movement dates) and purchases (received date) then disagree — this hid
   * ₦13.6m of cost on CL-26-2082 (received 31 Aug, GRN 1 Sep).
   */
  const grnMonthMismatch = [];
  for (const [coilNo, moves] of movesByCoil) {
    const c = coilByNo.get(coilNo);
    if (!c?.receivedISO) continue;
    for (const m of moves) {
      if (m.type !== 'STORE_GRN' || !m.date || m.date.slice(0, 7) === c.receivedISO.slice(0, 7)) continue;
      grnMonthMismatch.push({
        coilNo,
        poID: c.poID || String(m.ref || ''),
        coilReceivedISO: c.receivedISO,
        grnMovementISO: m.date,
        kg: round2(m.qty),
        valueNgn: ngn(m.qty * (unitCost(c).unitCostNgnPerKg || 0)),
        note: 'Received and GRN in different months: stock and purchases land in different months',
      });
    }
  }
  grnMonthMismatch.sort((a, b) => a.grnMovementISO.localeCompare(b.grnMovementISO) || a.coilNo.localeCompare(b.coilNo));

  const firstReceivedByPo = new Map();
  for (const c of coils) {
    if (!c.poID || !c.receivedISO) continue;
    const cur = firstReceivedByPo.get(c.poID);
    if (!cur || c.receivedISO < cur) firstReceivedByPo.set(c.poID, c.receivedISO);
  }
  const bookedLate = [];
  for (const c of coils) {
    const corr = correctionByCoil.get(c.coilNo);
    const first = firstReceivedByPo.get(c.poID);
    const lag = first && c.receivedISO ? daysBetween(first, c.receivedISO) : 0;
    if (!corr && lag <= COIL_LATE_BOOKING_DAYS) continue;
    bookedLate.push({
      coilNo: c.coilNo,
      poID: c.poID,
      bookedISO: c.receivedISO,
      firstCoilOfPoISO: first || '',
      daysAfterFirstCoil: lag,
      correctedReceivedISO: corr?.receivedISO || '',
      note: corr?.note || `Booked ${lag} days after the first coil of ${c.poID}; check the delivery date`,
    });
  }
  const noUnitCost = [];
  const seenNoCost = new Set();
  for (const r of [...opening.rows, ...closing.rows]) {
    if (r.erpUnitCostNgnPerKg || seenNoCost.has(r.coilNo)) continue;
    seenNoCost.add(r.coilNo);
    noUnitCost.push({ coilNo: r.coilNo, family: r.family, unitCostNgnPerKg: r.unitCostNgnPerKg, costSource: r.costSource });
  }

  return {
    period: { startDate, endDate, openingDate },
    stockCheckCorrectionsFromISO,
    stock: {
      opening,
      closing,
      openingWithCorrections: sameTotals(opening, openingCorrected) ? null : openingCorrected,
      closingWithCorrections: sameTotals(closing, closingCorrected) ? null : closingCorrected,
    },
    purchaseOrders: poRows,
    consumption,
    exceptions: {
      costVsPurchase,
      notWeighed: poRows.flatMap((p) =>
        p.lines
          .filter((l) => l.notWeighed)
          .map((l) => ({
            poID: p.poID,
            line: `${l.gauge} ${l.colour}`,
            boughtBy: l.boughtBy,
            kgOrdered: l.kgOrdered,
            kgReceived: l.kgReceived,
            coils: l.coils.map((c) => c.coilNo).join(', '),
            note: 'Received equals ordered exactly — not weighed?',
          }))
      ),
      bookedLate,
      noUnitCost,
      grnDateMismatch,
      grnMonthMismatch,
      coilSpecDiffersFromPoLine: poRows.flatMap((p) =>
        p.lines.flatMap((l) => l.coils.filter((c) => c.specNote).map((c) => ({ poID: p.poID, coilNo: c.coilNo, note: c.specNote })))
      ),
    },
  };
}
