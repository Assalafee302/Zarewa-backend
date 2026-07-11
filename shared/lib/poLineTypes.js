/**
 * Purchase order line types — shared by server and frontend.
 * Keep in sync with Zarewa-frontend-main/src/lib/poLineTypes.js
 */

export const PO_LINE_TYPES = [
  'coil_kg',
  'coil_meter',
  'stone_meter',
  'stone_flatsheet',
  'accessory',
  'service',
];

/** @typedef {'coil_kg' | 'coil_meter' | 'stone_meter' | 'stone_flatsheet' | 'accessory' | 'service'} PoLineType */

export const PO_LINE_TYPE_LABELS = {
  coil_kg: 'Coil (kg)',
  coil_meter: 'Roll / metre order',
  stone_meter: 'Stone coated (metres)',
  stone_flatsheet: 'Stone flatsheet (sheets)',
  accessory: 'Accessory',
  service: 'Service / loading fee',
};

/** Preset service descriptions on purchase orders (loading at mill, labour, etc.). */
export const PO_DEFAULT_SERVICE_ITEMS = [
  'Loading fee',
  'Offloading at mill',
  'Labour at purchase',
  'Weighbridge / documentation',
  'Commission',
  'Transportation',
  'Other',
];

export const PO_SERVICE_PRODUCT_ID = 'SVC-PO';

/** Stone flatsheet effective width (m) for sheets → m² at GRN. */
export const STONE_FLATSHEET_WIDTH_M = 1.2;

const COIL_PRODUCT_IDS = new Set(['COIL-ALU', 'PRD-102']);

/**
 * @param {string | null | undefined} productId
 * @param {{ dashboard_attrs_json?: string; dashboardAttrs?: object; unit?: string } | null} [productRow]
 * @param {{ lineType?: string; line_type?: string; metersOffered?: number | null; meters_offered?: number | null; unitPricePerKgNgn?: number | null; unit_price_per_kg_ngn?: number | null; qtyOrdered?: number; qty_ordered?: number } | null} [poLine]
 * @returns {PoLineType}
 */
export function inferLineTypeFromProduct(productId, productRow = null, poLine = null) {
  const explicit = String(poLine?.lineType ?? poLine?.line_type ?? '').trim();
  if (PO_LINE_TYPES.includes(explicit)) return explicit;

  const pid = String(productId || '').trim();
  if (/^SVC-/i.test(pid)) return 'service';
  if (/^ACC-/i.test(pid)) return 'accessory';
  if (/^STONE-FS-/i.test(pid)) return 'stone_flatsheet';
  if (/^STONE-/i.test(pid)) return 'stone_meter';
  if (COIL_PRODUCT_IDS.has(pid)) {
    const meters = Number(poLine?.metersOffered ?? poLine?.meters_offered);
    const ordered = Number(poLine?.qtyOrdered ?? poLine?.qty_ordered);
    const upkg = Number(poLine?.unitPricePerKgNgn ?? poLine?.unit_price_per_kg_ngn);
    if (
      (!Number.isFinite(upkg) || upkg <= 0) &&
      Number.isFinite(meters) &&
      meters > 0 &&
      Number.isFinite(ordered) &&
      Math.abs(ordered - meters) <= 0.001
    ) {
      return 'coil_meter';
    }
    return 'coil_kg';
  }

  let attrs = productRow?.dashboardAttrs;
  if (!attrs && productRow?.dashboard_attrs_json) {
    try {
      attrs = JSON.parse(productRow.dashboard_attrs_json);
    } catch {
      attrs = {};
    }
  }
  if (attrs?.stoneFlatsheet) return 'stone_flatsheet';
  if (attrs?.inventoryModel === 'stone_meter' || attrs?.stoneDesign) return 'stone_meter';
  if (attrs?.inventoryModel === 'consumable' || /^ACC-/i.test(String(attrs?.accessoryKind || ''))) {
    return 'accessory';
  }

  return 'coil_kg';
}

/**
 * @param {PoLineType} lineType
 */
export function poLinePriceSuffix(lineType) {
  if (lineType === 'stone' || lineType === 'stone_meter' || lineType === 'coil_meter') return '/m';
  if (lineType === 'stone_flatsheet') return '/sheet';
  if (lineType === 'accessory') return '/unit';
  if (lineType === 'service') return '/lot';
  if (lineType === 'coil') return '/kg';
  return '/kg';
}

/** GRN UI branch key per PO line. */
export function grnKindForPoLine(line) {
  const lt = String(line?.lineType || '').trim() || inferLineTypeFromProduct(line?.productID, null, line);
  if (lt === 'stone_meter') return 'stone';
  if (lt === 'stone_flatsheet') return 'stone_flatsheet';
  if (lt === 'accessory') return 'accessory';
  if (lt === 'service') return 'service';
  return 'coil';
}

export function isCoilMeterBasisLine(line) {
  const lt = String(line?.lineType || '').trim() || inferLineTypeFromProduct(line?.productID, null, line);
  if (lt === 'coil_meter') return true;
  if (lt === 'coil_kg') return false;
  const upkg = Number(line?.unitPricePerKgNgn);
  const meters = Number(line?.metersOffered);
  const ordered = Number(line?.qtyOrdered);
  return (
    (!Number.isFinite(upkg) || upkg <= 0) &&
    Number.isFinite(meters) &&
    meters > 0 &&
    Number.isFinite(ordered) &&
    Math.abs(ordered - meters) <= 0.001
  );
}

/** Weighbridge vs PO paperwork — coil lines within this gap show as closed in UI before GRN snap. */
export const COIL_RECEIPT_SHORT_KG_MIN = 50;
export const COIL_RECEIPT_SHORT_PCT = 0.02;

export function coilReceiptShortToleranceKg(qtyOrdered) {
  const q = Number(qtyOrdered) || 0;
  if (q <= 0) return COIL_RECEIPT_SHORT_KG_MIN;
  return Math.max(COIL_RECEIPT_SHORT_KG_MIN, q * COIL_RECEIPT_SHORT_PCT);
}

/**
 * Open quantity still receivable on a PO line (0 when coil short-land is within tolerance).
 * @param {{ lineType?: string; productID?: string; qtyOrdered?: number; qtyReceived?: number }} line
 * @param {PoLineType} [lineType]
 */
export function poLineOpenQtyForReceiving(line, lineType) {
  const lt = lineType || inferLineTypeFromProduct(line?.productID, null, line);
  if (lt === 'service') return 0;
  const ordered = Number(line?.qtyOrdered ?? line?.qty_ordered) || 0;
  const received = Number(line?.qtyReceived ?? line?.qty_received) || 0;
  const gap = Math.max(0, ordered - received);
  if (gap <= 0) return 0;
  if (lt === 'coil_kg' || lt === 'coil_meter') {
    if (gap <= coilReceiptShortToleranceKg(ordered)) return 0;
  }
  return gap;
}

/** @param {{ lineType?: string; productID?: string; qtyOrdered?: number; qtyReceived?: number }} line */
export function poLineIsOpenForReceiving(line) {
  const lt = inferLineTypeFromProduct(line?.productID, null, line);
  return poLineOpenQtyForReceiving(line, lt) > 0;
}

/**
 * @param {{ lineType?: string; qtyOrdered?: number; qtyReceived?: number }} line
 * @param {PoLineType} lineType
 */
export function poLineQtyLabel(line, lineType) {
  const lt = lineType || inferLineTypeFromProduct(line?.productID, null, line);
  const open = poLineOpenQtyForReceiving(line, lt);
  if (lt === 'stone_meter' || lt === 'coil_meter') return `${open.toLocaleString()} m open`;
  if (lt === 'stone_flatsheet') return `${open.toLocaleString()} sheets open`;
  if (lt === 'accessory') return `${open.toLocaleString()} units open`;
  if (lt === 'service') return '—';
  return `${open.toLocaleString()} kg open`;
}

/**
 * @param {object} line draft or API line
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validatePoLine(line) {
  const lineType = String(line?.lineType ?? line?.line_type ?? '').trim();
  if (!PO_LINE_TYPES.includes(lineType)) {
    return { ok: false, error: 'Each line needs a valid line type.' };
  }
  const pid = String(line?.productID ?? line?.product_id ?? '').trim();
  const qty = Number(line?.qtyOrdered ?? line?.qty_ordered);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: 'Each line needs ordered quantity > 0.' };
  }

  if (lineType === 'coil_kg' || lineType === 'coil_meter') {
    if (!COIL_PRODUCT_IDS.has(pid)) return { ok: false, error: 'Coil lines need aluminium or aluzinc material.' };
    if (!String(line?.color ?? line?.color ?? '').trim()) {
      return { ok: false, error: 'Coil lines need colour.' };
    }
    if (!String(line?.gauge ?? '').trim()) return { ok: false, error: 'Coil lines need gauge.' };
    if (lineType === 'coil_meter') {
      const m = Number(line?.metersOffered ?? line?.meters_offered);
      if (!Number.isFinite(m) || m <= 0) {
        return { ok: false, error: 'Metre-basis coil lines need ordered metres.' };
      }
    }
  }

  if (lineType === 'stone_meter') {
    if (!/^STONE-/i.test(pid) || /^STONE-FS-/i.test(pid)) {
      return { ok: false, error: 'Stone metre lines need a stone-coated SKU.' };
    }
  }

  if (lineType === 'stone_flatsheet') {
    if (!/^STONE-FS-/i.test(pid)) {
      return { ok: false, error: 'Stone flatsheet lines need a flatsheet SKU.' };
    }
    const len = Number(line?.metersOffered ?? line?.meters_offered);
    if (!Number.isFinite(len) || len <= 0) {
      return { ok: false, error: 'Stone flatsheet lines need sheet length (1.4 or 2 m).' };
    }
  }

  if (lineType === 'accessory' && !/^ACC-/i.test(pid)) {
    return { ok: false, error: 'Accessory lines need an ACC-* product.' };
  }

  if (lineType === 'service') {
    const name = String(line?.productName ?? line?.product_name ?? '').trim();
    if (!name) {
      return { ok: false, error: 'Service lines need a description (e.g. Loading fee).' };
    }
    if (!/^SVC-/i.test(pid)) {
      return { ok: false, error: 'Service lines need a service product id (SVC-PO).' };
    }
    const unit = Number(line?.unitPriceNgn ?? line?.unit_price_ngn);
    if (!Number.isFinite(unit) || unit <= 0) {
      return { ok: false, error: 'Service lines need amount ₦ greater than zero.' };
    }
  }

  return { ok: true };
}

/**
 * Sheets × length × width → m² for stone flatsheet GRN.
 * @param {number} sheets
 * @param {number} lengthM
 */
export function stoneFlatsheetSheetsToM2(sheets, lengthM) {
  const s = Number(sheets);
  const len = Number(lengthM);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(len) || len <= 0) return 0;
  return s * len * STONE_FLATSHEET_WIDTH_M;
}

/**
 * @param {string[]} lineTypes
 * @returns {'coil' | 'stone' | 'accessory' | 'mixed'}
 */
export function deriveProcurementKindFromLineTypes(lineTypes) {
  const kinds = new Set();
  for (const t of lineTypes || []) {
    const lt = String(t || '').trim();
    if (lt === 'service') continue;
    if (lt === 'stone_meter' || lt === 'stone_flatsheet') kinds.add('stone');
    else if (lt === 'accessory') kinds.add('accessory');
    else kinds.add('coil');
  }
  if (kinds.size === 0) {
    const hasService = (lineTypes || []).some((t) => String(t || '').trim() === 'service');
    return hasService ? 'accessory' : 'coil';
  }
  if (kinds.size === 1) return [...kinds][0];
  return 'mixed';
}

/**
 * @param {{ lineType?: string; productID?: string }[]} lines
 */
export function deriveProcurementKindFromPoLines(lines) {
  const types = (lines || []).map((l) =>
    inferLineTypeFromProduct(l.productID ?? l.product_id, null, l)
  );
  return deriveProcurementKindFromLineTypes(types);
}
