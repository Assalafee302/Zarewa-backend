/**
 * Stock (coil) as-at report rows — dense display fields.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/standardReportsStock.js
 */

import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';

/**
 * @param {Array<{ coilNo?: string, colour?: string, gaugeLabel?: string, materialTypeName?: string, currentWeightKg?: number, poID?: string, supplierName?: string }>} lots
 */
export function stockCoilAsAtRows(lots = []) {
  return (lots || []).map((lot) => {
    const mat = String(lot.materialTypeName || '').trim() || '—';
    const gauge = String(lot.gaugeLabel || '').trim() || '—';
    return {
      coilNoDisplay: displayCoilNumber(lot.coilNo),
      coilNoFull: String(lot.coilNo || '').trim() || '—',
      colour: String(lot.colour || '').trim() || '—',
      gauge,
      materialType: mat,
      matGaugeKey: `${mat}|${gauge}`,
      balanceKg: Math.round((Number(lot.currentWeightKg) || 0) * 100) / 100,
      poIdDisplay: displayDocNumber(lot.poID) || '—',
      supplier: String(lot.supplierName || '').trim() || '—',
    };
  });
}
