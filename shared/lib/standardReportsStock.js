/**
 * Stock (coil) as-at report rows — dense display fields.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/standardReportsStock.js
 */

import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';
import {
  isAccessoryStockCheckProduct,
  isStoneStockCheckProduct,
} from './stainMaterialPolicy.js';

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

/**
 * Sellable stain stock (posted coil_stain remaining metres) for Reports → Stock.
 * @param {Array<{ coilNo?: string; colour?: string; gaugeLabel?: string; sourceMaterialTypeName?: string; metersAvailable?: number; kgBooked?: number; id?: string }>} lots
 */
export function stockStainInventoryRows(lots = []) {
  return (lots || []).map((lot) => {
    const source = String(lot.sourceMaterialTypeName || lot.materialFamily || '').trim() || '—';
    const gauge = String(lot.gaugeLabel || '').trim() || '—';
    const meters = Math.round((Number(lot.metersAvailable ?? lot.estMeters) || 0) * 100) / 100;
    const kg = Math.round((Number(lot.kgBooked ?? lot.kg) || 0) * 100) / 100;
    return {
      lotId: String(lot.id || '').trim() || '—',
      coilNoDisplay: displayCoilNumber(lot.coilNo) || '—',
      coilNoFull: String(lot.coilNo || '').trim() || '—',
      colour: String(lot.colour || '').trim() || '—',
      gauge,
      materialType: 'Stain',
      sourceMaterialType: source,
      matGaugeKey: `Stain|${source}|${gauge}`,
      balanceMeters: meters,
      balanceKg: kg,
    };
  });
}

/**
 * @param {ReturnType<typeof stockStainInventoryRows>} rows
 */
export function stockStainInventoryTotals(rows = []) {
  let meters = 0;
  let kg = 0;
  for (const r of rows || []) {
    meters += Number(r.balanceMeters) || 0;
    kg += Number(r.balanceKg) || 0;
  }
  return {
    lotCount: (rows || []).length,
    totalMeters: Math.round(meters * 100) / 100,
    totalKg: Math.round(kg * 100) / 100,
  };
}

function productQty(row) {
  const n = Number(row?.stockLevel ?? row?.stock_level);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Branch-owned stone-coated SKUs (metres / m²) for Reports → Stock.
 * Pass `listProducts` for the workspace branch — do not collapse by productID.
 * @param {Array<{ productID?: string, name?: string, stockLevel?: number, unit?: string, branchId?: string, dashboardAttrs?: object }>} products
 */
export function stockStoneAsAtRows(products = []) {
  return (products || []).filter(isStoneStockCheckProduct).map((p) => {
    const attrs = p.dashboardAttrs && typeof p.dashboardAttrs === 'object' ? p.dashboardAttrs : {};
    const unit = String(p.unit || '').trim() || 'm';
    const qty = productQty(p);
    const colour = String(attrs.colour || attrs.stoneColour || p.colour || '').trim() || '—';
    const gauge = String(attrs.gauge || attrs.stoneGauge || p.gauge || '').trim() || '—';
    const isFs = Boolean(attrs.stoneFlatsheet) || /^STONE-FS-/i.test(String(p.productID || p.product_id || ''));
    return {
      productID: String(p.productID || p.product_id || '').trim() || '—',
      branchId: String(p.branchId || p.branch_id || '').trim(),
      name: String(p.name || '').trim() || '—',
      colour,
      gauge,
      unit,
      stoneFlatsheet: isFs,
      balanceMeters: isFs || unit.toLowerCase() === 'm2' || unit === 'm²' ? 0 : qty,
      balanceM2: isFs || unit.toLowerCase() === 'm2' || unit === 'm²' ? qty : 0,
      materialType: 'Stone coated',
    };
  });
}

/**
 * @param {ReturnType<typeof stockStoneAsAtRows>} rows
 */
export function stockStoneAsAtTotals(rows = []) {
  let meters = 0;
  let m2 = 0;
  for (const r of rows || []) {
    meters += Number(r.balanceMeters) || 0;
    m2 += Number(r.balanceM2) || 0;
  }
  return {
    skuCount: (rows || []).length,
    totalMeters: Math.round(meters * 100) / 100,
    totalM2: Math.round(m2 * 100) / 100,
  };
}

/**
 * Branch-owned accessory SKUs for Reports → Stock.
 * @param {Array<{ productID?: string, name?: string, stockLevel?: number, unit?: string, branchId?: string }>} products
 */
export function stockAccessoryAsAtRows(products = []) {
  return (products || []).filter(isAccessoryStockCheckProduct).map((p) => {
    const qty = productQty(p);
    return {
      productID: String(p.productID || p.product_id || '').trim() || '—',
      branchId: String(p.branchId || p.branch_id || '').trim(),
      name: String(p.name || '').trim() || '—',
      unit: String(p.unit || 'unit').trim() || 'unit',
      balance: qty,
    };
  });
}

/**
 * @param {ReturnType<typeof stockAccessoryAsAtRows>} rows
 */
export function stockAccessoryAsAtTotals(rows = []) {
  let balance = 0;
  for (const r of rows || []) balance += Number(r.balance) || 0;
  return {
    skuCount: (rows || []).length,
    totalBalance: Math.round(balance * 100) / 100,
  };
}
