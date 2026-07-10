/**
 * Material pricing workbook → quotation (roofing sheet / flat sheet).
 * Keep frontend mirror in Zarewa-frontend-main/src/lib/materialWorkbookQuotationPrice.js in sync.
 */

export function normPricingKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** @param {string} label e.g. "0.45mm" */
export function gaugeMmKeyFromLabel(label) {
  const s = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const m = s.match(/^(\d+(?:\.\d+)?)/);
  return m ? m[1] : normPricingKey(s);
}

/**
 * @param {{ id?: string; material_type_id?: string; name?: string } | null | undefined} row
 */
export function materialKeyFromMaterialTypeRow(row) {
  if (!row) return '';
  const id = String(row.id ?? row.material_type_id ?? '').trim();
  if (id === 'MAT-001') return 'alu';
  if (id === 'MAT-002') return 'aluzinc';
  if (id === 'MAT-005') return 'stone-coated';
  const n = normPricingKey(row.name);
  if (n.includes('aluzinc')) return 'aluzinc';
  if (n.includes('alumin')) return 'alu';
  if (n.includes('stone')) return 'stone-coated';
  return '';
}

/** @param {string} name */
export function isMeterSheetProductLine(name) {
  const k = normPricingKey(name);
  return k === 'roofing sheet' || k === 'flat sheet' || k.includes('roofing sheet') || k === 'flatsheet';
}

/** &lt; ₦5,000 → nearest ₦50; ≥ ₦5,000 → nearest ₦100 */
export function roundPublishedPriceNgn(ngn) {
  const n = Math.round(Number(ngn) || 0);
  if (n <= 0) return 0;
  if (n < 5000) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
}

/**
 * @param {number} floor
 * @param {number} commission
 */
export function publishedListPriceFromWorkbook(floor, commission) {
  const f = Math.max(0, Math.round(Number(floor) || 0));
  const c = Math.max(0, Number(commission) || 0);
  if (f <= 0) return 0;
  return roundPublishedPriceNgn(f + c);
}

/**
 * @param {string} designLabel
 * @param {string[]} [extraDesignKeys]
 */
export function designKeysToTry(designLabel, extraDesignKeys = []) {
  const seen = new Set();
  const out = [];
  const add = (s) => {
    const k = normPricingKey(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  add(designLabel);
  const compact = normPricingKey(designLabel).replace(/ /g, '');
  if (compact) add(compact);
  for (const k of extraDesignKeys) add(k);
  return out;
}

/**
 * @param {Array<{ materialKey?: string; gaugeMm?: string; branchId?: string; designKey?: string; minimumPricePerMeterNgn?: number; commissionNgnPerM?: number; publishedListPriceNgn?: number }>} rows
 * @param {{ materialKey: string; gaugeMm: string; branchId: string; designLabel?: string; designKeys?: string[] }} ctx
 * @returns {{ floorPerMeter: number; commissionPerMeter: number; suggestedListPerMeter: number; rowId?: string } | null}
 */
export function resolveMaterialWorkbookPriceFromRows(rows, ctx) {
  const mk = normPricingKey(ctx.materialKey);
  const g = gaugeMmKeyFromLabel(ctx.gaugeMm);
  const bid = String(ctx.branchId || '').trim();
  if (!mk || !g || !bid || !Array.isArray(rows)) return null;

  const designKeys = designKeysToTry(ctx.designLabel, ctx.designKeys);
  if (mk === 'stone-coated') {
    designKeys.push('stone-coated');
  }

  const pool = rows.filter(
    (r) =>
      normPricingKey(r.materialKey) === mk &&
      String(r.gaugeMm ?? '').trim() === g &&
      String(r.branchId ?? '').trim() === bid
  );
  if (!pool.length) return null;

  // Exact design match only (no fuzzy includes). Prefer exact key, else blank design row.
  // Never fall back to min floor across unrelated designs.
  let best = null;
  let bestScore = -1;
  for (const r of pool) {
    const rd = normPricingKey(r.designKey);
    const floor = Math.round(Number(r.minimumPricePerMeterNgn) || 0);
    if (floor <= 0) continue;

    let score = 0;
    if (designKeys.length) {
      if (designKeys.some((dk) => dk && rd === dk)) score = 20;
      else if (!rd) score = 8;
      else continue;
    } else if (!rd) {
      score = 10;
    } else {
      // Design unset on quote: only blank workbook rows are eligible.
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (!best) {
    const blank = pool.find(
      (r) => !normPricingKey(r.designKey) && Math.round(Number(r.minimumPricePerMeterNgn) || 0) > 0
    );
    best = blank || null;
  }
  if (!best) return null;

  const floorPerMeter = Math.round(Number(best.minimumPricePerMeterNgn) || 0);
  const commissionPerMeter = Math.max(0, Number(best.commissionNgnPerM) || 0);
  const published =
    Math.round(Number(best.publishedListPriceNgn) || 0) ||
    publishedListPriceFromWorkbook(floorPerMeter, commissionPerMeter);
  if (floorPerMeter <= 0) return null;

  return {
    floorPerMeter,
    commissionPerMeter,
    suggestedListPerMeter: published > 0 ? published : publishedListPriceFromWorkbook(floorPerMeter, commissionPerMeter),
    rowId: best.id,
  };
}
