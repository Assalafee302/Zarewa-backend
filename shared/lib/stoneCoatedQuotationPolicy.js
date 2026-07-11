/**
 * Stone-coated (stone_meter) quotation rules — shared by server validation and mirrored on the client.
 * Keep in sync with Zarewa-frontend-main/src/lib/stoneCoatedQuotationPolicy.js
 */

export const STONE_METER_INVENTORY_MODEL = 'stone_meter';

/** Canonical profile labels when setup_profiles has no rows for the material type. */
export const STONE_PROFILE_FALLBACK = ['Bond', 'Classic', 'Milano', 'Single', 'Roman'];

/**
 * Allowed product keys on stone_meter quotes (before Coil rule).
 * Cladding and other coil trims are intentionally excluded.
 */
export const STONE_PRODUCT_BASE_KEYS = new Set([
  'roofing sheet',
  'stone flatsheet',
  'ridge',
  'ridge cap',
  'bargeboard',
  'gutter',
  'flat sheet',
]);

/** Valid stone flatsheet stock lengths (m). Legacy 1.5 maps to 1.4. */
export const STONE_FLATSHEET_LENGTHS_M = Object.freeze([1.4, 2]);

/**
 * Yield from one stone flatsheet of length L:
 * ridge → 3 pieces × L finished metres; bargeboard → 2 pieces × L finished metres.
 */
export const STONE_SF_YIELD_RIDGE_PCS_PER_SHEET = 3;
export const STONE_SF_YIELD_BARGEBOARD_PCS_PER_SHEET = 2;

/** Normal flatsheet on a stone quote always prices/fulfills as aluzinc coil. */
export const STONE_QUOTE_FLAT_SHEET_COIL_MATERIAL_KEY = 'aluzinc';

const COIL_KEY = 'coil';

/**
 * @param {string | null | undefined} s
 */
export function normQuoteItemKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Quotation UI: when setup_price_lists and workbook list no stone colours, narrow the picker to these keys (see migrate stone colour seed). */
export const STONE_DEFAULT_COLOUR_KEYS = new Set(
  [
    'black',
    'coffee brown',
    'red',
    'red mix black',
    'red patch black',
    'black patch white',
    'coffee mix black',
  ].map((k) => normQuoteItemKey(k))
);

/**
 * Map display / legacy names to a whitelist key.
 * @param {string | null | undefined} name
 */
export function productLineKey(name) {
  const k = normQuoteItemKey(name);
  if (k === 'flatsheet') return 'flat sheet';
  if (k === 'stone flatsheet' || k.startsWith('stone flatsheet ')) return 'stone flatsheet';
  if (k === 'stoneflatsheet' || k === 'stone flat sheet') return 'stone flatsheet';
  if (k === 'barge board') return 'bargeboard';
  return k;
}

/**
 * Quotation product lines that issue stone flatsheet stock (m² / sheets), not stone-coated metre stock.
 * @param {string | null | undefined} name
 */
export function isStoneFlatsheetQuotationLine(name) {
  return productLineKey(name) === 'stone flatsheet';
}

/**
 * Ridge / ridge cap — cut from stone flatsheet (extra SF consumption by yield).
 * @param {string | null | undefined} name
 */
export function isStoneRidgeQuotationLine(name) {
  const key = productLineKey(name);
  return key === 'ridge' || key === 'ridge cap';
}

/**
 * Bargeboard — cut from stone flatsheet (extra SF consumption by yield).
 * @param {string | null | undefined} name
 */
export function isStoneBargeboardQuotationLine(name) {
  return productLineKey(name) === 'bargeboard';
}

/**
 * Products fulfilled by cutting stone flatsheet (sold SF, ridge, bargeboard).
 * @param {string | null | undefined} name
 */
export function isStoneFlatsheetYieldProductLine(name) {
  return (
    isStoneFlatsheetQuotationLine(name) ||
    isStoneRidgeQuotationLine(name) ||
    isStoneBargeboardQuotationLine(name)
  );
}

/**
 * Roofing sheet only — draws stone metre stock (STONE-{profile}-{colour}-{gauge}).
 * @param {string | null | undefined} name
 */
export function isStoneMetreRoofingQuotationLine(name) {
  return productLineKey(name) === 'roofing sheet';
}

/**
 * Coil-backed lines on a stone quote (cutting-list flatsheet / aluzinc coil path).
 * @param {string | null | undefined} name
 */
export function isStoneCoilBackedQuotationLine(name) {
  const key = productLineKey(name);
  return key === 'gutter' || key === 'flat sheet' || key === COIL_KEY;
}

/**
 * Finished ridge metres produced from one SF sheet of length L.
 * @param {1.4 | 2} lengthM
 */
export function stoneRidgeMetresPerSheet(lengthM) {
  const L = normalizeStoneFlatsheetLengthM(lengthM);
  if (L == null) return 0;
  return STONE_SF_YIELD_RIDGE_PCS_PER_SHEET * L;
}

/**
 * Finished bargeboard metres produced from one SF sheet of length L.
 * @param {1.4 | 2} lengthM
 */
export function stoneBargeboardMetresPerSheet(lengthM) {
  const L = normalizeStoneFlatsheetLengthM(lengthM);
  if (L == null) return 0;
  return STONE_SF_YIELD_BARGEBOARD_PCS_PER_SHEET * L;
}

/**
 * Sheets required to cover finished metres (exact; production records offcut for remainder).
 * @param {number} finishedMetres
 * @param {number} metresPerSheet
 */
export function stoneFlatsheetSheetsForFinishedMetres(finishedMetres, metresPerSheet) {
  const need = Number(finishedMetres) || 0;
  const per = Number(metresPerSheet) || 0;
  if (need <= 0 || per <= 0) return 0;
  return need / per;
}

/**
 * Stock m² for one physical SF sheet (effective 1 m cover width × length).
 * @param {1.4 | 2} lengthM
 */
export function stoneFlatsheetM2PerSheet(lengthM) {
  const L = normalizeStoneFlatsheetLengthM(lengthM);
  return L == null ? 0 : L;
}

/**
 * Convert SF stock m² ↔ sheet pcs at a length.
 * @param {number} m2
 * @param {1.4 | 2} lengthM
 */
export function stoneFlatsheetM2ToPcs(m2, lengthM) {
  const per = stoneFlatsheetM2PerSheet(lengthM);
  if (per <= 0) return 0;
  return (Number(m2) || 0) / per;
}

/**
 * @param {number} pcs
 * @param {1.4 | 2} lengthM
 */
export function stoneFlatsheetPcsToM2(pcs, lengthM) {
  return (Number(pcs) || 0) * stoneFlatsheetM2PerSheet(lengthM);
}

/**
 * Valid stone flatsheet stock lengths (m). Legacy 1.5 is remapped to 1.4.
 * @param {unknown} raw — from `stoneFlatsheetLengthM` / `lengthM` on a quote line
 * @returns {1.4 | 2 | null}
 */
export function normalizeStoneFlatsheetLengthM(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n - 1.4) < 1e-6) return 1.4;
  /* Legacy SKU / quotes: 1.5 → 1.4 */
  if (Math.abs(n - 1.5) < 1e-6) return 1.4;
  if (Math.abs(n - 2) < 1e-6 || Math.abs(n - 2.0) < 1e-6) return 2;
  return null;
}

/**
 * Length for a stone flatsheet quote line: `stoneFlatsheetLengthM` on generic "Stone flatsheet" rows;
 * for suffixed names ("Stone flatsheet 2"), the name encodes length and wins if it disagrees with a stale field.
 * @param {{ name?: string; stoneFlatsheetLengthM?: unknown; lengthM?: unknown } | null | undefined} row
 * @returns {1.4 | 2 | null}
 */
export function resolveStoneFlatsheetLengthM(row) {
  const k = normQuoteItemKey(row?.name);
  const m = k.match(/^stone flatsheet\s+(\d+(?:\.\d+)?)\s*$/);
  const fromNameSuffix = m ? normalizeStoneFlatsheetLengthM(m[1]) : null;

  const rawSfl = row?.stoneFlatsheetLengthM;
  const hasSfl = rawSfl !== undefined && rawSfl !== null && rawSfl !== '';
  const fromSfl = hasSfl ? normalizeStoneFlatsheetLengthM(rawSfl) : null;

  if (!isStoneFlatsheetQuotationLine(row?.name)) {
    return null;
  }

  if (k === 'stone flatsheet') {
    if (fromSfl != null) return fromSfl;
    if (fromNameSuffix != null) return fromNameSuffix;
    return normalizeStoneFlatsheetLengthM(row?.lengthM);
  }

  if (fromNameSuffix != null && fromSfl != null && fromNameSuffix !== fromSfl) {
    return fromNameSuffix;
  }
  if (fromSfl != null) return fromSfl;
  if (fromNameSuffix != null) return fromNameSuffix;
  return normalizeStoneFlatsheetLengthM(row?.lengthM);
}

/**
 * @param {{ name?: string }[]} products
 */
export function quotationHasFlatSheetLine(products) {
  if (!Array.isArray(products)) return false;
  return products.some((row) => {
    const key = productLineKey(row?.name);
    return key === 'flat sheet';
  });
}

/**
 * @param {{ name?: string }[]} products
 */
export function quotationHasCoilLine(products) {
  if (!Array.isArray(products)) return false;
  return products.some((row) => productLineKey(row?.name) === COIL_KEY);
}

function parseQuoteLineQty(row) {
  return Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
}

function parseLinesJsonProducts(linesJson) {
  let j = linesJson;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j || '{}');
    } catch {
      return [];
    }
  }
  if (!j || typeof j !== 'object') return [];
  return Array.isArray(j.products) ? j.products : [];
}

/**
 * Product lines with qty > 0 that draw stone-coated metre stock (roofing sheet only).
 * Ridge/bargeboard draw stone flatsheet; gutter / flat sheet draw coil.
 * @param {{ name?: string; qty?: unknown }[] | null | undefined} products
 */
export function quotationHasStoneMetreProductLines(products) {
  if (!Array.isArray(products)) return false;
  return products.some((row) => {
    const name = String(row?.name ?? '').trim();
    if (!name || parseQuoteLineQty(row) <= 0) return false;
    return isStoneMetreRoofingQuotationLine(name);
  });
}

/**
 * Whether the quote has coil-backed lines (gutter / normal flatsheet / coil) for CL metre checks.
 * @param {{ name?: string; qty?: unknown }[] | null | undefined} products
 */
export function quotationHasStoneCoilBackedProductLines(products) {
  if (!Array.isArray(products)) return false;
  return products.some((row) => {
    const name = String(row?.name ?? '').trim();
    if (!name || parseQuoteLineQty(row) <= 0) return false;
    return isStoneCoilBackedQuotationLine(name);
  });
}

/**
 * Sold SF, ridge, or bargeboard with qty — production must plan stone flatsheet usage.
 * @param {{ name?: string; qty?: unknown }[] | null | undefined} products
 */
export function quotationHasStoneFlatsheetDemandLines(products) {
  if (!Array.isArray(products)) return false;
  return products.some((row) => {
    const name = String(row?.name ?? '').trim();
    if (!name || parseQuoteLineQty(row) <= 0) return false;
    return isStoneFlatsheetYieldProductLine(name);
  });
}

/**
 * Whether completing production should consume stone-coated metre stock (vs stone flatsheet / coil only).
 * @param {object | string | null | undefined} linesJson
 */
export function quotationRequiresStoneMetreConsumption(linesJson) {
  return quotationHasStoneMetreProductLines(parseLinesJsonProducts(linesJson));
}

/**
 * Whether cutting-list coil metre alignment applies (gutter / normal flatsheet on stone quotes).
 * SF-only and ridge/barge-only stone quotes skip the roofing↔CL metre gate.
 * @param {object | string | null | undefined} linesJson
 */
export function quotationRequiresStoneCoilCuttingListAlignment(linesJson) {
  return quotationHasStoneCoilBackedProductLines(parseLinesJsonProducts(linesJson));
}

/**
 * Whether production should consume stone flatsheet stock (sold SF and/or ridge/barge yield).
 * @param {object | string | null | undefined} linesJson
 */
export function quotationRequiresStoneFlatsheetConsumption(linesJson) {
  return quotationHasStoneFlatsheetDemandLines(parseLinesJsonProducts(linesJson));
}

export const STONE_ACCESSORY_KEYS = new Set([normQuoteItemKey('Stone nail'), normQuoteItemKey('Repair Kit')]);

/**
 * @param {string | null | undefined} name
 */
export function accessoryLineAllowedForStone(name) {
  const k = normQuoteItemKey(name);
  if (STONE_ACCESSORY_KEYS.has(k)) return true;
  if (k.includes('stone nail')) return true;
  if (k.includes('repair kit')) return true;
  return false;
}

/**
 * @param {string} name
 * @param {boolean} hasFlatSheet
 */
export function productLineAllowedForStone(name, hasFlatSheet) {
  const key = productLineKey(name);
  if (key === COIL_KEY) return hasFlatSheet;
  return STONE_PRODUCT_BASE_KEYS.has(key);
}

/**
 * Map `setup_material_types` row → `price_list_items.material_type_key` (workbook / floor rows).
 * @param {{ id?: string; material_type_id?: string; name?: string } | null | undefined} row
 */
export function priceListMaterialKeyFromMaterialTypeRow(row) {
  if (!row) return '';
  const id = String(row.id ?? row.material_type_id ?? '').trim();
  if (id === 'MAT-001') return 'alu';
  if (id === 'MAT-002') return 'aluzinc';
  if (id === 'MAT-005') return 'stone-coated';
  const n = normQuoteItemKey(row.name);
  if (n.includes('aluzinc')) return 'aluzinc';
  if (n.includes('alumin')) return 'alu';
  if (n.includes('stone')) return 'stone-coated';
  return '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialTypeId
 * @returns {Set<string>} normalized profile keys
 */
export function allowedStoneProfileKeysFromDb(db, materialTypeId) {
  const mid = String(materialTypeId || '').trim();
  if (!mid || !db) return new Set(STONE_PROFILE_FALLBACK.map(normQuoteItemKey));
  try {
    const rows = db
      .prepare(
        `SELECT name FROM setup_profiles WHERE active = 1 AND material_type_id = ?`
      )
      .all(mid);
    if (rows.length) {
      return new Set(rows.map((r) => normQuoteItemKey(r.name)));
    }
  } catch {
    /* table missing in tests */
  }
  return new Set(STONE_PROFILE_FALLBACK.map(normQuoteItemKey));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} gaugeLabel
 */
export function gaugeLabelActiveInMaster(db, gaugeLabel) {
  const g = String(gaugeLabel || '').trim();
  if (!g || !db) return true;
  try {
    const row = db
      .prepare(`SELECT 1 AS ok FROM setup_gauges WHERE active = 1 AND label = ? LIMIT 1`)
      .get(g);
    return Boolean(row?.ok);
  } catch {
    return true;
  }
}

/**
 * Stone header colour: allowed if listed on setup_price_lists (colour_id) and/or on price_list_items
 * (colour_key + material_type_key) for this material. If neither source constrains colours, any active colour passes.
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialTypeId
 * @param {string} colourName — quotation header display name
 */
export function stoneColourAllowedByPriceList(db, materialTypeId, colourName) {
  const mid = String(materialTypeId || '').trim();
  const cname = String(colourName || '').trim();
  if (!mid || !cname || !db) return true;
  try {
    const mtRow = db
      .prepare(
        `SELECT material_type_id AS id, name FROM setup_material_types WHERE material_type_id = ? AND active = 1`
      )
      .get(mid);
    const mtKey = priceListMaterialKeyFromMaterialTypeRow(mtRow);

    const priceRows = db
      .prepare(
        `SELECT DISTINCT colour_id FROM setup_price_lists WHERE active = 1 AND material_type_id = ? AND colour_id IS NOT NULL AND trim(colour_id) != ''`
      )
      .all(mid);
    const allowedSetupIds = new Set(priceRows.map((r) => String(r.colour_id || '').trim()).filter(Boolean));

    const workbookKeys = new Set();
    if (mtKey) {
      const pliRows = db
        .prepare(
          `SELECT DISTINCT colour_key FROM price_list_items WHERE lower(trim(material_type_key)) = lower(trim(?)) AND colour_key IS NOT NULL AND trim(colour_key) != '' AND COALESCE(unit_price_per_meter_ngn, 0) > 0`
        )
        .all(mtKey);
      for (const r of pliRows || []) {
        const k = normQuoteItemKey(r.colour_key);
        if (k) workbookKeys.add(k);
      }
    }

    const col = db
      .prepare(`SELECT colour_id FROM setup_colours WHERE active = 1 AND name = ?`)
      .get(cname);
    const cid = col?.colour_id != null ? String(col.colour_id).trim() : '';
    const cnameKey = normQuoteItemKey(cname);

    const hasSetup = allowedSetupIds.size > 0;
    const hasWb = workbookKeys.size > 0;
    if (!hasSetup && !hasWb) return true;

    const okSetup = hasSetup && Boolean(cid) && allowedSetupIds.has(cid);
    const okWb = hasWb && workbookKeys.has(cnameKey);
    if (hasSetup && hasWb) return okSetup || okWb;
    if (hasSetup) return okSetup;
    return okWb;
  } catch {
    return true;
  }
}

export const QUOTATION_MATERIAL_RULES_CODE = 'QUOTATION_MATERIAL_RULES';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} linesJson — products, accessories, services, materialTypeId, materialGauge, materialColor, materialDesign
 * @returns {{ ok: true } | { ok: false, error: string, code: string, details: object }}
 */
export function validateQuotationMaterialRules(db, linesJson) {
  const j = linesJson && typeof linesJson === 'object' ? linesJson : {};
  const mid = String(j.materialTypeId || '').trim();
  if (!mid || !db) return { ok: true };

  let inventoryModel = 'coil_kg';
  try {
    const row = db
      .prepare(
        `SELECT inventory_model FROM setup_material_types WHERE material_type_id = ? AND active = 1`
      )
      .get(mid);
    inventoryModel = String(row?.inventory_model || 'coil_kg').trim() || 'coil_kg';
  } catch {
    inventoryModel = 'coil_kg';
  }

  if (inventoryModel !== STONE_METER_INVENTORY_MODEL) {
    return { ok: true };
  }

  const products = Array.isArray(j.products) ? j.products : [];
  const accessories = Array.isArray(j.accessories) ? j.accessories : [];
  const hasFlat = quotationHasFlatSheetLine(products);

  const invalidProductNames = [];
  for (const row of products) {
    const n = String(row?.name ?? '').trim();
    if (!n) continue;
    if (!productLineAllowedForStone(n, hasFlat)) {
      invalidProductNames.push(n);
    }
  }

  const invalidAccessoryNames = [];
  for (const row of accessories) {
    const n = String(row?.name ?? '').trim();
    if (!n) continue;
    if (!accessoryLineAllowedForStone(n)) {
      invalidAccessoryNames.push(n);
    }
  }

  const design = String(j.materialDesign || '').trim();
  const profileKeys = allowedStoneProfileKeysFromDb(db, mid);
  const invalidProfile =
    design.length > 0 && !profileKeys.has(normQuoteItemKey(design));

  const gauge = String(j.materialGauge || '').trim();
  const invalidGauge = gauge.length > 0 && !gaugeLabelActiveInMaster(db, gauge);

  const colour = String(j.materialColor || '').trim();
  const invalidColour = colour.length > 0 && !stoneColourAllowedByPriceList(db, mid, colour);

  const invalidHeader = {
    profile: invalidProfile,
    gauge: invalidGauge,
    colour: invalidColour,
  };

  const stoneFlatsheetLengthMissing = [];
  for (const row of products) {
    const n = String(row?.name ?? '').trim();
    if (!n || !isStoneFlatsheetQuotationLine(n)) continue;
    const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
    if (qty <= 0) continue;
    const lm = resolveStoneFlatsheetLengthM(row);
    if (lm == null) stoneFlatsheetLengthMissing.push(n);
  }

  if (
    invalidProductNames.length === 0 &&
    invalidAccessoryNames.length === 0 &&
    stoneFlatsheetLengthMissing.length === 0 &&
    !invalidProfile &&
    !invalidGauge &&
    !invalidColour
  ) {
    return { ok: true };
  }

  const parts = [];
  if (invalidProductNames.length) {
    parts.push(`Invalid product line(s) for stone coated: ${invalidProductNames.join(', ')}.`);
  }
  if (invalidAccessoryNames.length) {
    parts.push(`Invalid accessory line(s) for stone coated: ${invalidAccessoryNames.join(', ')}.`);
  }
  if (stoneFlatsheetLengthMissing.length) {
    parts.push(
      'Stone flatsheet lines with quantity must include length 1.4 m or 2 m (product name or length field per line).'
    );
  }
  if (invalidProfile) parts.push('Profile is not valid for this material type.');
  if (invalidGauge) parts.push('Gauge is not valid for this material type.');
  if (invalidColour) parts.push('Colour is not valid for this material type (price list).');

  return {
    ok: false,
    error: parts.join(' ') || 'Quotation does not meet material rules.',
    code: QUOTATION_MATERIAL_RULES_CODE,
    details: {
      invalidProductNames,
      invalidAccessoryNames,
      invalidHeader,
      stoneFlatsheetLengthMissing,
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} linesJson
 */
export function assertQuotationMaterialRules(db, linesJson) {
  const r = validateQuotationMaterialRules(db, linesJson);
  if (r.ok) return;
  const err = new Error(r.error);
  err.code = r.code;
  err.details = r.details;
  err.statusCode = 422;
  throw err;
}

export const QUOTATION_LINE_INTEGRITY_CODE = 'QUOTATION_LINE_INTEGRITY';

function quotationLineNumericQty(row) {
  return Number(String(row?.qty ?? row?.quantity ?? '').replace(/,/g, '')) || 0;
}

function quotationLineNumericUnitPrice(row) {
  if (row?.unitPrice != null && row?.unitPrice !== '') {
    return Number(String(row.unitPrice).replace(/,/g, '')) || 0;
  }
  if (row?.unit_price != null && row?.unit_price !== '') {
    return Number(String(row.unit_price).replace(/,/g, '')) || 0;
  }
  if (row?.unit_price_ngn != null) return Number(row.unit_price_ngn) || 0;
  return 0;
}

/**
 * Every line with quantity or unit price must have a selected product name.
 * Stone flatsheet lines with qty also require length 1.4 / 2 m (all material types).
 * @param {object} linesJson
 * @returns {{ ok: true } | { ok: false, error: string, code: string, details: object }}
 */
export function validateQuotationLineIntegrity(linesJson) {
  const j = linesJson && typeof linesJson === 'object' ? linesJson : {};
  const unnamedWithValues = [];
  const stoneFlatsheetLengthMissing = [];

  for (const cat of ['products', 'accessories', 'services']) {
    const arr = Array.isArray(j[cat]) ? j[cat] : [];
    for (const row of arr) {
      const n = String(row?.name ?? '').trim();
      const qty = quotationLineNumericQty(row);
      const unitPrice = quotationLineNumericUnitPrice(row);
      if ((qty > 0 || unitPrice > 0) && !n) {
        unnamedWithValues.push(cat);
      }
      if (n && isStoneFlatsheetQuotationLine(n) && qty > 0) {
        if (resolveStoneFlatsheetLengthM(row) == null) {
          stoneFlatsheetLengthMissing.push(n);
        }
      }
    }
  }

  if (unnamedWithValues.length === 0 && stoneFlatsheetLengthMissing.length === 0) {
    return { ok: true };
  }

  const parts = [];
  if (unnamedWithValues.length) {
    parts.push('Select a product on every line before entering quantity or unit price.');
  }
  if (stoneFlatsheetLengthMissing.length) {
    parts.push(
      'Stone flatsheet lines with quantity must include length 1.4 m or 2 m (select product and length before entering m²).'
    );
  }

  return {
    ok: false,
    error: parts.join(' '),
    code: QUOTATION_LINE_INTEGRITY_CODE,
    details: { unnamedWithValues, stoneFlatsheetLengthMissing },
  };
}

export function assertQuotationLineIntegrity(linesJson) {
  const r = validateQuotationLineIntegrity(linesJson);
  if (r.ok) return;
  const err = new Error(r.error);
  err.code = r.code;
  err.details = r.details;
  err.statusCode = 422;
  throw err;
}

/** UI gate: qty / unit price editable only when product (and stone length when required) is set. */
export function quotationLineQtyPriceEnabled(row, opts = {}) {
  const n = String(row?.name ?? '').trim();
  if (!n) return false;
  if (opts.requireStoneLength && isStoneFlatsheetQuotationLine(n)) {
    return resolveStoneFlatsheetLengthM(row) != null;
  }
  return true;
}

/**
 * Client-side: apply stone_meter cleanup when material type changes (no DB).
 * @param {object} param0
 * @param {boolean} param0.toStoneMeter
 * @param {{ id: string, name: string, qty?: string, unitPrice?: string }[]} param0.products
 * @param {{ id: string, name: string, qty?: string, unitPrice?: string }[]} param0.accessories
 * @param {string} param0.materialGauge
 * @param {string} param0.materialColor
 * @param {string} param0.materialDesign
 * @param {Set<string> | null} param0.allowedProfileKeys — from master profiles for new type, or null to use fallback
 */
export function applyStoneMeterMaterialChangeCleanup({
  toStoneMeter,
  products,
  accessories,
  materialGauge,
  materialColor,
  materialDesign,
  allowedProfileKeys,
}) {
  if (!toStoneMeter) {
    return {
      products,
      accessories,
      materialGauge,
      materialColor,
      materialDesign,
      removedProducts: [],
      removedAccessories: [],
      clearedHeader: { gauge: false, colour: false, profile: false },
    };
  }
  const hasFlat = quotationHasFlatSheetLine(products);
  const nextProducts = [];
  const removedProducts = [];
  for (const row of products) {
    const n = String(row?.name ?? '').trim();
    if (!n) {
      nextProducts.push(row);
      continue;
    }
    if (productLineAllowedForStone(n, hasFlat)) {
      nextProducts.push(row);
    } else {
      removedProducts.push(n);
    }
  }
  const hasFlatAfter = quotationHasFlatSheetLine(nextProducts);
  const finalProducts = [];
  for (const row of nextProducts) {
    const n = String(row?.name ?? '').trim();
    if (productLineKey(n) === COIL_KEY && !hasFlatAfter) {
      removedProducts.push(n);
      continue;
    }
    finalProducts.push(row);
  }

  const nextAccessories = [];
  const removedAccessories = [];
  for (const row of accessories) {
    const n = String(row?.name ?? '').trim();
    if (!n) {
      nextAccessories.push(row);
      continue;
    }
    if (accessoryLineAllowedForStone(n)) {
      nextAccessories.push(row);
    } else {
      removedAccessories.push(n);
    }
  }

  const profKeys =
    allowedProfileKeys && allowedProfileKeys.size
      ? allowedProfileKeys
      : new Set(STONE_PROFILE_FALLBACK.map(normQuoteItemKey));
  let mg = materialGauge;
  let mc = materialColor;
  let md = materialDesign;
  const clearedHeader = { gauge: false, colour: false, profile: false };
  if (md && !profKeys.has(normQuoteItemKey(md))) {
    md = '';
    clearedHeader.profile = true;
  }

  return {
    products: finalProducts,
    accessories: nextAccessories,
    materialGauge: mg,
    materialColor: mc,
    materialDesign: md,
    removedProducts,
    removedAccessories,
    clearedHeader,
  };
}
