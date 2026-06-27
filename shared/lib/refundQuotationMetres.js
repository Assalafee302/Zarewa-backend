import { isStoneFlatsheetQuotationLine } from './stoneCoatedQuotationPolicy.js';
import { quotationLineQtyNumber } from './quotationLineNumericForRefund.js';

function normQuoteProductLineName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const REFUND_NON_ROOFING_SHEET_PRODUCT_NAMES = new Set([
  'bargeboard',
  'top end',
  'gutter',
  'eaves angle',
  'eave angle',
  'wall flashing',
  'ridge cap',
  'capping',
  'bottom eaves',
  'fascia',
  'cladding',
  'offcut',
  'wall eaves',
  'crimp',
  'coil',
]);

function productLineIsTrimSheetNotRoofingMetres(line) {
  const n = normQuoteProductLineName(line?.name);
  if (!n) return false;
  return REFUND_NON_ROOFING_SHEET_PRODUCT_NAMES.has(n);
}

/** Quoted roofing-sheet metres (excludes trim/cladding and stone flatsheet m² lines). */
export function quotedRoofingSheetMetresFromLines(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const rows = payload?.products;
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, line) => {
    if (productLineIsTrimSheetNotRoofingMetres(line) || isStoneFlatsheetQuotationLine(line?.name)) return sum;
    return sum + quotationLineQtyNumber(line);
  }, 0);
}
