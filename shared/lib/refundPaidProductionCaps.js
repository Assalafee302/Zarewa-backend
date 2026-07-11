import { parseUnproducedMetresLabel } from './refundLineArithmetic.js';

function normAccessoryNameKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseJsonLines(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** @returns {{ metres: number, pricePerMeterNgn: number } | null} */
export function parseAccessoryShortfallLabel(label) {
  const text = String(label || '').trim();
  const m = text.match(/Accessory shortfall:\s*(.+?)\s*\(([\d.]+)\s*×/i);
  if (!m) return null;
  const name = String(m[1] || '').trim();
  const qty = Number(m[2]);
  if (!name || !Number.isFinite(qty) || qty <= 0) return null;
  return { name, qty };
}

/** @returns {{ name: string, lengthM: number, shortfallM2: number, shortfallPcs?: number } | null} */
export function parseStoneFlatsheetShortfallLabel(label) {
  const text = String(label || '').trim();
  /* pcs form: Stone flatsheet shortfall: sold sheets (2.00 × 2 m) — 4.00 m² */
  const pcs = text.match(
    /Stone flatsheet shortfall:\s*(.+?)\s*\(([\d.]+)\s*×\s*([\d.]+)\s*m\)\s*—\s*([\d.]+)\s*m²/i
  );
  if (pcs) {
    const name = String(pcs[1] || '').trim();
    const shortfallPcs = Number(pcs[2]);
    const lengthM = Number(pcs[3]);
    const shortfallM2 = Number(pcs[4]);
    if (!name || !Number.isFinite(lengthM) || !Number.isFinite(shortfallM2) || shortfallM2 <= 0) return null;
    return {
      name,
      lengthM,
      shortfallM2,
      shortfallPcs: Number.isFinite(shortfallPcs) ? shortfallPcs : undefined,
    };
  }
  const m = text.match(
    /Stone flatsheet shortfall:\s*(.+?)\s*\(([\d.]+)\s*m\)\s*—\s*([\d.]+)\s*m²/i
  );
  if (!m) return null;
  const name = String(m[1] || '').trim();
  const lengthM = Number(m[2]);
  const shortfallM2 = Number(m[3]);
  if (!name || !Number.isFinite(lengthM) || !Number.isFinite(shortfallM2) || shortfallM2 <= 0) return null;
  return { name, lengthM, shortfallM2 };
}

function normCat(c) {
  return String(c || '')
    .trim()
    .toLowerCase();
}

/**
 * Sum shortfalls encoded on paid refund calculation lines.
 * @param {Array<{ label?: string, category?: string, include?: boolean }>} lines
 */
export function aggregatePaidShortfallsFromRefundLines(lines) {
  let unproducedMetres = 0;
  /** @type {Map<string, number>} */
  const accessoryShortfallByKey = new Map();
  /** @type {Map<string, number>} */
  const stoneShortfallM2ByKey = new Map();

  for (const line of lines || []) {
    if (line?.include === false) continue;
    const cat = normCat(line?.category);
    const label = String(line?.label || '').trim();
    if (!label) continue;

    if (cat === 'unproduced meterage' || /unproduced metres/i.test(label)) {
      const parsed = parseUnproducedMetresLabel(label);
      if (parsed) unproducedMetres += parsed.metres;
      continue;
    }
    if (cat === 'accessory shortfall' || /accessory shortfall/i.test(label)) {
      const parsed = parseAccessoryShortfallLabel(label);
      if (parsed) {
        const key = normAccessoryNameKey(parsed.name);
        accessoryShortfallByKey.set(key, (accessoryShortfallByKey.get(key) || 0) + parsed.qty);
      }
      continue;
    }
    if (cat === 'stone flatsheet shortfall' || /stone flatsheet shortfall/i.test(label)) {
      const parsed = parseStoneFlatsheetShortfallLabel(label);
      if (parsed) {
        const key = `${normAccessoryNameKey(parsed.name)}|${parsed.lengthM}`;
        stoneShortfallM2ByKey.set(key, (stoneShortfallM2ByKey.get(key) || 0) + parsed.shortfallM2);
      }
    }
  }

  return { unproducedMetres, accessoryShortfallByKey, stoneShortfallM2ByKey };
}

/**
 * @param {Array<{ calculation_lines_json?: string; paid_amount_ngn?: number; paidAmountNgn?: number }>} refundRows
 */
export function aggregatePaidShortfallsFromRefunds(refundRows) {
  const allLines = [];
  for (const row of refundRows || []) {
    const paid = Number(row?.paid_amount_ngn ?? row?.paidAmountNgn) || 0;
    if (paid <= 0) continue;
    allLines.push(...parseJsonLines(row?.calculation_lines_json));
  }
  return aggregatePaidShortfallsFromRefundLines(allLines);
}

/** Max roofing metres still producible after paid unproduced refunds. */
export function maxProducedMetresAfterPaidUnproducedRefund(quotedMetres, unproducedMetresRefunded) {
  const quoted = Number(quotedMetres) || 0;
  const refunded = Number(unproducedMetresRefunded) || 0;
  if (refunded <= 0 || quoted <= 0) return null;
  return Math.max(0, quoted - refunded);
}
