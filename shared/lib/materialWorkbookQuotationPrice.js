/**
 * Material pricing workbook → quotation (roofing sheet / flat sheet).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/materialWorkbookQuotationPrice.js
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

/** Compact token for profile / design matching (drops spaces and punctuation). */
export function compactDesignToken(s) {
  return normPricingKey(s).replace(/[^a-z0-9]/g, '');
}

/**
 * Map quotation profile labels (e.g. "Longspan (Indus6)", "Roman") onto workbook
 * publish keys (longspan / metcoppo / steptiles / rome / stone-coated).
 * @param {string} label
 */
export function canonicalPriceListDesignKey(label) {
  const compact = compactDesignToken(label);
  if (!compact) return '';
  const aliases = {
    longspan: 'longspan',
    longspanindus6: 'longspan',
    longspanindus: 'longspan',
    longspanmetra: 'longspan',
    longspanindustrial6: 'longspan',
    longspanindustrial6metra: 'longspan',
    industrial6: 'longspan',
    industrialsix: 'longspan',
    indus6: 'longspan',
    metra: 'longspan',
    metcoppo: 'metcoppo',
    steptiles: 'steptiles',
    steptile: 'steptiles',
    rome: 'rome',
    roman: 'rome',
    romantile: 'rome',
    stonecoated: 'stone-coated',
  };
  if (aliases[compact]) return aliases[compact];
  if (compact.includes('longspan')) return 'longspan';
  if (compact.includes('metcoppo')) return 'metcoppo';
  if (compact.includes('steptile')) return 'steptiles';
  if (compact === 'rome' || compact.startsWith('roman')) return 'rome';
  if (compact.includes('stonecoat')) return 'stone-coated';
  return '';
}

/**
 * True when a price-list / workbook design_key matches the quote's candidate keys.
 * Canonical aliases (Longspan (Indus6) ↔ longspan, Roman ↔ rome) count as a hit;
 * short unrelated tokens such as "long" do not.
 * @param {string} rowDesignKey
 * @param {string[]} quoteDesignKeys
 */
export function priceListDesignKeysMatch(rowDesignKey, quoteDesignKeys) {
  const rd = normPricingKey(rowDesignKey);
  if (!rd || !Array.isArray(quoteDesignKeys) || !quoteDesignKeys.length) return false;
  const rdCompact = compactDesignToken(rd);
  const rdCanon = canonicalPriceListDesignKey(rd);
  for (const raw of quoteDesignKeys) {
    const dk = normPricingKey(raw);
    if (!dk) continue;
    if (dk === rd) return true;
    if (compactDesignToken(dk) === rdCompact) return true;
    const dkCanon = canonicalPriceListDesignKey(dk);
    if (dkCanon && (dkCanon === rd || dkCanon === rdCanon || dkCanon === rdCompact)) return true;
    if (rdCanon && (rdCanon === dk || rdCanon === compactDesignToken(dk))) return true;
  }
  return false;
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
  const canon = canonicalPriceListDesignKey(designLabel);
  if (canon) add(canon);
  for (const k of extraDesignKeys) add(k);
  return out;
}

/**
 * Published `price_list_items` unit ₦/m for a quotation line.
 * Prefers workbook-publish rows (PL-MPS-*) and later effective dates when scores tie,
 * so a re-publish beats leftover Price List Admin rows with equivalent keys.
 *
 * @param {Array<{ id?: string; gaugeKey?: string; gaugeMm?: string; designKey?: string; materialTypeKey?: string; materialKey?: string; branchId?: string; unitPricePerMeterNgn?: number; effectiveFromIso?: string }>} items
 * @param {{ gaugeLabel?: string; gaugeMm?: string; designLabel?: string; designKeys?: string[]; materialTypeKey?: string; materialKey?: string; branchId?: string; skipDesign?: boolean }} ctx
 * @returns {number}
 */
export function resolvePublishedListUnitNgnFromItems(items, ctx) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const gaugeK = gaugeMmKeyFromLabel(ctx?.gaugeLabel ?? ctx?.gaugeMm);
  const materialKey = normPricingKey(ctx?.materialTypeKey ?? ctx?.materialKey);
  const branchId = String(ctx?.branchId ?? '').trim();
  const designKeys = ctx?.skipDesign ? [] : designKeysToTry(ctx?.designLabel, ctx?.designKeys);

  let bestScore = -1;
  let bestN = 0;
  let bestEff = '';
  for (const row of items) {
    const rg = gaugeMmKeyFromLabel(row.gaugeKey ?? row.gaugeMm);
    const rd = normPricingKey(row.designKey);
    const rmt = normPricingKey(row.materialTypeKey ?? row.materialKey);
    const rb = String(row.branchId ?? '').trim();

    if (rb && branchId && rb !== branchId) continue;
    if (gaugeK && rg && rg !== gaugeK) continue;
    const designHit = designKeys.length ? priceListDesignKeysMatch(rd, designKeys) : !rd;
    if (designKeys.length && rd && !designHit) continue;
    if (rmt && materialKey) {
      if (rmt !== materialKey && !materialKey.includes(rmt) && !rmt.includes(materialKey)) continue;
    } else if (rmt && !materialKey) {
      continue;
    }

    const n = Math.round(Number(row.unitPricePerMeterNgn) || 0);
    if (n <= 0) continue;

    let score = 0;
    if (gaugeK && rg === gaugeK) score += 4;
    if (designHit && rd) score += 6;
    else if (designKeys.length && !rd) score += 1;
    if (rmt && materialKey) score += 2;
    if (rb && branchId) score += 1;
    if (String(row.id ?? '').startsWith('PL-MPS-')) score += 2;
    const eff = String(row.effectiveFromIso ?? '').slice(0, 10);

    const betterScore = score > bestScore;
    const newerSameScore = score === bestScore && score > 0 && eff > bestEff;
    if (betterScore || newerSameScore) {
      bestScore = score;
      bestN = n;
      bestEff = eff;
    }
  }
  return bestScore > 0 ? bestN : 0;
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
      gaugeMmKeyFromLabel(r.gaugeMm) === g &&
      String(r.branchId ?? '').trim() === bid
  );
  if (!pool.length) return null;

  // Canonical design match (Longspan (Indus6) ↔ longspan). Prefer exact key, else blank design row.
  // Never fall back to min floor across unrelated designs.
  let best = null;
  let bestScore = -1;
  for (const r of pool) {
    const rd = normPricingKey(r.designKey);
    const floor = Math.round(Number(r.minimumPricePerMeterNgn) || 0);
    if (floor <= 0) continue;

    let score = 0;
    if (designKeys.length) {
      if (priceListDesignKeysMatch(rd, designKeys)) score = 20;
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
