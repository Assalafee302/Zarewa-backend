/**
 * Canonical coil / quotation colour names — merges abbreviations, grey/gray spellings, and typos.
 * Keep in sync with frontend `src/lib/colourCanonicalization.js`.
 */

/** Preferred setup_colours ids for aluminium / aluzinc (migrateCoilAluzincColours2026). */
export const PREFERRED_COIL_COLOUR_IDS = new Set([
  'COL-001',
  'COL-002',
  'COL-003',
  'COL-004',
  'COL-005',
  'COL-006',
  'COL-007',
  'COL-008',
  'COL-009',
  'COL-010',
  'COL-011',
  'COL-012',
  'COL-013',
  'COL-014',
  'COL-015',
  'COL-016',
  'COL-017',
  'COL-018',
]);

/** Normalized token → canonical display name (coil catalogue). */
export const COLOUR_ALIAS_BY_KEY = {
  hmb: 'HM Blue',
  hmblue: 'HM Blue',
  hmblu: 'HM Blue',
  iv: 'Ivory Beige',
  ivory: 'Ivory Beige',
  ivorybeige: 'Ivory Beige',
  ivorybege: 'Ivory Beige',
  gb: 'Gray Beige',
  graybeige: 'Gray Beige',
  greybeige: 'Gray Beige',
  graybege: 'Gray Beige',
  tb: 'Traffic Black',
  trafficblack: 'Traffic Black',
  bg: 'Bush Green',
  bushgreen: 'Bush Green',
  tr: 'TC Red',
  tcred: 'TC Red',
  pr: 'P Red',
  pred: 'P Red',
  pg: 'Pale Green',
  palegreen: 'Pale Green',
  nb: 'Nut Brown',
  nutbrown: 'Nut Brown',
  ng: 'National Green',
  nationalgreen: 'National Green',
  cb: 'Cobalt Blue',
  cobaltblue: 'Cobalt Blue',
  cy: 'Canary Yellow',
  canaryyellow: 'Canary Yellow',
  zg: 'Zinc Grey',
  zincgrey: 'Zinc Grey',
  zincgray: 'Zinc Grey',
  vg: 'Vandal Grey',
  vandalgrey: 'Vandal Grey',
  dg: 'Dark Grey',
  darkgrey: 'Dark Grey',
  wr: 'Wine Red',
  winered: 'Wine Red',
  st: 'Stucco',
  cl: 'Coloured',
  coloured: 'Coloured',
  colored: 'Coloured',
};

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeColourKey(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return '';
  s = s.replace(/\bcolou?rs?\b/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bgray\b/g, 'grey');
  s = s.replace(/\bbege\b/g, 'beige');
  s = s.replace(/\bgreem\b/g, 'green');
  s = s.replace(/\bbleu\b/g, 'blue');
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

/**
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @returns {Map<string, string>}
 */
export function buildColourLookupMap(masterData) {
  const map = new Map();
  const add = (token, name) => {
    const key = normalizeColourKey(token);
    const canon = String(name || '').trim();
    if (!key || !canon) return;
    if (!map.has(key)) map.set(key, canon);
  };

  for (const [aliasKey, canonName] of Object.entries(COLOUR_ALIAS_BY_KEY)) {
    add(aliasKey, canonName);
  }

  for (const c of masterData?.colours || []) {
    if (c.active === false) continue;
    const name = String(c.name || '').trim();
    const abbr = String(c.abbreviation || '').trim();
    if (!name) continue;
    add(name, name);
    if (abbr) add(abbr, name);
    for (const part of name.split(/[·,/]/)) {
      const p = part.trim();
      if (p) add(p, name);
    }
  }
  return map;
}

/**
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string | null | undefined} rawColour
 * @returns {string}
 */
export function canonicalColourName(masterData, rawColour) {
  const raw = String(rawColour ?? '').trim();
  if (!raw) return '';
  const lookup = buildColourLookupMap(masterData);
  const tokens = [...new Set([raw, raw.split(/[·,]/)[0].trim()].filter(Boolean))];
  for (const token of tokens) {
    const hit = lookup.get(normalizeColourKey(token));
    if (hit) return hit;
  }
  return raw;
}

/**
 * @param {{ colour_id: string, name: string, abbreviation?: string, active?: number|boolean, sort_order?: number }[]} rows
 * @returns {typeof rows[]}
 */
export function clusterDuplicateSetupColours(rows) {
  const active = (rows || []).filter((r) => r.active !== false && r.active !== 0);
  const groups = [];
  const seen = new Set();

  const pushGroup = (list) => {
    const uniq = [];
    const ids = new Set();
    for (const r of list) {
      const id = String(r.colour_id || '').trim();
      if (!id || ids.has(id)) continue;
      ids.add(id);
      uniq.push(r);
    }
    if (uniq.length < 2) return;
    const sig = uniq
      .map((r) => r.colour_id)
      .sort()
      .join('|');
    if (seen.has(sig)) return;
    seen.add(sig);
    groups.push(uniq);
  };

  const byName = new Map();
  for (const r of active) {
    const key = normalizeColourKey(r.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  for (const list of byName.values()) pushGroup(list);

  const byAbbr = new Map();
  for (const r of active) {
    const abbr = String(r.abbreviation || '').trim().toLowerCase();
    if (!abbr || abbr.length < 2) continue;
    if (!byAbbr.has(abbr)) byAbbr.set(abbr, []);
    byAbbr.get(abbr).push(r);
  }
  for (const list of byAbbr.values()) pushGroup(list);

  return groups;
}

/**
 * @param {{ colour_id: string, name: string, abbreviation?: string, sort_order?: number }[]} group
 */
export function pickCanonicalSetupColourRow(group) {
  const rows = [...(group || [])];
  rows.sort((a, b) => {
    const aPref = PREFERRED_COIL_COLOUR_IDS.has(String(a.colour_id || '').trim()) ? 0 : 1;
    const bPref = PREFERRED_COIL_COLOUR_IDS.has(String(b.colour_id || '').trim()) ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    const aSt = String(a.colour_id || '').startsWith('COL-ST') ? 1 : 0;
    const bSt = String(b.colour_id || '').startsWith('COL-ST') ? 1 : 0;
    if (aSt !== bSt) return aSt - bSt;
    const as = Number(a.sort_order);
    const bs = Number(b.sort_order);
    const aSort = Number.isFinite(as) ? as : 9999;
    const bSort = Number.isFinite(bs) ? bs : 9999;
    if (aSort !== bSort) return aSort - bSort;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return rows[0] || null;
}

/**
 * @param {{ colours?: object[] } | null | undefined} masterData
 * @param {string | null | undefined} colourA
 * @param {string | null | undefined} colourB
 */
export function coloursEquivalent(masterData, colourA, colourB) {
  const a = String(colourA ?? '').trim();
  const b = String(colourB ?? '').trim();
  if (!a || !b) return false;
  const ca = canonicalColourName(masterData, a);
  const cb = canonicalColourName(masterData, b);
  if (ca && cb && ca.toLowerCase() === cb.toLowerCase()) return true;
  return normalizeColourKey(a) === normalizeColourKey(b);
}
