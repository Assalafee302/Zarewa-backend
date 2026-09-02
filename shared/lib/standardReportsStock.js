/**
 * Stock (coil) as-at report rows — dense display fields.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/standardReportsStock.js
 */

import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';

/**
 * @param {Array<{ coilNo?: string, colour?: string, gaugeLabel?: string, materialTypeName?: string, currentWeightKg?: number, poID?: string, supplierName?: string, unitCostNgnPerKg?: number, landedCostNgn?: number }>} lots
 */
export function stockCoilAsAtRows(lots = []) {
  return (lots || []).map((lot) => {
    const mat = String(lot.materialTypeName || '').trim() || '—';
    const gauge = String(lot.gaugeLabel || '').trim() || '—';
    const balanceKg = Math.round((Number(lot.currentWeightKg) || 0) * 100) / 100;
    const unitCostNgnPerKg = lot.unitCostNgnPerKg != null ? Math.round(Number(lot.unitCostNgnPerKg)) : null;
    const valueNgn =
      lot.landedCostNgn != null
        ? Math.round(Number(lot.landedCostNgn))
        : unitCostNgnPerKg != null
          ? Math.round(unitCostNgnPerKg * balanceKg)
          : null;
    return {
      coilNoDisplay: displayCoilNumber(lot.coilNo),
      coilNoFull: String(lot.coilNo || '').trim() || '—',
      colour: String(lot.colour || '').trim() || '—',
      gauge,
      materialType: mat,
      matGaugeKey: `${mat}|${gauge}`,
      balanceKg,
      unitCostNgnPerKg,
      valueNgn,
      poIdDisplay: displayDocNumber(lot.poID) || '—',
      supplier: String(lot.supplierName || '').trim() || '—',
    };
  });
}

/**
 * @param {ReturnType<typeof stockCoilAsAtRows>} rows
 */
export function stockCoilAsAtTotals(rows = []) {
  let totalValueNgn = 0;
  let valuedRowCount = 0;
  let unvaluedRowCount = 0;
  for (const r of rows || []) {
    if (r.valueNgn == null) {
      unvaluedRowCount += 1;
      continue;
    }
    totalValueNgn += r.valueNgn;
    valuedRowCount += 1;
  }
  return { totalValueNgn: Math.round(totalValueNgn), valuedRowCount, unvaluedRowCount };
}
