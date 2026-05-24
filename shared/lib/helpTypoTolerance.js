/**
 * Typo tolerance for help queries — common misspellings + light fuzzy match.
 */

/** Frequent staff typos → intended ERP terms */
export const HELP_TYPO_MAP = {
  reciept: 'receipt',
  recipt: 'receipt',
  reciepts: 'receipts',
  recipts: 'receipts',
  paymnt: 'payment',
  payement: 'payment',
  paymnet: 'payment',
  qoutation: 'quotation',
  quotaton: 'quotation',
  qotation: 'quotation',
  qoutaion: 'quotation',
  quoation: 'quotation',
  refnd: 'refund',
  refud: 'refund',
  refuns: 'refunds',
  inventry: 'inventory',
  invntory: 'inventory',
  invetory: 'inventory',
  procurment: 'procurement',
  prodcution: 'production',
  producation: 'production',
  cuting: 'cutting',
  cuttng: 'cutting',
  reconcilation: 'reconciliation',
  reconiliation: 'reconciliation',
  delivry: 'delivery',
  deliverry: 'delivery',
  suppplier: 'supplier',
  custmer: 'customer',
  custoemr: 'customer',
  finace: 'finance',
  finanace: 'finance',
  peroid: 'period',
  preiod: 'period',
  trasfer: 'transfer',
  tranasfer: 'transfer',
  approvl: 'approval',
  aproval: 'approval',
  workflw: 'workflow',
  workfow: 'workflow',
  grn: 'grn',
  gnr: 'grn',
};

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = s.length + 1;
  const cols = t.length + 1;
  /** @type {number[][]} */
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[s.length][t.length];
}

/**
 * @param {string} a
 * @param {string} b
 */
export function fuzzyWordsSimilar(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (HELP_TYPO_MAP[x] === y || HELP_TYPO_MAP[y] === x) return true;
  if (x.length < 4 || y.length < 4) return false;
  const maxLen = Math.max(x.length, y.length);
  const maxDist = maxLen <= 5 ? 1 : maxLen <= 8 ? 2 : 2;
  return levenshtein(x, y) <= maxDist;
}

/**
 * Append corrected terms so keyword search still works on misspellings.
 * @param {string} text
 */
export function normalizeHelpQueryText(text) {
  const raw = String(text || '').toLowerCase();
  const parts = [raw];
  const words = raw.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
  for (const w of words) {
    const fix = HELP_TYPO_MAP[w];
    if (fix && fix !== w) parts.push(fix);
  }
  return parts.join(' ');
}

/**
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function expandHelpTokens(tokens) {
  /** @type {Set<string>} */
  const out = new Set(tokens || []);
  for (const t of tokens || []) {
    const fix = HELP_TYPO_MAP[t];
    if (fix) out.add(fix);
  }
  return [...out];
}

/**
 * @param {string} token
 * @param {string} keywordOrTitleWord
 */
export function tokenMatchesTerm(token, keywordOrTitleWord) {
  const t = String(token || '').toLowerCase();
  const k = String(keywordOrTitleWord || '').toLowerCase();
  if (!t || !k) return false;
  if (k.includes(t) || t.includes(k)) return true;
  return fuzzyWordsSimilar(t, k);
}
