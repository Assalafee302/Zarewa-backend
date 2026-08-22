/**
 * Stock check sidebar on Sales — same master-data sources as QuotationModal
 * (Setup → material types, gauges, colours). Keep inventory model filter in sync
 * with QuotationModal QUOTATION_MATERIAL_INVENTORY_MODELS.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/stockCheckMasterOptions.js
 */
import { compareGaugeLabels } from './selectOptionSort.js';
import {
  canonicalColourName,
  colourSelectOptionsFromRows,
  mergeStockColourSelectOptions,
} from './colourCanonicalization.js';

export { mergeStockColourSelectOptions };

export { canonicalColourName };

const QUOTATION_MATERIAL_INVENTORY_MODELS = new Set(['coil_kg', 'stone_meter']);

/**
 * @param {{ materialTypes?: object[]; gauges?: object[]; colours?: object[] } | null | undefined} masterData
 * @returns {{ types: { value: string; label: string }[]; gauges: { value: string; label: string }[]; colours: { value: string; label: string }[] }}
 */
export function stockCheckSelectOptionsFromMasterData(masterData) {
  const md = masterData || {};
  const types = (md.materialTypes || [])
    .filter((row) => row.active !== false)
    .filter((row) =>
      QUOTATION_MATERIAL_INVENTORY_MODELS.has(String(row.inventoryModel || 'coil_kg').trim())
    )
    .map((row) => ({ value: String(row.id || '').trim(), label: String(row.name || row.id || '').trim() || '—' }))
    .filter((o) => o.value)
    .sort((a, b) => a.label.localeCompare(b.label));

  const gaugeLabels = (md.gauges || [])
    .filter((row) => row.active !== false)
    .map((row) => String(row.label || '').trim())
    .filter(Boolean);
  const gauges = [...new Set(gaugeLabels)]
    .sort(compareGaugeLabels)
    .map((label) => ({ value: label, label }));

  const colours = colourSelectOptionsFromRows(md.colours || [], md).map((o) => ({
    value: o.value,
    label: o.label,
  }));

  return { types, gauges, colours };
}

/**
 * When Setup master rows are empty, derive options from live coil / yard rows (legacy behaviour).
 * @param {Array<{ materialType?: string; gaugeLabel?: string; colour?: string; colourRaw?: string }>} coilRows
 * @param {{ colours?: object[] } | null | undefined} [masterData]
 */
export function stockCheckSelectOptionsFromCoilRows(coilRows, masterData = null) {
  const types = [
    ...new Set((coilRows || []).map((r) => String(r.materialType || '').trim()).filter(Boolean)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ value: label, label }));
  const gauges = [
    ...new Set((coilRows || []).map((r) => String(r.gaugeLabel ?? '').trim()).filter((g) => g && g !== '—')),
  ]
    .sort(compareGaugeLabels)
    .map((label) => ({ value: label, label }));
  const colours = [
    ...new Set(
      (coilRows || [])
        .map((r) => canonicalColourName(masterData, r.colourRaw ?? r.colour))
        .filter((c) => c && c !== '—')
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ value: label, label }));
  return { types, gauges, colours };
}

/**
 * @param {{ materialTypes?: object[] } | null | undefined} masterData
 * @param {string} materialTypeId
 * @param {string} rowMaterialType free-text from coil / product
 */
export function stockRowMatchesMaterialTypeFilter(masterData, materialTypeId, rowMaterialType) {
  const id = String(materialTypeId || '').trim();
  if (!id) return true;
  const row = String(rowMaterialType || '').trim().toLowerCase();
  if (!row) return false;
  const mt = (masterData?.materialTypes || []).find((m) => String(m.id || '').trim() === id);
  const name = String(mt?.name || '').trim().toLowerCase();
  if (name && row === name) return true;
  if (name && (row.includes(name) || name.includes(row))) return true;
  if (!mt && row === id.toLowerCase()) return true;
  return false;
}

/**
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string} colourName master colour name (quotation materialColor)
 * @param {{ colour?: string; colourRaw?: string }} row
 */
export function stockRowMatchesColourFilter(masterData, colourName, row) {
  const f = String(colourName || '').trim();
  if (!f) return true;
  const raw = String(row.colourRaw ?? row.colour ?? '').trim();
  if (!raw) return false;
  const canonF = canonicalColourName(masterData, f);
  const canonRaw = canonicalColourName(masterData, raw);
  if (canonF && canonRaw && canonF.toLowerCase() === canonRaw.toLowerCase()) return true;

  const fl = f.toLowerCase();
  const rl = raw.toLowerCase();
  if (rl === fl) return true;
  if (rl.includes(fl) || fl.includes(rl)) return true;
  const masterRow = (masterData?.colours || []).find((c) => {
    const name = String(c.name || '').trim().toLowerCase();
    const abbr = String(c.abbreviation || '').trim().toLowerCase();
    return name === fl || (abbr && abbr === fl);
  });
  if (masterRow) {
    const nl = String(masterRow.name || '').trim().toLowerCase();
    const al = String(masterRow.abbreviation || '').trim().toLowerCase();
    if (rl === nl || (al && rl === al)) return true;
    if (al && rl.length === al.length && rl === al) return true;
  }
  const first = rl.split(/[·,]/)[0].trim();
  if (first === fl) return true;
  if (fl.length >= 3 && first && (first.includes(fl) || fl.includes(first))) return true;
  return false;
}

/**
 * Symmetric colour equivalence using Setup master rows (name ↔ abbreviation).
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string | null | undefined} colourA
 * @param {string | null | undefined} colourB
 */
export function coloursMatchWithMaster(masterData, colourA, colourB) {
  const a = String(colourA ?? '').trim();
  const b = String(colourB ?? '').trim();
  if (!a || !b) return false;
  const canonA = canonicalColourName(masterData, a);
  const canonB = canonicalColourName(masterData, b);
  if (canonA && canonB && canonA.toLowerCase() === canonB.toLowerCase()) return true;
  if (stockRowMatchesColourFilter(masterData, a, { colour: b, colourRaw: b })) return true;
  if (stockRowMatchesColourFilter(masterData, b, { colour: a, colourRaw: a })) return true;
  return false;
}
