/**
 * Colour matching for coil rows vs quotation / catalog labels.
 * Mirrors frontend `src/lib/stockCheckMasterOptions.js` (Sales stock filters).
 */

/**
 * Map coil/PO abbreviation or alias to Setup master colour name (e.g. IV → Ivory Beige).
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string | null | undefined} rawColour
 * @returns {string}
 */
export function canonicalColourName(masterData, rawColour) {
  const raw = String(rawColour ?? '').trim();
  if (!raw) return '';
  const colours = masterData?.colours;
  if (!Array.isArray(colours) || !colours.length) return raw;
  const tokens = [...new Set([raw, raw.split(/[·,]/)[0].trim()].filter(Boolean))];
  for (const token of tokens) {
    const tl = token.toLowerCase();
    for (const c of colours) {
      if (c.active === false) continue;
      const name = String(c.name || '').trim();
      const abbr = String(c.abbreviation || '').trim();
      if (!name) continue;
      if (tl === name.toLowerCase() || (abbr && tl === abbr.toLowerCase())) return name;
    }
  }
  return raw;
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
