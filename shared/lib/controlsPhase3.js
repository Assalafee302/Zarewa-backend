/**
 * Phase 3 controls (owner, 2026-10-14) — pure rules shared by server and frontend.
 * Frontend copy via `npm run sync:shared` → src/shared/lib/controlsPhase3.js
 *
 * 1. Production gate paid basis + "Balance due after production" list.
 * 2. Receipts: an advance already in treasury must be applied, not posted again as RECEIPT_IN (TM-KD-26-1499).
 * 3. Coil GRN: weighed kg vs PO (2% warning).
 * 4. PO line unit kg | metre; metre-bought coil cost per kg = amount paid ÷ weighed kg.
 * 5. Spool: net kg = weighed kg − spool.
 * 6. Locked-period change flag on audit rows.
 */
import { purchaseUnitForLine } from './coilPurchaseUnit.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ngn = (v) => Math.round(num(v));
const round2 = (v) => Math.round(num(v) * 100) / 100;
const key = (v) => String(v ?? '').trim().toUpperCase();

/* ---------------------------------------------------------------- 1. production gate */

/** Receipt statuses that no longer count toward a quotation (same rule as receiptCountsTowardQuotationPaidSql). */
export function receiptCountsTowardPaid(status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (!s) return true;
  if (s === 'reversed') return false;
  return !/^suspended.*investigation$/.test(s);
}

/**
 * Paid toward a quotation for the production gate = receipts + advance/overpay credit applied − treasury reversals of
 * receipt lines that are still counted (a partial reversal like TM-KD-26-1499 leaves the receipt "Posted").
 * @param {{
 *   quotationRef: string,
 *   receipts: { id?: string, ledgerEntryId?: string, quotationRef: string, amountNgn: number, status?: string }[],
 *   ledgerEntries: { type: string, quotationRef?: string, amountNgn: number }[],
 *   treasuryMovements: { id: string, type: string, sourceKind?: string, sourceId?: string, amountNgn: number, reversesMovementId?: string | null }[],
 * }} input
 */
export function productionGatePaid({ quotationRef, receipts = [], ledgerEntries = [], treasuryMovements = [] }) {
  const q = key(quotationRef);
  const counted = receipts.filter((r) => key(r.quotationRef) === q && receiptCountsTowardPaid(r.status));
  const receiptsNgn = counted.reduce((s, r) => s + ngn(r.amountNgn), 0);
  const creditAppliedNgn = ledgerEntries
    .filter((e) => key(e.quotationRef) === q && (e.type === 'ADVANCE_APPLIED' || e.type === 'OVERPAY_APPLIED'))
    .reduce((s, e) => s + ngn(e.amountNgn), 0);

  const sourceIds = new Set(counted.flatMap((r) => [key(r.ledgerEntryId), key(r.id)]).filter(Boolean));
  const receiptInIds = new Set(
    treasuryMovements
      .filter((m) => m.type === 'RECEIPT_IN' && sourceIds.has(key(m.sourceId)))
      .map((m) => key(m.id))
  );
  const reversalsNgn = treasuryMovements
    .filter((m) => m.reversesMovementId && receiptInIds.has(key(m.reversesMovementId)))
    .reduce((s, m) => s + Math.abs(ngn(m.amountNgn)), 0);

  const paidNgn = receiptsNgn + creditAppliedNgn - Math.min(reversalsNgn, receiptsNgn);
  return { receiptsNgn, creditAppliedNgn, reversalsNgn, paidNgn };
}

/**
 * Produced jobs whose quotation is under 100% paid ("Balance due after production").
 * @param {{
 *   jobs: { jobID: string, quotationRef: string, status: string, completedAtISO?: string, customerName?: string }[],
 *   quotations: { id: string, customerName?: string, totalNgn: number }[],
 *   paidByQuotation: Map<string, number> | Record<string, number>,
 * }} input
 */
export function balanceDueAfterProduction({ jobs = [], quotations = [], paidByQuotation = {} }) {
  const paidOf = (id) =>
    paidByQuotation instanceof Map ? num(paidByQuotation.get(id)) : num(paidByQuotation[id]);
  const quotes = new Map(quotations.map((q) => [key(q.id), q]));
  const byQuote = new Map();
  for (const j of jobs) {
    if (String(j.status || '').toLowerCase() !== 'completed') continue;
    const q = quotes.get(key(j.quotationRef));
    if (!q) continue;
    const prev = byQuote.get(q.id);
    const done = String(j.completedAtISO || '').slice(0, 10);
    if (!prev) byQuote.set(q.id, { q, jobIDs: [j.jobID], firstCompletedISO: done, customerName: j.customerName });
    else {
      prev.jobIDs.push(j.jobID);
      if (done && (!prev.firstCompletedISO || done < prev.firstCompletedISO)) prev.firstCompletedISO = done;
    }
  }
  const rows = [];
  for (const { q, jobIDs, firstCompletedISO, customerName } of byQuote.values()) {
    const totalNgn = ngn(q.totalNgn);
    const paidNgn = ngn(paidOf(q.id));
    const owedNgn = totalNgn - paidNgn;
    if (totalNgn <= 0 || owedNgn <= 0) continue;
    rows.push({
      quotationRef: q.id,
      customerName: q.customerName || customerName || '',
      jobIDs,
      firstCompletedISO,
      totalNgn,
      paidNgn,
      owedNgn,
      paidPct: Math.floor((paidNgn / totalNgn) * 1000) / 10,
    });
  }
  rows.sort((a, b) => b.owedNgn - a.owedNgn || a.quotationRef.localeCompare(b.quotationRef));
  return { rows, totalOwedNgn: rows.reduce((s, r) => s + r.owedNgn, 0) };
}

/* ---------------------------------------------------------------- 2. receipts */

export const OVERRIDE_REASON_MIN_LEN = 8;

/**
 * Treasury lines of a new receipt that repeat an advance already in treasury (ADVANCE_IN) while that advance is still
 * unapplied: the money is already counted, so it must be applied to the quotation instead (TM-KD-26-1499).
 * @param {{ lines: { amountNgn: number }[], advanceMovements: { id: string, amountNgn: number, postedAtISO?: string }[], advanceBalanceNgn: number }} input
 * @returns {{ lineIndex: number, amountNgn: number, movementId: string, postedAtISO: string }[]}
 */
export function receiptLinesRepeatingAdvance({ lines = [], advanceMovements = [], advanceBalanceNgn = 0 }) {
  const balance = ngn(advanceBalanceNgn);
  if (balance <= 0) return [];
  const used = new Set();
  const hits = [];
  lines.forEach((line, lineIndex) => {
    const amt = ngn(line.amountNgn);
    if (amt <= 0 || amt > balance) return;
    const m = advanceMovements.find((a) => !used.has(a.id) && ngn(a.amountNgn) === amt);
    if (!m) return;
    used.add(m.id);
    hits.push({ lineIndex, amountNgn: amt, movementId: m.id, postedAtISO: String(m.postedAtISO || '').slice(0, 10) });
  });
  return hits;
}

/** Payer name for a receipt: what the cashier typed, else the customer name. */
export function receiptPaidByName(body, customerName) {
  const typed = String(body?.paidByName ?? body?.paidBy ?? body?.payerName ?? '').trim();
  return typed || String(customerName || '').trim();
}

/* ---------------------------------------------------------------- 3–5. coil receiving */

export const GRN_WEIGHT_WARN_FRACTION = 0.02;

/** Spool per coil at receipt: Aluzinc/PPGI 65 kg, aluminium bought by kg 45 kg, bought by metre 0 (owner 2026-10-14). */
export const SPOOL_KG = { aluminium: 45, aluzinc: 65, aluminiumByMetre: 0 };

/** 'kg' | 'metre' for a PO line: the explicit unit when stored, else the Phase 1 detection rule. */
export function poLinePurchaseUnit(line) {
  const explicit = String(line?.purchaseUnit ?? line?.purchase_unit ?? '').trim().toLowerCase();
  if (explicit === 'kg' || explicit === 'metre') return explicit;
  return purchaseUnitForLine({
    productID: line?.productID ?? line?.product_id,
    productName: line?.productName ?? line?.product_name,
    lineType: line?.lineType ?? line?.line_type,
    metersOffered: line?.metersOffered ?? line?.meters_offered,
    qtyOrdered: line?.qtyOrdered ?? line?.qty_ordered,
    unitPricePerKgNgn: line?.unitPricePerKgNgn ?? line?.unit_price_per_kg_ngn,
    unitPriceNgn: line?.unitPriceNgn ?? line?.unit_price_ngn,
  }).unit;
}

/** Price per metre on a metre line (explicit column first; legacy lines keep it in the per-kg field). */
export function poLinePricePerMetreNgn(line) {
  return (
    ngn(line?.unitPricePerMeterNgn ?? line?.unit_price_per_meter_ngn) ||
    ngn(line?.unitPricePerKgNgn ?? line?.unit_price_per_kg_ngn) ||
    ngn(line?.unitPriceNgn ?? line?.unit_price_ngn)
  );
}

/**
 * Landed cost and cost per kg of one coil.
 * kg line: weighed kg × price per kg. metre line: metres × price per metre (amount paid) ÷ weighed kg.
 * @param {{ unit: 'kg' | 'metre', weighedKg: number, metres?: number, pricePerKgNgn?: number, pricePerMetreNgn?: number }} input
 */
export function coilReceiptCost({ unit, weighedKg, metres = 0, pricePerKgNgn = 0, pricePerMetreNgn = 0 }) {
  const w = num(weighedKg);
  const landed = unit === 'metre' ? ngn(num(metres) * num(pricePerMetreNgn)) : ngn(w * num(pricePerKgNgn));
  return {
    landedCostNgn: landed > 0 ? landed : null,
    unitCostNgnPerKg: landed > 0 && w > 0 ? Math.round(landed / w) : null,
  };
}

/**
 * Weighed kg vs what the PO says this receipt should weigh. Warn above 2%.
 * @param {{ weighedKg: number, expectedKg: number }} input
 */
export function grnWeightVariance({ weighedKg, expectedKg }) {
  const w = num(weighedKg);
  const e = num(expectedKg);
  if (w <= 0 || e <= 0) return { variancePct: null, warn: false };
  const diff = (w - e) / e;
  return { variancePct: Math.round(diff * 1000) / 10, warn: Math.abs(diff) > GRN_WEIGHT_WARN_FRACTION };
}

function coilFamily(materialTypeName, productID) {
  const t = String(materialTypeName || '').toLowerCase();
  if (/alumin/.test(t)) return 'aluminium';
  if (/aluzinc|ppgi/.test(t)) return 'aluzinc';
  if (productID === 'COIL-ALU') return 'aluminium';
  if (productID === 'PRD-102') return 'aluzinc';
  return '';
}

/** Spool kg for a coil from its material and how it was bought. */
export function spoolKgAtReceipt({ materialTypeName, productID, purchaseUnit = 'kg' }) {
  const fam = coilFamily(materialTypeName, productID);
  if (fam === 'aluminium' && purchaseUnit === 'metre') return SPOOL_KG.aluminiumByMetre;
  return fam ? SPOOL_KG[fam] : 0;
}

/** Net kg = kg − spool; a coil lighter than its spool is nil. */
export function coilNetKg(kg, spoolKg) {
  const g = Math.max(0, num(kg));
  return round2(g - Math.min(g, Math.max(0, num(spoolKg))));
}

/* ---------------------------------------------------------------- 6. locked periods */

export const LOCKED_PERIOD_CHANGE_FLAG = 'Locked-period change';

const EDIT_ACTION_RE =
  /(update|patch|edit|correct|adjust|reclass|revers|recall|revis|amend|change|clear|reset|delete|void|cancel|reopen|apply|set_|_set|\.set|override|approve_production|completion)/i;

/** Audit action that changes an existing record (not a new posting). */
export function isEditAuditAction(action) {
  const a = String(action || '');
  if (/\.(requested|request|create|insert|post|login|logout|view|export)$/i.test(a)) return false;
  return EDIT_ACTION_RE.test(a);
}

/**
 * Flag for an audit row: the edited record is dated in a locked month.
 * @param {{ action: string, recordDateISO: string, lockedPeriodKeys: Iterable<string>, explicit?: boolean }} input
 * @returns {{ flag: string, periodKey: string, recordDateISO: string } | null}
 */
export function lockedPeriodChange({ action, recordDateISO, lockedPeriodKeys, explicit = false }) {
  const day = String(recordDateISO || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (!explicit && !isEditAuditAction(action)) return null;
  const periodKey = day.slice(0, 7);
  const locked = lockedPeriodKeys instanceof Set ? lockedPeriodKeys : new Set(lockedPeriodKeys || []);
  if (!locked.has(periodKey)) return null;
  return { flag: LOCKED_PERIOD_CHANGE_FLAG, periodKey, recordDateISO: day };
}
