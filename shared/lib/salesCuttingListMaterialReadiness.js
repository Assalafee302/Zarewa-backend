/**
 * Sales cutting-list material readiness (coil match vs waiting lists).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/salesCuttingListMaterialReadiness.js
 */
import {
  buildExpectedCoilSpecFromQuotation,
  coilSpecMismatchIssues,
  expectedGaugeBoundsMm,
  quotationExpectsCoilAllocation,
} from './coilSpecVersusProduct.js';
import { quotationIsStainMeterHeader, stainPoolRowMatchesQuotation } from './stainMaterialPolicy.js';

function skipMaterialCompareToCoil(expectedMaterialType) {
  const m = String(expectedMaterialType ?? '').toLowerCase();
  if (!m) return false;
  if (/\bfinished\b/.test(m)) return true;
  if (/\broofing sheet\b/.test(m)) return true;
  if (/\baccessory\b/.test(m)) return true;
  if (/\bsteeltile\b/.test(m) && !/\bcoil\b/.test(m)) return true;
  return false;
}

const TERMINAL = /^(finished|completed|ready\s*for\s*dispatch)$/i;
const IN_PRODUCTION = /^in\s+production$/i;

/** Cutting lists not finished / not actively on the line — can still need coil. */
export function isWaitingCuttingListForMaterial(cl) {
  const s = String(cl?.status || '').trim();
  if (!s) return true;
  if (TERMINAL.test(s)) return false;
  if (IN_PRODUCTION.test(s)) return false;
  return true;
}

function inventoryRowToCoilLot(row) {
  return {
    gaugeLabel: row.gaugeLabel,
    colour: row.colour,
    colourRaw: row.colourRaw ?? row.colour,
    materialTypeName: row.materialType,
  };
}

/**
 * Strict match: quote must have comparable material fields; coil row must pass spec check and have kg.
 * @param {Record<string, unknown>} row — Sales coilInventoryRows shape
 * @param {Record<string, unknown>} quotation
 * @param {{ colours?: object[] } | null | undefined} [masterData] — Setup colours for name ↔ abbreviation (e.g. Bush Green vs BG)
 */
export function inventoryRowMatchesQuotationCoilSpec(row, quotation, masterData) {
  if (!row || !quotation) return false;
  if (Number(row.kg) <= 0) return false;
  const lot = inventoryRowToCoilLot(row);
  const expected = buildExpectedCoilSpecFromQuotation(quotation, null);
  const { issues, hasExpected } = coilSpecMismatchIssues(lot, expected, masterData);
  if (!hasExpected) return false;
  return issues.length === 0;
}

/** True when quotation header / lines give enough to compare to coil inventory (same idea as coilSpecMismatchIssues). */
export function quotationHasComparableCoilSpec(quotation) {
  const e = buildExpectedCoilSpecFromQuotation(quotation, null);
  const gBounds = expectedGaugeBoundsMm(e.gauge);
  const cExp = String(e.colour || '').trim().toLowerCase();
  const mRaw = String(e.materialType || '').trim();
  const mExp = skipMaterialCompareToCoil(mRaw) ? '' : mRaw.toLowerCase();
  return gBounds != null || cExp.length > 0 || mExp.length > 0;
}

const EM_DASH = '—';

/**
 * One-line explanation for Sales sidebar when a waiting list has quote spec but no matching coil.
 * @param {Record<string, unknown>} cl
 * @param {Record<string, unknown>} quotation
 */
export function formatNoCoilMatchAlertForCuttingList(cl, quotation) {
  const exp = buildExpectedCoilSpecFromQuotation(quotation, null);
  const colour = String(exp.colour || '').trim() || EM_DASH;
  const gauge = String(exp.gauge || '').trim() || EM_DASH;
  const mat =
    String(
      quotation?.materialTypeName ?? quotation?.material_type_name ?? exp.materialType ?? ''
    ).trim() || EM_DASH;
  const id = String(cl?.id || 'Cutting list').trim();
  return `${id} does not have a coil match for colour ${colour}, gauge ${gauge}, material ${mat}.`;
}

/**
 * @param {Record<string, unknown>} cl
 * @param {Record<string, unknown>} quotation
 */
export function formatNoStainPoolMatchAlertForCuttingList(cl, quotation) {
  const colour = String(quotation?.materialColor || '').trim() || EM_DASH;
  const gauge = String(quotation?.materialGauge || '').trim() || EM_DASH;
  const mat = String(quotation?.materialTypeName ?? quotation?.material_type_name ?? 'Stain').trim() || 'Stain';
  const id = String(cl?.id || 'Cutting list').trim();
  return `${id} is waiting: no stain in the yard and no matching coil for ${colour}, ${gauge} (${mat}). Record stain from a coil, or receive a matching roll.`;
}

/**
 * @param {object[]} cuttingLists
 * @param {object[]} quotations
 * @param {object[]} coilInventoryRows — from Sales.jsx coilInventoryRows
 * @param {{ colours?: object[] } | null | undefined} [masterData] — optional Setup colours for coil ↔ quote colour resolution
 * @param {object[]} stainPoolRows — materialPoolSummary.bySpec / incidents with metersAvailable
 * @returns {{
 *   ready: Array<{ cl: object, quotation: object, matches: object[], totalKg: number, totalEstM: number, needM: number, meterCoverageOk: boolean }>,
 *   waitingWithSpecNoStock: number,
 *   waitingNoMatch: Array<{ cl: object, quotation: object, alertText: string }>,
 * }}
 */
export function computeCuttingListMaterialReadiness(
  cuttingLists,
  quotations,
  coilInventoryRows,
  masterData,
  stainPoolRows
) {
  const byQ = new Map(quotations.map((q) => [String(q.id), q]));
  const ready = [];
  const waitingNoMatch = [];

  for (const cl of cuttingLists || []) {
    if (!isWaitingCuttingListForMaterial(cl)) continue;
    const q = byQ.get(String(cl.quotationRef || '').trim());
    if (!q) continue;

    if (quotationIsStainMeterHeader(q)) {
      const poolMatches = (stainPoolRows || []).filter((r) => stainPoolRowMatchesQuotation(r, q));
      const coilMatches = (coilInventoryRows || []).filter((r) =>
        inventoryRowMatchesQuotationCoilSpec(r, q, masterData)
      );
      const poolM = poolMatches.reduce((s, r) => s + (Number(r.metersAvailable) || 0), 0);
      const coilKg = coilMatches.reduce((s, r) => s + (Number(r.kg) || 0), 0);
      const coilEstM = coilMatches.reduce((s, r) => s + (Number(r.estMeters) || 0), 0);
      const totalEstM = poolM + coilEstM;
      const needM = Number(cl.totalMeters) || 0;
      if (poolM <= 0 && coilMatches.length === 0) {
        waitingNoMatch.push({
          cl,
          quotation: q,
          alertText: formatNoStainPoolMatchAlertForCuttingList(cl, q),
        });
        continue;
      }
      ready.push({
        cl,
        quotation: q,
        matches: [...poolMatches, ...coilMatches],
        totalKg: coilKg,
        totalEstM,
        needM,
        meterCoverageOk: needM <= 0 || totalEstM >= needM * 0.85 || coilMatches.length > 0,
      });
      continue;
    }

    if (!quotationExpectsCoilAllocation(q)) continue;
    if (!quotationHasComparableCoilSpec(q)) continue;

    const matches = (coilInventoryRows || []).filter((r) => inventoryRowMatchesQuotationCoilSpec(r, q, masterData));
    if (matches.length === 0) {
      waitingNoMatch.push({
        cl,
        quotation: q,
        alertText: formatNoCoilMatchAlertForCuttingList(cl, q),
      });
      continue;
    }

    const totalKg = matches.reduce((s, r) => s + (Number(r.kg) || 0), 0);
    const totalEstM = matches.reduce((s, r) => s + (Number(r.estMeters) || 0), 0);
    const needM = Number(cl.totalMeters) || 0;
    const meterCoverageOk = needM <= 0 || totalEstM >= needM * 0.85;

    ready.push({ cl, quotation: q, matches, totalKg, totalEstM, needM, meterCoverageOk });
  }

  ready.sort((a, b) => {
    if (a.meterCoverageOk !== b.meterCoverageOk) return a.meterCoverageOk ? -1 : 1;
    return b.totalEstM - a.totalEstM;
  });

  waitingNoMatch.sort((a, b) =>
    String(a.cl?.id || '').localeCompare(String(b.cl?.id || ''), undefined, { numeric: true })
  );

  return {
    ready,
    waitingWithSpecNoStock: waitingNoMatch.length,
    waitingNoMatch,
  };
}
