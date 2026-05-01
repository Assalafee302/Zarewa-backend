/**
 * Colour matching for coil rows vs quotation / catalog labels.
 * Mirrors frontend `src/lib/stockCheckMasterOptions.js` (Sales stock filters).
 */

/**
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string} colourName master colour name (quotation materialColor)
 * @param {{ colour?: string; colourRaw?: string }} row
 */
export function stockRowMatchesColourFilter(masterData, colourName, row) {
  const f = String(colourName || '').trim().toLowerCase();
  if (!f) return true;
  const raw = String(row.colourRaw ?? row.colour ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === f) return true;
  if (raw.includes(f) || f.includes(raw)) return true;
  const abbr = (masterData?.colours || []).find((c) => String(c.name || '').trim().toLowerCase() === f)
    ?.abbreviation;
  if (abbr) {
    const a = String(abbr).trim().toLowerCase();
    if (a && raw.includes(a)) return true;
  }
  const first = raw.split(/[·,]/)[0].trim();
  if (first === f) return true;
  if (f.length >= 3 && first && (first.includes(f) || f.includes(first))) return true;
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
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return true;
  if (al.includes(bl) || bl.includes(al)) return true;
  if (!Array.isArray(masterData?.colours) || !masterData.colours.length) return false;
  if (stockRowMatchesColourFilter(masterData, a, { colour: b, colourRaw: b })) return true;
  if (stockRowMatchesColourFilter(masterData, b, { colour: a, colourRaw: a })) return true;
  return false;
}
