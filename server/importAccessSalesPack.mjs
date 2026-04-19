/**
 * Import Access-exported sales pack from docs/import (Excel):
 *   customers → quotations (+ lines) → receipts (ledger + sales_receipts) → cutting lists → coil stock → production jobs
 *
 * Legacy IDs are prefixed so they do not collide with app-generated IDs:
 *   QT-LEGACY-{n}, CUS-LEGACY-*, CL-LEGACY-{n}, LE-LEGACY-R{n}, PRO-LEGACY-{n}, COIL-LEGACY-*
 *
 * Usage (stop the API if you see SQLITE_BUSY):
 *   node server/importAccessSalesPack.mjs
 *   node server/importAccessSalesPack.mjs --dry-run
 *   set ZAREWA_DB=C:\path\to\zarewa.sqlite && node server/importAccessSalesPack.mjs --dir docs/import
 *
 * Customer merge review (no DB):
 *   node server/importAccessSalesPack.mjs --customer-merge-report
 *   node server/importAccessSalesPack.mjs --customer-merge-report --strict-customer-merge
 *
 * Optional overrides file: docs/import/customer-merge-overrides.json
 *   { "forceOwnCustomerLegacyQuoteIds": ["123"], "sameCustomerAsLegacyQuote": { "456": "100" } }
 *
 * Notes:
 *   - Workspace visibility: bootstrap lists customers/quotations/receipts/ledger by session branch_id.
 *     Importer sets branch_id to --branch (default BR-KAD). If you use another branch in the UI,
 *     run: node scripts/reassign-legacy-import-branch.mjs <BR-XXX>   then refresh the app.
 *   - Finance → Treasury "cash inflows" use treasury_movements (RECEIPT_IN), not ledger rows alone.
 *     After import, run: node scripts/backfill-legacy-receipt-treasury.mjs --treasury-account-id <id>
 *   - Production jobs: after each PRO-LEGACY row, the importer tries to link one coil via
 *     production_job_coils and reduce coil weight (same idea as completion). Explicit Coil / Stock ID
 *     in production reg.xlsx wins; otherwise coils are chosen FIFO by receive date, filtered by
 *     quotation material gauge/colour when present. Re-import skips jobs that already have allocations.
 *   - Stock rows: Supplier text is matched to `suppliers` (same branch) to set supplier_id.
 *   - Does not post GL journals (same as manual SQL); optional --post-gl on treasury backfill.
 *   - Re-imports use UPSERT (ON CONFLICT DO UPDATE) so existing legacy rows are refreshed from Excel,
 *     not skipped after the first run.
 *   - Rows with receipt "Expensis" = true are skipped (not treated as customer sales receipts).
 *   - After import, legacy rows are pruned so nothing references a missing quotation/customer/cutting list
 *     (treasury LEDGER_RECEIPT + GL CUSTOMER_RECEIPT_GL rows tied to removed receipts go too). Use
 *     --no-legacy-link-prune to skip. Dry-run prints Excel-side link gaps; --prune-legacy-links-only
 *     runs only the DB prune on an existing database.
 *   - Requires: "Quotation discription.xlsx", Order.xlsx, Reciept.xlsx, cutting list rec.xlsx,
 *     CUtting.xlsx, Stock.xlsx, production reg.xlsx (names matched case-insensitively).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { SCHEMA_SQL } from './schemaSql.js';
import { runMigrations } from './migrate.js';
import { defaultDbPath } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {
    dryRun: false,
    dir: path.join(ROOT, 'docs', 'import'),
    dbPath: process.env.ZAREWA_DB || defaultDbPath(),
    branchId: DEFAULT_BRANCH_ID,
    customerMergeReport: false,
    customerMergeReportOut: '',
    strictCustomerMerge: false,
    applyMergeOverrides: true,
    legacyLinkPrune: true,
    pruneLegacyLinksOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir' && argv[i + 1]) {
      out.dir = path.resolve(argv[++i]);
    } else if (a === '--db' && argv[i + 1]) {
      out.dbPath = path.resolve(argv[++i]);
    } else if (a === '--branch' && argv[i + 1]) {
      out.branchId = String(argv[++i]).trim();
    } else if (a === '--customer-merge-report') {
      out.customerMergeReport = true;
    } else if (a === '--customer-merge-report-out' && argv[i + 1]) {
      out.customerMergeReportOut = path.resolve(argv[++i]);
    } else if (a === '--strict-customer-merge') {
      out.strictCustomerMerge = true;
    } else if (a === '--no-merge-overrides') {
      out.applyMergeOverrides = false;
    } else if (a === '--no-legacy-link-prune') {
      out.legacyLinkPrune = false;
    } else if (a === '--prune-legacy-links-only') {
      out.pruneLegacyLinksOnly = true;
    }
  }
  return out;
}

function resolveFile(importDir, ...candidates) {
  if (!fs.existsSync(importDir)) return null;
  const list = fs.readdirSync(importDir);
  for (const c of candidates) {
    const hit = list.find((f) => f.toLowerCase() === c.toLowerCase());
    if (hit) return path.join(importDir, hit);
  }
  return null;
}

function readSheet(filePath, preferredSheetSubstr = '') {
  if (!filePath || !fs.existsSync(filePath)) return { rows: [], sheetName: '' };
  const wb = XLSX.readFile(filePath, { cellDates: true, dense: false });
  const sn =
    preferredSheetSubstr && wb.SheetNames.find((s) => s.toLowerCase().includes(preferredSheetSubstr.toLowerCase()))
      ? wb.SheetNames.find((s) => s.toLowerCase().includes(preferredSheetSubstr.toLowerCase()))
      : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '', raw: true });
  return { rows, sheetName: sn };
}

function isoDate(v) {
  if (v instanceof Date && !Number.isNaN(+v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const utc = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(utc);
    if (!Number.isNaN(+d)) return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d2 = new Date(s);
  if (!Number.isNaN(+d2)) return d2.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function atIsoFromDate(v) {
  const day = isoDate(v);
  return `${day}T12:00:00.000Z`;
}

function intMoney(v) {
  const n = Math.round(Number(String(v ?? '').replace(/[₦#,]/g, '').trim()) || 0);
  return Number.isFinite(n) ? n : 0;
}

function floatVal(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function truthy(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === 'yes' || s === '1';
}

function shortDateFromIso(iso) {
  const s = String(iso || '').slice(0, 10);
  const [, m, d] = s.split('-');
  if (!d || !m) return '—';
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return `${d} ${mo}`;
}

function formatMetersLabel(totalMeters) {
  const n = Number(totalMeters) || 0;
  const hasFraction = Math.abs(n - Math.round(n)) > 0.0001;
  return `${n.toLocaleString('en-NG', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} m`;
}

/** Map Bending.xlsx IDs → cutting_list_lines.line_type */
function clampNonNeg(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {string} supplierNameRaw
 * @returns {{ supplierId: string | null, supplierName: string | null }}
 */
function resolveSupplierForStockImport(db, branchId, supplierNameRaw) {
  const raw = String(supplierNameRaw ?? '').trim();
  if (!raw) return { supplierId: null, supplierName: null };
  const bid = String(branchId || '').trim();
  let row = db
    .prepare(
      `SELECT supplier_id, name FROM suppliers WHERE branch_id = ? AND (LOWER(TRIM(name)) = LOWER(TRIM(?)) OR supplier_id = ?)`
    )
    .get(bid, raw, raw);
  if (!row) {
    row = db
      .prepare(
        `SELECT supplier_id, name FROM suppliers WHERE branch_id = ? AND (
          INSTR(LOWER(name), LOWER(TRIM(?))) > 0 OR INSTR(LOWER(?), LOWER(name)) > 0
        ) ORDER BY LENGTH(name) ASC LIMIT 1`
      )
      .get(bid, raw, raw);
  }
  if (!row) return { supplierId: null, supplierName: raw };
  return { supplierId: row.supplier_id, supplierName: row.name };
}

/** @param {import('better-sqlite3').Database} db */
function gaugeColourHintsFromQuotation(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return { gauge: '', colour: '' };
  const q = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(qid);
  if (!q?.lines_json) return { gauge: '', colour: '' };
  try {
    const j = JSON.parse(q.lines_json);
    return {
      gauge: String(j.materialGauge ?? j.gauge ?? '').trim(),
      colour: String(j.materialColor ?? j.materialColour ?? j.color ?? '').trim(),
    };
  } catch {
    return { gauge: '', colour: '' };
  }
}

function normMatToken(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');
}

function coilMatchesQuotationMaterial(coil, gaugeHint, colourHint) {
  if (!gaugeHint && !colourHint) return true;
  const cg = normMatToken(coil.gauge_label);
  const cc = normMatToken(coil.colour);
  const hg = normMatToken(gaugeHint);
  const hc = normMatToken(colourHint);
  let ok = true;
  if (hg && cg && !cg.includes(hg) && !hg.includes(cg)) ok = false;
  if (hc && cc) {
    const cShort = (cc.split('.')[0] || cc).slice(0, 12);
    const hShort = (hc.split('.')[0] || hc).slice(0, 12);
    if (!cShort.includes(hShort) && !hShort.includes(cShort)) ok = false;
  }
  return ok;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function recomputeLegacyCoilDerived(db, coilNo) {
  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!row) return;
  const qtyRemaining = clampNonNeg(row.qty_remaining ?? row.current_weight_kg ?? row.weight_kg ?? 0);
  const qtyReserved = Math.max(0, Math.min(qtyRemaining, clampNonNeg(row.qty_reserved)));
  const currentStatus =
    qtyRemaining <= 0.0001 ? 'Consumed' : qtyReserved >= qtyRemaining - 0.0001 && qtyReserved > 0 ? 'Reserved' : 'Available';
  db.prepare(
    `UPDATE coil_lots SET qty_remaining = ?, qty_reserved = ?, current_weight_kg = ?, current_status = ? WHERE coil_no = ?`
  ).run(qtyRemaining, qtyReserved, qtyRemaining, currentStatus, coilNo);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, number>} simRemain
 */
function pickLegacyCoilNo(db, branchId, quotationRef, jobDateIso, kgNeeded, row, legacyStockIdToCoilNo, simRemain) {
  const explicit = String(
    row.Coil ?? row.coil ?? row.CoilNO ?? row['Coil NO'] ?? row.StockID ?? row['Stock ID'] ?? row.StockId ?? ''
  ).trim();
  if (explicit) {
    if (legacyStockIdToCoilNo.has(explicit)) return legacyStockIdToCoilNo.get(explicit);
    const up = explicit.toUpperCase();
    if (up.startsWith('COIL-')) return explicit;
    return `COIL-LEGACY-${explicit}`;
  }
  const kg = Number(kgNeeded) || 0;
  if (kg <= 0) return null;
  const hints = gaugeColourHintsFromQuotation(db, quotationRef);
  const jobDay = String(jobDateIso || '').slice(0, 10) || '9999-12-31';
  const coils = db
    .prepare(
      `SELECT * FROM coil_lots
       WHERE branch_id = ?
       AND coil_no LIKE 'COIL-LEGACY-%'
       AND (substr(COALESCE(received_at_iso,''),1,10) <= ? OR TRIM(COALESCE(received_at_iso,'')) = '')
       ORDER BY received_at_iso ASC, coil_no ASC`
    )
    .all(branchId, jobDay);
  const ranked = coils.filter((c) => coilMatchesQuotationMaterial(c, hints.gauge, hints.colour));
  const pool = ranked.length ? ranked : coils;

  const remFor = (c) =>
    simRemain.has(c.coil_no)
      ? simRemain.get(c.coil_no)
      : clampNonNeg(c.qty_remaining ?? c.current_weight_kg ?? c.weight_kg ?? 0);

  for (const c of pool) {
    if (remFor(c) >= kg - 0.001) return c.coil_no;
  }
  for (const c of pool) {
    if (remFor(c) > 0.0001) return c.coil_no;
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ jobId: string, coilNo: string, consumedRaw: number, meters: number, completedAtIso: string, simRemain: Map<string, number> }} ctx
 */
function applyLegacyProductionCoilLink(db, ctx) {
  const { jobId, coilNo, consumedRaw, meters, completedAtIso, simRemain } = ctx;
  if (!coilNo || !jobId) return { linked: false };
  if (db.prepare(`SELECT 1 FROM production_job_coils WHERE job_id = ?`).get(jobId)) return { linked: false };
  const coil = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(coilNo);
  if (!coil) return { linked: false };

  const avail = simRemain.has(coilNo)
    ? simRemain.get(coilNo)
    : clampNonNeg(coil.qty_remaining ?? coil.current_weight_kg ?? coil.weight_kg ?? 0);
  const consumed = Math.min(Math.max(0, consumedRaw), avail);
  if (consumed <= 0) return { linked: false };

  const opening = consumed;
  const closing = 0;
  const m = Number(meters) || 0;
  const conv = m > 0 && consumed > 0 ? consumed / m : null;
  const pjcId = `PJC-LIMP-${String(jobId).replace(/[^a-z0-9-]/gi, '')}-${String(coilNo).replace(/[^a-z0-9-]/gi, '').slice(-20)}`;
  const atIso = String(completedAtIso || '').includes('T') ? String(completedAtIso) : `${String(completedAtIso).slice(0, 10)}T12:00:00.000Z`;

  db.prepare(
    `INSERT INTO production_job_coils (
      id, job_id, sequence_no, coil_no, product_id, colour, gauge_label,
      opening_weight_kg, closing_weight_kg, consumed_weight_kg, meters_produced, actual_conversion_kg_per_m,
      allocation_status, note, allocated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    pjcId,
    jobId,
    1,
    coilNo,
    coil.product_id || 'PRD-LEGACY-COIL',
    coil.colour,
    coil.gauge_label,
    opening,
    closing,
    consumed,
    m,
    conv,
    'Completed',
    'Legacy import (auto-linked)',
    atIso
  );

  const qr = Math.max(0, avail - consumed);
  const qres = Math.max(0, (Number(coil.qty_reserved) || 0) - opening);
  db.prepare(`UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ?, qty_reserved = ? WHERE coil_no = ?`).run(
    qr,
    qr,
    qres,
    coilNo
  );
  recomputeLegacyCoilDerived(db, coilNo);

  const uc = Math.round(Number(coil.unit_cost_ngn_per_kg) || 0);
  const cogs = uc > 0 ? Math.round(consumed * uc) : null;
  const prevLanded = Math.round(Number(coil.landed_cost_ngn) || 0);
  const nextLanded = cogs != null && prevLanded > 0 ? Math.max(0, prevLanded - cogs) : coil.landed_cost_ngn;
  if (cogs != null && prevLanded > 0) {
    db.prepare(`UPDATE coil_lots SET landed_cost_ngn = ? WHERE coil_no = ?`).run(nextLanded, coilNo);
  }

  const mvId = `MV-LIMP-${String(jobId).replace(/[^a-z0-9-]/gi, '').slice(0, 36)}`;
  db.prepare(
    `INSERT OR IGNORE INTO stock_movements (id, at_iso, type, ref, product_id, qty, detail, date_iso, unit_price_ngn, value_ngn)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    mvId,
    atIso,
    'COIL_CONSUMPTION',
    jobId,
    coil.product_id || 'PRD-LEGACY-COIL',
    -consumed,
    `${coilNo} consumed for ${m.toFixed(2)} m on ${jobId} (import)`,
    atIso.slice(0, 10),
    uc || null,
    cogs
  );

  const prodId = coil.product_id || 'PRD-LEGACY-COIL';
  const p = db.prepare(`SELECT stock_level FROM products WHERE product_id = ?`).get(prodId);
  if (p) {
    const next = Math.max(0, Number(p.stock_level) - consumed);
    db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(next, prodId);
  }

  simRemain.set(coilNo, qr);
  return { linked: true };
}

function bendingToLineType(bendingId) {
  const n = Number(bendingId);
  const m = {
    1: 'Flatsheet',
    2: 'Roof',
    3: 'Roof',
    4: 'Cladding',
    5: 'Roof',
    6: 'Roof',
  };
  return m[n] || 'Roof';
}

function digitsPhone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d || d === '0') return '';
  return d;
}

/**
 * Normalize person/company text for fuzzy matching (order of words ignored).
 */
function normalizeNameForMatch(raw) {
  let s = String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase().replace(/[.,'"()\-_/]/g, ' ');
  s = s.replace(
    /\b(mr|mrs|ms|dr|eng|engr|engr\.|alh|alhaji|alhaja|chief|arc|mall\.|mallam|mal|bar|prof|sir|bro|sis)\b\.?/gi,
    ' '
  );
  s = s.replace(/\s+/g, ' ').trim();
  const parts = s.split(' ').filter((w) => w.length > 0).sort();
  return parts.join(' ');
}

/** Dropped when matching “brand” tokens so “Mamia Oil” / “Chairman Mamai” / “Mamai Oil Seed Co” collapse together. */
const MERGE_STOPWORDS = new Set([
  'and',
  '&',
  'the',
  'of',
  'vice',
  'chairman',
  'president',
  'ceo',
  'md',
  'director',
  'managing',
  'executive',
  'secretary',
  'treasurer',
  'company',
  'companies',
  'ltd',
  'limited',
  'plc',
  'nig',
  'nigeria',
  'enterprise',
  'enterprises',
  'ventures',
  'venture',
  'trading',
  'services',
  'service',
  'group',
  'investment',
  'investments',
  'international',
  'global',
  'holdings',
  'holding',
  'inc',
  'corp',
  'corporation',
  'associate',
  'associates',
  'partners',
  'partner',
  'oil',
  'oilseed',
  'oilseeds',
  'seed',
  'seeds',
  'mills',
  'mill',
  'agro',
  'agriculture',
  'agricultural',
  'farms',
  'farm',
  'foods',
  'food',
  'products',
  'product',
  'store',
  'stores',
  'shop',
  'shops',
  'industries',
  'industry',
  'construction',
  'properties',
  'property',
  'resources',
  'solutions',
  'logistics',
  'transport',
  'general',
  'merchants',
  'merchant',
  'supplies',
  'supply',
  'materials',
  'engineering',
  'works',
  'work',
  'steel',
  'steels',
  'iron',
  'metals',
  'metal',
  'aluminium',
  'aluminum',
  'cement',
  'blocks',
  'block',
  'pipes',
  'pipe',
  'sand',
  'gravel',
  'woods',
  'wood',
]);

/**
 * Substantive tokens left after removing generic business words (sorted norm → split).
 * @param {string} norm
 */
function coreTokensForMerge(norm) {
  if (!norm || norm.startsWith('__fallback_')) return [];
  return norm
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !MERGE_STOPWORDS.has(t));
}

/**
 * Fuzzy equality on a single token (brand / person name). Short tokens: exact only.
 * @param {boolean} strictMerge
 */
function mergeTokenFuzzyMatch(ta, tb, strictMerge) {
  if (ta === tb) return true;
  const mi = Math.min(ta.length, tb.length);
  const mx = Math.max(ta.length, tb.length);
  if (mi < 4 || mx < 5) return false;
  const maxDist = strictMerge ? 1 : mi >= 5 ? 2 : 1;
  return levenshteinBounded(ta, tb, maxDist) <= maxDist;
}

/**
 * True if any core token on one side fuzzy-matches any on the other (cross first/second name).
 * Needs a “strong” token (length ≥ 5) on each side so we do not chain-merge unrelated one-word rows.
 * @param {boolean} strictMerge
 */
function coreTokensOverlapMerge(normA, normB, strictMerge) {
  const a = coreTokensForMerge(normA).filter((t) => t.length >= 4);
  const b = coreTokensForMerge(normB).filter((t) => t.length >= 4);
  if (a.length === 0 || b.length === 0) return false;
  const strongA = a.filter((t) => t.length >= 5);
  const strongB = b.filter((t) => t.length >= 5);
  if (strongA.length === 0 || strongB.length === 0) return false;
  for (const ta of strongA) {
    for (const tb of strongB) {
      if (mergeTokenFuzzyMatch(ta, tb, strictMerge)) return true;
    }
  }
  return false;
}

/** Levenshtein distance; returns max+1 early if row min exceeds max. */
function levenshteinBounded(a, b, max) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  /** @type {number[]} */
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    /** @type {number[]} */
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    prev = cur;
    if (rowMin > max) return max + 1;
  }
  return prev[lb];
}

/**
 * True if two normalized names likely refer to the same person (typos, extra surname, word order).
 * @param {boolean} strict — tighter Levenshtein (no distance-3 merges; distance 2 only for longer names).
 */
function namesFuzzyMatch(normA, normB, strict = false) {
  if (!normA || !normB) return normA === normB;
  if (normA === normB) return true;
  const [s, l] = normA.length <= normB.length ? [normA, normB] : [normB, normA];
  if (s.length < 3) return false;
  if (l.startsWith(`${s} `) || l === s) return true;
  const minLen = Math.min(normA.length, normB.length);
  let maxDist = 1;
  if (strict) {
    if (minLen >= 10) maxDist = 2;
  } else {
    if (minLen >= 5) maxDist = 2;
  }
  if (minLen <= 4) maxDist = 1;
  return levenshteinBounded(normA, normB, maxDist) <= maxDist;
}

class UnionFind {
  /** @param {number} n */
  constructor(n) {
    /** @type {number[]} */
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  /** @param {number} i */
  find(i) {
    if (this.p[i] !== i) this.p[i] = this.find(this.p[i]);
    return this.p[i];
  }
  /**
   * @param {number} a
   * @param {number} b
   */
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

/**
 * @param {Array<Record<string, unknown>>} quotes
 * @param {(row: Record<string, unknown>) => string} legacyQIdFn
 * @param {boolean} strictMerge
 * @returns {{ quoteToCustomer: Map<string, string>, customers: Map<string, { customer_id: string, name: string, phone: string, company: string }> }}
 */
function buildCustomerMergeMaps(quotes, legacyQIdFn, strictMerge = false) {
  /** @type {Array<{ legacyQId: string, display: string, norm: string, phone: string, companyHint: string }>} */
  const recs = [];
  for (const row of quotes) {
    const lq = legacyQIdFn(row);
    if (!lq) continue;
    const nameRaw = String(row.Name ?? row.name ?? '').trim();
    const custRaw = String(row.Customer ?? row.customer ?? '').trim();
    const display = nameRaw || custRaw || `Customer (quote ${lq})`;
    const phone = digitsPhone(row['Phone number'] ?? row.Phone ?? row.phone);
    let companyHint = '';
    if (custRaw && custRaw !== nameRaw && nameRaw) companyHint = custRaw;
    else if (custRaw && !nameRaw) companyHint = '';
    const norm = normalizeNameForMatch(display);
    recs.push({ legacyQId: lq, display, norm: norm || `__fallback_${lq}`, phone, companyHint });
  }

  const n = recs.length;
  const uf = new UnionFind(n);

  const MIN_PHONE_LEN = 10;
  const phoneToFirst = new Map();
  for (let i = 0; i < n; i++) {
    const ph = recs[i].phone;
    if (!ph || ph.length < MIN_PHONE_LEN) continue;
    if (phoneToFirst.has(ph)) uf.union(i, phoneToFirst.get(ph));
    else phoneToFirst.set(ph, i);
  }

  const buckets = new Map();
  const addBucket = (key, idx) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  };

  for (let i = 0; i < n; i++) {
    const nm = recs[i].norm;
    if (nm.startsWith('__fallback_')) {
      addBucket(`_fb:${recs[i].legacyQId}`, i);
      continue;
    }
    if (nm.length < 3) {
      addBucket(`_s:${nm}`, i);
      continue;
    }
    const pre = nm.slice(0, 3);
    for (const delta of [-4, -3, -2, -1, 0, 1, 2, 3]) {
      const L = nm.length + delta;
      if (L >= 3) addBucket(`${pre}:${L}`, i);
    }
  }

  for (const arr of buckets.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = arr[a];
        const j = arr[b];
        if (namesFuzzyMatch(recs[i].norm, recs[j].norm, strictMerge)) uf.union(i, j);
      }
    }
  }

  /**
   * One bucket per row = longest “strong” core token only (reduces giant transitive chains vs multi-prefix).
   * Name buckets: 3-char prefix × length class with deltas [-4..+3] (asymmetric +4 dropped → ~600 on sample export).
   * Token fuzzy: non-strict Levenshtein maxDist 2 when min token length ≥ 5.
   */
  if (!strictMerge) {
    const anchorBuckets = new Map();
    const addAnchor = (key, idx) => {
      if (!anchorBuckets.has(key)) anchorBuckets.set(key, []);
      anchorBuckets.get(key).push(idx);
    };
    for (let i = 0; i < n; i++) {
      const strong = coreTokensForMerge(recs[i].norm).filter((t) => t.length >= 5);
      if (strong.length === 0) continue;
      const longest = strong.reduce((a, b) => (b.length > a.length ? b : a), strong[0]);
      const key = longest.slice(0, 3);
      addAnchor(key, i);
    }
    for (const arr of anchorBuckets.values()) {
      for (let a = 0; a < arr.length; a++) {
        for (let b = a + 1; b < arr.length; b++) {
          const i = arr[a];
          const j = arr[b];
          if (coreTokensOverlapMerge(recs[i].norm, recs[j].norm, false)) uf.union(i, j);
        }
      }
    }
  }

  /** @type {Map<number, { legacyQIds: string[], displays: string[], phones: string[], companies: string[] }>} */
  const comp = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!comp.has(r)) comp.set(r, { legacyQIds: [], displays: [], phones: [], companies: [] });
    const c = comp.get(r);
    c.legacyQIds.push(recs[i].legacyQId);
    c.displays.push(recs[i].display);
    if (recs[i].phone) c.phones.push(recs[i].phone);
    if (recs[i].companyHint) c.companies.push(recs[i].companyHint);
  }

  /** @type {Map<string, string>} */
  const quoteToCustomer = new Map();
  /** @type {Map<string, { customer_id: string, name: string, phone: string, company: string }>} */
  const customers = new Map();

  for (const { legacyQIds, displays, phones, companies } of comp.values()) {
    legacyQIds.sort((a, b) => Number(a) - Number(b));
    const sig = legacyQIds.join('|');
    const h = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 14);
    const customerId = `CUS-LEGACY-${h}`;
    const name = displays.reduce((best, cur) => (cur.length > best.length ? cur : best), displays[0] || 'Customer');
    const phone = phones.sort((a, b) => b.length - a.length)[0] || '';
    const company = companies.reduce((best, cur) => (cur.length > best.length ? cur : best), companies[0] || '');
    for (const lq of legacyQIds) quoteToCustomer.set(lq, customerId);
    customers.set(customerId, { customer_id: customerId, name, phone, company });
  }

  return { quoteToCustomer, customers };
}

/**
 * Optional JSON in import dir: customer-merge-overrides.json
 * @param {Map<string, string>} quoteToCustomer
 * @param {Map<string, { customer_id: string, name: string, phone: string, company: string }>} customers
 */
function applyCustomerMergeOverrides(quoteToCustomer, customers, quotes, legacyQIdFn, importDir) {
  const p = path.join(importDir, 'customer-merge-overrides.json');
  if (!fs.existsSync(p)) return;
  let o;
  try {
    o = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.warn('Could not parse customer-merge-overrides.json — ignoring.');
    return;
  }
  const displayByLq = new Map();
  for (const row of quotes) {
    const lq = legacyQIdFn(row);
    if (!lq) continue;
    const nameRaw = String(row.Name ?? '').trim();
    const custRaw = String(row.Customer ?? '').trim();
    displayByLq.set(lq, nameRaw || custRaw || `Customer (quote ${lq})`);
  }
  for (const id of o.forceOwnCustomerLegacyQuoteIds || []) {
    const lq = String(id).trim();
    if (!lq) continue;
    const cid = `CUS-LEGACY-SOLO-${lq}`;
    quoteToCustomer.set(lq, cid);
    const name = displayByLq.get(lq) || `Customer (quote ${lq})`;
    customers.set(cid, { customer_id: cid, name, phone: '', company: '' });
  }
  for (const [from, to] of Object.entries(o.sameCustomerAsLegacyQuote || {})) {
    const fl = String(from).trim();
    const tl = String(to).trim();
    if (!fl || !tl) continue;
    const targetCid = quoteToCustomer.get(tl);
    if (targetCid) quoteToCustomer.set(fl, targetCid);
  }
}

function csvEscapeCell(s) {
  const t = String(s ?? '').replace(/"/g, '""');
  if (/[",\r\n]/.test(t)) return `"${t}"`;
  return t;
}

/**
 * Rows where one customer cluster has more than one distinct display spelling (review false merges).
 * @param {boolean} allClusters — if true, emit every cluster (large file)
 */
function writeCustomerMergeReport(quotes, quoteToCustomer, legacyQIdFn, outPath, allClusters = false) {
  /** @type {Map<string, { lqs: string[], displays: Set<string> }>} */
  const byC = new Map();
  for (const row of quotes) {
    const lq = legacyQIdFn(row);
    if (!lq) continue;
    const cid = quoteToCustomer.get(lq);
    if (!cid) continue;
    const nameRaw = String(row.Name ?? '').trim();
    const custRaw = String(row.Customer ?? '').trim();
    const display = nameRaw || custRaw || `Customer (quote ${lq})`;
    if (!byC.has(cid)) byC.set(cid, { lqs: [], displays: new Set() });
    const o = byC.get(cid);
    o.lqs.push(lq);
    o.displays.add(display);
  }
  const lines = ['customer_id,quote_count,distinct_display_count,displays,legacy_quote_ids'];
  let ambiguous = 0;
  for (const [cid, o] of byC) {
    const dc = o.displays.size;
    const qc = o.lqs.length;
    if (!allClusters && dc <= 1) continue;
    ambiguous += 1;
    const displays = [...o.displays].join(' | ');
    const lqs = [...new Set(o.lqs)].sort((a, b) => Number(a) - Number(b)).join(' ');
    lines.push(
      [csvEscapeCell(cid), qc, dc, csvEscapeCell(displays), csvEscapeCell(lqs)].join(',')
    );
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `\uFEFF${lines.join('\r\n')}`, 'utf8');
  return { clustersInReport: ambiguous, totalClusters: byC.size };
}

function legacyReceiptQuoteId(row) {
  return String(row.QuatationId ?? row.QuotationId ?? row['Quatation ID'] ?? '').trim();
}

/** Legacy production.xlsx cutting-list id column (typo `cuttiingID` in some exports). */
function productionCuttingListLegacyId(row) {
  return String(row.cuttiingID ?? row.cuttingID ?? row.CuttingListID ?? '').trim();
}

function qtId(legacy) {
  return `QT-LEGACY-${legacy}`;
}

function clId(legacy) {
  return `CL-LEGACY-${legacy}`;
}

function sumQuotationLinesJson(linesJson) {
  let s = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = linesJson[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const q = Number(String(row?.qty ?? '').replace(/,/g, ''));
      const p = Math.round(Number(String(row?.unitPrice ?? '').replace(/,/g, '')) || 0);
      if (Number.isFinite(q) && Number.isFinite(p)) s += Math.round(q * p);
    }
  }
  return s;
}

function syncQuotationLineRows(db, quotationId, linesJson) {
  db.prepare(`DELETE FROM quotation_lines WHERE quotation_id = ?`).run(quotationId);
  const ins = db.prepare(`
    INSERT INTO quotation_lines (id, quotation_id, sort_order, category, name, qty, unit, unit_price_ngn, line_total_ngn)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  let order = 0;
  for (const cat of ['products', 'accessories', 'services']) {
    const arr = linesJson?.[cat];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const name = String(row?.name ?? '').trim();
      if (!name) continue;
      order += 1;
      const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
      const unitPrice = Math.round(Number(String(row?.unitPrice ?? '').replace(/,/g, '')) || 0);
      const lineTotal = Math.round(qty * unitPrice);
      ins.run(`${quotationId}-L${order}`, quotationId, order, cat, name, qty, 'ea', unitPrice, lineTotal);
    }
  }
}

function openDb(dbPath, dryRun) {
  if (dryRun) return null;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function ensureLegacyCoilProduct(db, branchId) {
  const exists = db.prepare(`SELECT 1 FROM products WHERE product_id = ?`).get('PRD-LEGACY-COIL');
  if (exists) return;
  db.prepare(
    `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run('PRD-LEGACY-COIL', 'Imported coil stock (legacy)', 0, 'kg', 0, 0, '', '', '', '{}', branchId);
}

/**
 * @param {string} importDir
 * @param {{ applyMergeOverrides?: boolean, strictCustomerMerge?: boolean }} [opts]
 */
export function buildAccessImportPlan(importDir, opts = {}) {
  const applyMergeOverrides = opts.applyMergeOverrides !== false;
  const strictCustomerMerge = Boolean(opts.strictCustomerMerge);
  const qPath = resolveFile(importDir, 'Quotation discription.xlsx', 'Quotation description.xlsx');
  const orderPath = resolveFile(importDir, 'Order.xlsx');
  const recPath = resolveFile(importDir, 'Reciept.xlsx', 'Receipt.xlsx');
  const clRecPath = resolveFile(importDir, 'cutting list rec.xlsx');
  const cuttingPath = resolveFile(importDir, 'CUtting.xlsx', 'Cutting.xlsx');
  const stockPath = resolveFile(importDir, 'Stock.xlsx');
  const prodPath = resolveFile(importDir, 'production reg.xlsx');

  const quotes = readSheet(qPath, 'quotation').rows;
  const orders = readSheet(orderPath, 'order').rows;
  const receipts = readSheet(recPath, 'reciept').rows;
  const clHeaders = readSheet(clRecPath, 'cutting').rows;
  const cutLines = readSheet(cuttingPath, 'cutting').rows;
  const stockRows = readSheet(stockPath, 'stock').rows;
  const prodRows = readSheet(prodPath, 'production').rows;

  const missing = [];
  if (!qPath) missing.push('Quotation discription.xlsx');
  if (!orderPath) missing.push('Order.xlsx');
  if (!recPath) missing.push('Reciept.xlsx');
  if (!clRecPath) missing.push('cutting list rec.xlsx');
  if (!cuttingPath) missing.push('CUtting.xlsx');
  if (!stockPath) missing.push('Stock.xlsx');
  if (!prodPath) missing.push('production reg.xlsx');

  const legacyQId = (row) => String(row.QuationID ?? row.QuotationID ?? row['Quation ID'] ?? '').trim();
  const orderQId = (row) => String(row.QuatationId ?? row.QuotationId ?? row['Quatation ID'] ?? '').trim();

  let { quoteToCustomer, customers } = buildCustomerMergeMaps(quotes, legacyQId, strictCustomerMerge);
  if (applyMergeOverrides) {
    applyCustomerMergeOverrides(quoteToCustomer, customers, quotes, legacyQId, importDir);
  }

  /** @type {Map<string, Array<{ name: string, qty: number, unitPrice: number }>>} */
  const linesByQuote = new Map();
  for (const row of orders) {
    const qid = orderQId(row);
    if (!qid) continue;
    const name = String(row.product ?? row.Product ?? '').trim() || 'Line item';
    const qty = floatVal(row['Quantity/Meters'] ?? row.Quantity ?? row.qty);
    const unitPrice = intMoney(row.UnitPrice ?? row.unitPrice);
    if (!linesByQuote.has(qid)) linesByQuote.set(qid, []);
    linesByQuote.get(qid).push({ name, qty, unitPrice });
  }

  /** @type {Map<string, number>} */
  const paidByQuote = new Map();
  const receiptRows = [];
  for (const row of receipts) {
    if (truthy(row.Expensis)) continue;
    const qid = legacyReceiptQuoteId(row);
    if (!qid) continue;
    const amt = intMoney(row.AmountPaid ?? row.amountPaid);
    if (amt <= 0) continue;
    paidByQuote.set(qid, (paidByQuote.get(qid) || 0) + amt);
    receiptRows.push(row);
  }

  /** @type {Map<string, { lines: Array<{ sheets: number, lengthM: number, totalM: number, lineType: string }>, totalMeters: number, sheets: number }>} */
  const cuttingByListId = new Map();
  for (const row of cutLines) {
    const clid = String(row.CuttingListID ?? row.cuttingListID ?? '').trim();
    if (!clid) continue;
    const sheets = floatVal(row.Quantity);
    const lengthM = floatVal(row.Lenght ?? row.Length);
    const totalM = floatVal(row.Meter);
    const lineType = bendingToLineType(row.Bending);
    if (!cuttingByListId.has(clid)) cuttingByListId.set(clid, { lines: [], totalMeters: 0, sheets: 0 });
    const b = cuttingByListId.get(clid);
    if (sheets > 0 && lengthM > 0) {
      b.lines.push({ sheets, lengthM, totalM: totalM > 0 ? totalM : Number((sheets * lengthM).toFixed(2)), lineType });
      b.sheets += sheets;
    }
    b.totalMeters += totalM > 0 ? totalM : sheets > 0 && lengthM > 0 ? sheets * lengthM : 0;
  }

  /** @type {Map<string, string>} legacy receipt id -> legacy quotation id */
  const quoteByReceiptId = new Map();
  for (const row of receipts) {
    const rid = String(row.RecieptID ?? row.ReceiptID ?? '').trim();
    const qid = legacyReceiptQuoteId(row);
    if (rid && qid) quoteByReceiptId.set(rid, qid);
  }

  const cuttingRecords = [];
  for (const row of clHeaders) {
    const clLegacy = String(row.cuttinglistID ?? row.cuttingListID ?? '').trim();
    if (!clLegacy) continue;
    const recId = String(row.RecieptId ?? row.ReceiptId ?? '').trim();
    const qFromRec = recId ? quoteByReceiptId.get(recId) : '';
    const dateIso = isoDate(row.date ?? row.Date);
    const headerMeters = floatVal(row.totalMeters);
    const pack = cuttingByListId.get(clLegacy) || { lines: [], totalMeters: 0, sheets: 0 };
    const totalMeters = pack.totalMeters > 0 ? pack.totalMeters : headerMeters;
    cuttingRecords.push({ clLegacy, recId, qFromRec, dateIso, totalMeters, sheetsToCut: pack.sheets, lines: pack.lines });
  }

  const quoteIds = new Set();
  for (const row of quotes) {
    const lq = legacyQId(row);
    if (lq) quoteIds.add(lq);
  }

  let orderRowsMissingQuotation = 0;
  for (const row of orders) {
    const qid = orderQId(row);
    if (qid && !quoteIds.has(qid)) orderRowsMissingQuotation += 1;
  }

  let receiptsMissingQuotation = 0;
  for (const row of receiptRows) {
    const qid = legacyReceiptQuoteId(row);
    if (qid && !quoteIds.has(qid)) receiptsMissingQuotation += 1;
  }

  let cuttingListsMissingQuoteLink = 0;
  const clLegacyThatWillImport = new Set();
  for (const rec of cuttingRecords) {
    if (!rec.qFromRec || !quoteIds.has(rec.qFromRec)) {
      cuttingListsMissingQuoteLink += 1;
      continue;
    }
    const goodLines = rec.lines.filter((l) => l.sheets > 0 && l.lengthM > 0);
    if (!goodLines.length) cuttingListsMissingQuoteLink += 1;
    else clLegacyThatWillImport.add(rec.clLegacy);
  }

  let productionMissingCuttingList = 0;
  for (const row of prodRows) {
    const prodLegacy = String(row.ProductionID ?? row.productionID ?? '').trim();
    const clLegacy = productionCuttingListLegacyId(row);
    if (!prodLegacy || !clLegacy) {
      productionMissingCuttingList += 1;
      continue;
    }
    if (!clLegacyThatWillImport.has(clLegacy)) productionMissingCuttingList += 1;
  }

  return {
    missing,
    paths: { qPath, orderPath, recPath, clRecPath, cuttingPath, stockPath, prodPath },
    counts: {
      quotes: quotes.filter((r) => legacyQId(r)).length,
      orders: orders.length,
      receipts: receiptRows.length,
      cuttingLists: cuttingRecords.length,
      cuttingLines: cutLines.length,
      stock: stockRows.length,
      production: prodRows.length,
      customers: customers.size,
    },
    linkGaps: {
      orderRowsMissingQuotation,
      receiptsMissingQuotation,
      cuttingListsMissingQuoteLink,
      productionMissingCuttingList,
    },
    quotes,
    quoteToCustomer,
    customers,
    linesByQuote,
    paidByQuote,
    receiptRows,
    cuttingRecords,
    stockRows,
    prodRows,
    legacyQId,
    receiptLegacyId: (row) => String(row.RecieptID ?? row.ReceiptID ?? '').trim(),
  };
}

function runImport(db, plan, branchId) {
  const {
    quotes,
    quoteToCustomer,
    customers,
    linesByQuote,
    paidByQuote,
    receiptRows,
    cuttingRecords,
    stockRows,
    prodRows,
    legacyQId,
    receiptLegacyId,
  } = plan;

  ensureLegacyCoilProduct(db, branchId);

  const nowIso = new Date().toISOString();
  const insCust = db.prepare(`
    INSERT INTO customers (
      customer_id, name, phone_number, email, address_shipping, address_billing,
      status, tier, payment_terms, created_by, created_at_iso, last_activity_iso,
      company_name, lead_source, preferred_contact, follow_up_iso, crm_tags_json, crm_profile_notes, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(customer_id) DO UPDATE SET
      name = excluded.name,
      phone_number = excluded.phone_number,
      email = excluded.email,
      address_shipping = excluded.address_shipping,
      address_billing = excluded.address_billing,
      status = excluded.status,
      tier = excluded.tier,
      payment_terms = excluded.payment_terms,
      last_activity_iso = excluded.last_activity_iso,
      company_name = excluded.company_name,
      lead_source = excluded.lead_source,
      preferred_contact = excluded.preferred_contact,
      follow_up_iso = excluded.follow_up_iso,
      crm_tags_json = excluded.crm_tags_json,
      crm_profile_notes = excluded.crm_profile_notes,
      branch_id = excluded.branch_id,
      created_at_iso = customers.created_at_iso,
      created_by = customers.created_by
  `);
  for (const c of customers.values()) {
    insCust.run(
      c.customer_id,
      c.name,
      c.phone || null,
      null,
      null,
      null,
      'Active',
      'Standard',
      '',
      'import',
      nowIso,
      nowIso,
      c.company || null,
      '',
      '',
      null,
      '[]',
      '',
      branchId
    );
  }

  const insQ = db.prepare(`
    INSERT INTO quotations (
      id, customer_id, customer_name, date_label, date_iso, due_date_iso,
      total_display, total_ngn, paid_ngn, payment_status, status, approval_date, customer_feedback, handled_by,
      project_name, lines_json, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      date_label = excluded.date_label,
      date_iso = excluded.date_iso,
      due_date_iso = excluded.due_date_iso,
      total_display = excluded.total_display,
      total_ngn = excluded.total_ngn,
      paid_ngn = excluded.paid_ngn,
      payment_status = excluded.payment_status,
      status = excluded.status,
      approval_date = excluded.approval_date,
      customer_feedback = excluded.customer_feedback,
      handled_by = excluded.handled_by,
      project_name = excluded.project_name,
      lines_json = excluded.lines_json,
      branch_id = excluded.branch_id
  `);

  for (const row of quotes) {
    const lq = legacyQId(row);
    if (!lq) continue;
    const qid = qtId(lq);
    const customerId = quoteToCustomer.get(lq);
    const cust = customers.get(customerId);
    if (!cust) continue;

    const lines = linesByQuote.get(lq) || [];
    const linesJson = {
      products: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
      accessories: [],
      services: [],
    };
    if (row.Guage ?? row.guage) linesJson.materialGauge = String(row.Guage ?? row.guage).trim();
    if (row.color ?? row.colour) linesJson.materialColor = String(row.color ?? row.colour).trim();
    if (row.Design ?? row.design) linesJson.materialDesign = String(row.Design ?? row.design).trim();

    let totalNgn = sumQuotationLinesJson(linesJson);
    const sumValue = lines.reduce((s, l) => s + Math.round(l.qty * l.unitPrice), 0);
    if (totalNgn <= 0 && sumValue > 0) totalNgn = sumValue;

    const rawPaid = paidByQuote.get(lq) || 0;
    let paymentStatus = 'Unpaid';
    if (totalNgn > 0) {
      if (rawPaid >= totalNgn) paymentStatus = 'Paid';
      else if (rawPaid > 0) paymentStatus = 'Partial';
    } else if (rawPaid > 0) paymentStatus = 'Partial';

    const paidStored = totalNgn > 0 ? Math.min(rawPaid, totalNgn) : rawPaid;

    const dateIso = isoDate(row.Date ?? row.date);
    const linesStr = JSON.stringify(linesJson);
    insQ.run(
      qid,
      cust.customer_id,
      cust.name,
      shortDateFromIso(dateIso),
      dateIso,
      '',
      `₦${totalNgn.toLocaleString('en-NG')}`,
      totalNgn,
      paidStored,
      paymentStatus,
      'Imported',
      '',
      '',
      String(row.GeneratedBy ?? '').trim() || 'Import',
      null,
      linesStr,
      branchId
    );
    syncQuotationLineRows(db, qid, linesJson);
  }

  const insLedger = db.prepare(`
    INSERT INTO ledger_entries (
      id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref,
      payment_method, bank_reference, purpose, created_by_user_id, created_by_name, note, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      at_iso = excluded.at_iso,
      type = excluded.type,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      amount_ngn = excluded.amount_ngn,
      quotation_ref = excluded.quotation_ref,
      payment_method = excluded.payment_method,
      bank_reference = excluded.bank_reference,
      purpose = excluded.purpose,
      created_by_user_id = excluded.created_by_user_id,
      created_by_name = excluded.created_by_name,
      note = excluded.note,
      branch_id = excluded.branch_id
  `);
  const insSr = db.prepare(`
    INSERT INTO sales_receipts (
      id, customer_id, customer_name, quotation_ref, date_label, date_iso, amount_display, amount_ngn, method, status, handled_by, ledger_entry_id, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      quotation_ref = excluded.quotation_ref,
      date_label = excluded.date_label,
      date_iso = excluded.date_iso,
      amount_display = excluded.amount_display,
      amount_ngn = excluded.amount_ngn,
      method = excluded.method,
      status = excluded.status,
      handled_by = excluded.handled_by,
      ledger_entry_id = excluded.ledger_entry_id,
      branch_id = excluded.branch_id
  `);

  for (const row of receiptRows) {
    const lq = legacyReceiptQuoteId(row);
    if (!lq) continue;
    const qid = qtId(lq);
    const qrow = db.prepare(`SELECT id, customer_id, customer_name, branch_id FROM quotations WHERE id = ?`).get(qid);
    if (!qrow) continue;
    const rid = receiptLegacyId(row);
    if (!rid) continue;
    const leId = `LE-LEGACY-R${rid}`;
    const amt = intMoney(row.AmountPaid);
    if (amt <= 0) continue;
    const atIso = atIsoFromDate(row.Date ?? row.date);
    const method = String(row.method ?? row.Method ?? '—').trim() || '—';
    const custId = qrow.customer_id;
    const custName = qrow.customer_name;
    insLedger.run(
      leId,
      atIso,
      'RECEIPT',
      custId,
      custName,
      amt,
      qid,
      method,
      '',
      'Legacy import',
      null,
      'Import',
      String(row.Remark ?? row.Discription ?? '').trim() || 'Legacy receipt',
      branchId
    );
    insSr.run(
      leId,
      custId,
      custName,
      qid,
      shortDateFromIso(atIso),
      atIso.slice(0, 10),
      `₦${amt.toLocaleString('en-NG')}`,
      amt,
      method,
      'Posted',
      String(row.Payee ?? '').trim() || '—',
      leId,
      branchId
    );
  }

  const insCl = db.prepare(`
    INSERT INTO cutting_lists (
      id, customer_id, customer_name, quotation_ref, product_id, product_name, date_label, date_iso,
      sheets_to_cut, total_meters, total_label, status, machine_name, operator_name,
      production_registered, production_register_ref, handled_by, branch_id,
      production_release_pending, production_released_at_iso, production_released_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      quotation_ref = excluded.quotation_ref,
      product_id = excluded.product_id,
      product_name = excluded.product_name,
      date_label = excluded.date_label,
      date_iso = excluded.date_iso,
      sheets_to_cut = excluded.sheets_to_cut,
      total_meters = excluded.total_meters,
      total_label = excluded.total_label,
      handled_by = excluded.handled_by,
      branch_id = excluded.branch_id,
      status = cutting_lists.status,
      machine_name = cutting_lists.machine_name,
      operator_name = cutting_lists.operator_name,
      production_registered = cutting_lists.production_registered,
      production_register_ref = cutting_lists.production_register_ref,
      production_release_pending = cutting_lists.production_release_pending,
      production_released_at_iso = cutting_lists.production_released_at_iso,
      production_released_by = cutting_lists.production_released_by
  `);
  const insCll = db.prepare(`
    INSERT OR REPLACE INTO cutting_list_lines (cutting_list_id, sort_order, sheets, length_m, total_m, line_type)
    VALUES (?,?,?,?,?,?)
  `);

  let cuttingSkipped = 0;
  for (const rec of cuttingRecords) {
    const lq = rec.qFromRec;
    if (!lq) {
      cuttingSkipped += 1;
      continue;
    }
    const qid = qtId(lq);
    const qrow = db.prepare(`SELECT customer_id, customer_name FROM quotations WHERE id = ?`).get(qid);
    if (!qrow) {
      cuttingSkipped += 1;
      continue;
    }
    const cid = clId(rec.clLegacy);
    const lines = rec.lines.filter((l) => l.sheets > 0 && l.lengthM > 0);
    if (!lines.length) {
      cuttingSkipped += 1;
      continue;
    }
    const sheetsToCut = lines.reduce((s, l) => s + l.sheets, 0);
    const totalMeters = lines.reduce((s, l) => s + l.totalM, 0) || rec.totalMeters;
    insCl.run(
      cid,
      qrow.customer_id,
      qrow.customer_name,
      qid,
      null,
      null,
      shortDateFromIso(rec.dateIso),
      rec.dateIso,
      sheetsToCut,
      totalMeters,
      formatMetersLabel(totalMeters),
      'Waiting',
      null,
      null,
      0,
      '',
      'Import',
      branchId,
      0,
      null,
      null
    );
    db.prepare(`DELETE FROM cutting_list_lines WHERE cutting_list_id = ?`).run(cid);
    let ord = 0;
    for (const l of lines) {
      ord += 1;
      insCll.run(cid, ord, l.sheets, l.lengthM, l.totalM, l.lineType);
    }
  }

  const insCoil = db.prepare(`
    INSERT INTO coil_lots (
      coil_no, product_id, line_key, qty_received, weight_kg, colour, gauge_label, material_type_name,
      supplier_expected_meters, supplier_conversion_kg_per_m, qty_remaining, qty_reserved, current_weight_kg,
      current_status, location, po_id, supplier_id, supplier_name, received_at_iso, parent_coil_no,
      material_origin_note, landed_cost_ngn, unit_cost_ngn_per_kg, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(coil_no) DO UPDATE SET
      product_id = excluded.product_id,
      line_key = excluded.line_key,
      qty_received = excluded.qty_received,
      weight_kg = excluded.weight_kg,
      colour = excluded.colour,
      gauge_label = excluded.gauge_label,
      material_type_name = excluded.material_type_name,
      supplier_expected_meters = excluded.supplier_expected_meters,
      supplier_conversion_kg_per_m = excluded.supplier_conversion_kg_per_m,
      qty_remaining = excluded.qty_remaining,
      qty_reserved = excluded.qty_reserved,
      current_weight_kg = excluded.current_weight_kg,
      current_status = excluded.current_status,
      location = excluded.location,
      po_id = excluded.po_id,
      supplier_id = excluded.supplier_id,
      supplier_name = excluded.supplier_name,
      received_at_iso = excluded.received_at_iso,
      parent_coil_no = excluded.parent_coil_no,
      material_origin_note = excluded.material_origin_note,
      landed_cost_ngn = excluded.landed_cost_ngn,
      unit_cost_ngn_per_kg = excluded.unit_cost_ngn_per_kg,
      branch_id = excluded.branch_id
  `);

  /** @type {Map<string, string>} */
  const legacyStockIdToCoilNo = new Map();
  for (const row of stockRows) {
    const sid = String(row.ID ?? row.id ?? '').trim();
    if (!sid) continue;
    const coilNoRaw = String(row['Coil NO'] ?? row.CoilNO ?? row.coil_no ?? '').trim();
    const coilNo = coilNoRaw ? `COIL-LEGACY-${coilNoRaw}` : `COIL-LEGACY-S${sid}`;
    legacyStockIdToCoilNo.set(sid, coilNo);
    const kg = floatVal(row.KG ?? row.kg);
    const gauge = String(row.Guage ?? row.Gauge ?? '').trim();
    const colour = String(row.Colour ?? row.Color ?? '').trim();
    const supplierNameRaw =
      String(row.Supplier ?? row.supplier ?? row.CompanyName ?? row.Vendor ?? '').trim() || null;
    const { supplierId, supplierName: supplierNameResolved } = resolveSupplierForStockImport(
      db,
      branchId,
      supplierNameRaw || ''
    );
    const recvIso = isoDate(row['Purchase date'] ?? row.purchaseDate);
    const cost = intMoney(row.Cost ?? row.cost);
    insCoil.run(
      coilNo,
      'PRD-LEGACY-COIL',
      null,
      kg || 0,
      kg || 0,
      colour || null,
      gauge || null,
      null,
      null,
      null,
      kg || 0,
      0,
      kg || 0,
      'Available',
      null,
      null,
      supplierId,
      supplierNameResolved || supplierNameRaw,
      `${recvIso}T12:00:00.000Z`,
      null,
      'Access / Excel import',
      cost || null,
      null,
      branchId
    );
  }

  const insJob = db.prepare(`
    INSERT INTO production_jobs (
      job_id, cutting_list_id, quotation_ref, customer_id, customer_name, product_id, product_name,
      planned_meters, planned_sheets, machine_name, operator_name, start_date_iso, end_date_iso, materials_note,
      status, created_at_iso, completed_at_iso, actual_meters, actual_weight_kg,
      conversion_alert_state, manager_review_required, branch_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      cutting_list_id = excluded.cutting_list_id,
      quotation_ref = excluded.quotation_ref,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      product_id = excluded.product_id,
      product_name = excluded.product_name,
      planned_meters = excluded.planned_meters,
      planned_sheets = excluded.planned_sheets,
      machine_name = excluded.machine_name,
      operator_name = excluded.operator_name,
      start_date_iso = excluded.start_date_iso,
      end_date_iso = excluded.end_date_iso,
      materials_note = excluded.materials_note,
      status = excluded.status,
      created_at_iso = excluded.created_at_iso,
      completed_at_iso = excluded.completed_at_iso,
      actual_meters = excluded.actual_meters,
      actual_weight_kg = excluded.actual_weight_kg,
      conversion_alert_state = excluded.conversion_alert_state,
      manager_review_required = excluded.manager_review_required,
      branch_id = excluded.branch_id,
      manager_review_signed_at_iso = production_jobs.manager_review_signed_at_iso,
      manager_review_signed_by_user_id = production_jobs.manager_review_signed_by_user_id,
      manager_review_signed_by_name = production_jobs.manager_review_signed_by_name,
      manager_review_remark = production_jobs.manager_review_remark
  `);

  /** Simulated kg remaining per coil when linking many jobs in one import (chronological). */
  /** @type {Map<string, number>} */
  const simCoilRemain = new Map();
  const sortedProd = [...prodRows].sort((a, b) => {
    const da = isoDate(a.Date ?? a.date);
    const db2 = isoDate(b.Date ?? b.date);
    if (da < db2) return -1;
    if (da > db2) return 1;
    return 0;
  });
  for (const row of sortedProd) {
    const prodLegacy = String(row.ProductionID ?? row.productionID ?? '').trim();
    const clLegacy = productionCuttingListLegacyId(row);
    if (!prodLegacy || !clLegacy) continue;
    const clid = clId(clLegacy);
    const clRow = db.prepare(`SELECT * FROM cutting_lists WHERE id = ?`).get(clid);
    if (!clRow) continue;
    const jobId = `PRO-LEGACY-${prodLegacy}`;
    const meters = floatVal(row.meters ?? row.Meters);
    const kg = floatVal(row['KG used'] ?? row.kgUsed ?? row.KG);
    const dateIso = isoDate(row.Date ?? row.date);
    insJob.run(
      jobId,
      clid,
      clRow.quotation_ref,
      clRow.customer_id,
      clRow.customer_name,
      clRow.product_id,
      clRow.product_name,
      meters || clRow.total_meters || 0,
      clRow.sheets_to_cut || 0,
      'Legacy import',
      (() => {
        const r = row['OP Remark'] ?? row.opRemark;
        if (typeof r === 'string' && r.trim()) return r.trim();
        const op = row.OP;
        if (typeof op === 'string' && op.trim() && op.toLowerCase() !== 'false') return op.trim();
        return null;
      })(),
      dateIso,
      dateIso,
      String(row.Remarks ?? '').trim() || null,
      'Completed',
      `${dateIso}T12:00:00.000Z`,
      `${dateIso}T12:00:00.000Z`,
      meters,
      kg,
      'OK',
      0,
      branchId
    );
    db.prepare(
      `UPDATE cutting_lists SET production_registered = 1, production_register_ref = ?, status = ? WHERE id = ?`
    ).run(jobId, 'Waiting', clid);

    const coilNo = pickLegacyCoilNo(
      db,
      branchId,
      clRow.quotation_ref,
      dateIso,
      kg,
      row,
      legacyStockIdToCoilNo,
      simCoilRemain
    );
    if (coilNo && kg > 0) {
      applyLegacyProductionCoilLink(db, {
        jobId,
        coilNo,
        consumedRaw: kg,
        meters,
        completedAtIso: dateIso,
        simRemain: simCoilRemain,
      });
    }
  }

  return { cuttingSkipped };
}

/**
 * Remove or fix legacy import rows whose links are broken (missing quotation, customer, or cutting list).
 * Safe for mixed DBs: only deletes rows whose ids match legacy prefixes (QT/CL/LE/PRO-LEGACY-*).
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   fixedProductionJobRefs: number,
 *   removed: {
 *     glJournalEntries: number,
 *     treasuryMovements: number,
 *     productionJobs: number,
 *     cuttingLists: number,
 *     salesReceipts: number,
 *     ledgerEntries: number,
 *     customerRefunds: number,
 *     quotations: number,
 *     orphanQuotationLines: number,
 *   },
 * }}
 */
export function pruneLegacySalesLinkOrphans(db) {
  const removed = {
    glJournalEntries: 0,
    treasuryMovements: 0,
    productionJobs: 0,
    cuttingLists: 0,
    salesReceipts: 0,
    ledgerEntries: 0,
    customerRefunds: 0,
    quotations: 0,
    orphanQuotationLines: 0,
  };

  const fixJobs = db
    .prepare(
      `UPDATE production_jobs SET quotation_ref = (
         SELECT c.quotation_ref FROM cutting_lists c WHERE c.id = production_jobs.cutting_list_id
       )
       WHERE job_id LIKE 'PRO-LEGACY-%'
       AND cutting_list_id IN (SELECT id FROM cutting_lists)
       AND EXISTS (
         SELECT 1 FROM cutting_lists c
         WHERE c.id = production_jobs.cutting_list_id
         AND c.quotation_ref IS NOT NULL
         AND TRIM(c.quotation_ref) != ''
         AND c.quotation_ref != production_jobs.quotation_ref
       )`
    )
    .run();
  const fixedProductionJobRefs = fixJobs.changes;

  const delOrphanLines = db
    .prepare(
      `DELETE FROM quotation_lines
       WHERE quotation_id LIKE 'QT-LEGACY-%'
       AND quotation_id NOT IN (SELECT id FROM quotations)`
    )
    .run();
  removed.orphanQuotationLines = delOrphanLines.changes;

  const delPro = db
    .prepare(
      `DELETE FROM production_jobs
       WHERE job_id LIKE 'PRO-LEGACY-%'
       AND (
         cutting_list_id IS NULL
         OR cutting_list_id NOT IN (SELECT id FROM cutting_lists)
         OR quotation_ref IS NULL
         OR TRIM(quotation_ref) = ''
         OR quotation_ref NOT IN (SELECT id FROM quotations)
         OR NOT EXISTS (
           SELECT 1 FROM cutting_lists c
           WHERE c.id = production_jobs.cutting_list_id AND c.quotation_ref = production_jobs.quotation_ref
         )
       )`
    )
    .run();
  removed.productionJobs = delPro.changes;

  const delCl = db
    .prepare(
      `DELETE FROM cutting_lists
       WHERE id LIKE 'CL-LEGACY-%'
       AND (
         quotation_ref IS NULL
         OR TRIM(quotation_ref) = ''
         OR quotation_ref NOT IN (SELECT id FROM quotations)
         OR customer_id NOT IN (SELECT customer_id FROM customers)
       )`
    )
    .run();
  removed.cuttingLists = delCl.changes;

  const badLegacyLedgerIds = db
    .prepare(
      `SELECT id FROM ledger_entries
       WHERE id LIKE 'LE-LEGACY-%'
       AND type = 'RECEIPT'
       AND (
         quotation_ref IS NULL
         OR TRIM(quotation_ref) = ''
         OR quotation_ref NOT IN (SELECT id FROM quotations)
         OR customer_id NOT IN (SELECT customer_id FROM customers)
       )`
    )
    .all()
    .map((r) => r.id);

  const danglingSrLedgerIds = db
    .prepare(
      `SELECT DISTINCT ledger_entry_id AS id FROM sales_receipts
       WHERE id LIKE 'LE-LEGACY-%'
       AND ledger_entry_id IS NOT NULL
       AND ledger_entry_id NOT IN (SELECT id FROM ledger_entries)`
    )
    .all()
    .map((r) => r.id)
    .filter(Boolean);

  const srOrphanIds = db
    .prepare(
      `SELECT id FROM sales_receipts
       WHERE id LIKE 'LE-LEGACY-%'
       AND (
         quotation_ref IS NULL
         OR TRIM(quotation_ref) = ''
         OR quotation_ref NOT IN (SELECT id FROM quotations)
         OR customer_id NOT IN (SELECT customer_id FROM customers)
         OR ledger_entry_id IS NULL
         OR ledger_entry_id NOT IN (SELECT id FROM ledger_entries)
       )`
    )
    .all()
    .map((r) => r.id);

  const ledgerIdsToStrip = new Set([...badLegacyLedgerIds, ...danglingSrLedgerIds, ...srOrphanIds]);

  if (ledgerIdsToStrip.size > 0) {
    const placeholders = Array.from(ledgerIdsToStrip, () => '?').join(',');
    removed.glJournalEntries = db
      .prepare(
        `DELETE FROM gl_journal_entries
         WHERE source_kind = 'CUSTOMER_RECEIPT_GL' AND source_id IN (${placeholders})`
      )
      .run(...ledgerIdsToStrip).changes;
    removed.treasuryMovements = db
      .prepare(
        `DELETE FROM treasury_movements
         WHERE source_kind = 'LEDGER_RECEIPT' AND source_id IN (${placeholders})`
      )
      .run(...ledgerIdsToStrip).changes;
    removed.salesReceipts = db
      .prepare(`DELETE FROM sales_receipts WHERE id IN (${placeholders}) OR ledger_entry_id IN (${placeholders})`)
      .run(...ledgerIdsToStrip, ...ledgerIdsToStrip).changes;
    removed.ledgerEntries = db
      .prepare(`DELETE FROM ledger_entries WHERE id IN (${placeholders})`)
      .run(...ledgerIdsToStrip).changes;
  }

  const badQuotations = db
    .prepare(
      `SELECT id FROM quotations
       WHERE id LIKE 'QT-LEGACY-%'
       AND customer_id NOT IN (SELECT customer_id FROM customers)`
    )
    .all()
    .map((r) => r.id);

  if (badQuotations.length > 0) {
    const ph = badQuotations.map(() => '?').join(',');
    removed.customerRefunds = db
      .prepare(`DELETE FROM customer_refunds WHERE quotation_ref IN (${ph})`)
      .run(...badQuotations).changes;
    removed.glJournalEntries += db
      .prepare(
        `DELETE FROM gl_journal_entries
         WHERE source_kind = 'CUSTOMER_RECEIPT_GL'
         AND source_id IN (SELECT id FROM ledger_entries WHERE quotation_ref IN (${ph}))`
      )
      .run(...badQuotations).changes;
    removed.treasuryMovements += db
      .prepare(
        `DELETE FROM treasury_movements
         WHERE source_kind = 'LEDGER_RECEIPT'
         AND source_id IN (SELECT id FROM ledger_entries WHERE quotation_ref IN (${ph}))`
      )
      .run(...badQuotations).changes;
    removed.salesReceipts += db
      .prepare(`DELETE FROM sales_receipts WHERE quotation_ref IN (${ph})`)
      .run(...badQuotations).changes;
    removed.ledgerEntries += db
      .prepare(`DELETE FROM ledger_entries WHERE quotation_ref IN (${ph})`)
      .run(...badQuotations).changes;
    removed.productionJobs += db
      .prepare(`DELETE FROM production_jobs WHERE quotation_ref IN (${ph}) AND job_id LIKE 'PRO-LEGACY-%'`)
      .run(...badQuotations).changes;
    removed.cuttingLists += db
      .prepare(`DELETE FROM cutting_lists WHERE quotation_ref IN (${ph}) AND id LIKE 'CL-LEGACY-%'`)
      .run(...badQuotations).changes;
    removed.quotations = db.prepare(`DELETE FROM quotations WHERE id IN (${ph})`).run(...badQuotations).changes;
  }

  return { fixedProductionJobRefs, removed };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.pruneLegacyLinksOnly) {
    if (!fs.existsSync(path.dirname(args.dbPath))) {
      console.error('Database directory missing:', path.dirname(args.dbPath));
      process.exit(1);
    }
    if (!fs.existsSync(args.dbPath)) {
      console.error('Database not found:', args.dbPath);
      process.exit(1);
    }
    const db = openDb(args.dbPath, false);
    if (!db) {
      console.error('Failed to open database');
      process.exit(1);
    }
    try {
      const r = db.transaction(() => pruneLegacySalesLinkOrphans(db))();
      console.log('Legacy link prune only');
      console.log('  DB:', args.dbPath);
      console.log('  Fixed production_jobs quotation_ref (from cutting list):', r.fixedProductionJobRefs);
      console.log('  Removed:', r.removed);
    } finally {
      db.close();
    }
    process.exit(0);
  }

  if (args.customerMergeReport) {
    const plan = buildAccessImportPlan(args.dir, {
      applyMergeOverrides: args.applyMergeOverrides,
      strictCustomerMerge: args.strictCustomerMerge,
    });
    if (plan.missing.length) {
      console.error('Missing required files in', args.dir);
      for (const m of plan.missing) console.error('  -', m);
      process.exit(1);
    }
    const out =
      args.customerMergeReportOut ||
      path.join(ROOT, 'scripts', 'output', 'customer-merge-review.csv');
    const r = writeCustomerMergeReport(plan.quotes, plan.quoteToCustomer, plan.legacyQId, out, false);
    console.log('Customer merge review (distinct spellings per cluster)');
    console.log('  total customer clusters:', r.totalClusters);
    console.log('  clusters with 2+ distinct display spellings:', r.clustersInReport);
    console.log('  wrote:', out);
    console.log('  Tip: use --strict-customer-merge on import to merge fewer names;');
    console.log('       add docs/import/customer-merge-overrides.json to split or join quotes.');
    process.exit(0);
  }

  const plan = buildAccessImportPlan(args.dir, {
    applyMergeOverrides: args.applyMergeOverrides,
    strictCustomerMerge: args.strictCustomerMerge,
  });
  if (plan.missing.length) {
    console.error('Missing required files in', args.dir);
    for (const m of plan.missing) console.error('  -', m);
    process.exit(1);
  }

  console.log('Access / Excel import plan');
  console.log('  customers:', plan.counts.customers);
  console.log('  quotations:', plan.counts.quotes);
  console.log('  order lines (rows):', plan.counts.orders);
  console.log('  sales receipts:', plan.counts.receipts);
  console.log('  cutting list headers:', plan.counts.cuttingLists);
  console.log('  cutting detail rows:', plan.counts.cuttingLines);
  console.log('  stock (coil) rows:', plan.counts.stock);
  console.log('  production rows:', plan.counts.production);
  console.log('  DB:', args.dbPath);
  console.log('  branch:', args.branchId);
  console.log('  dryRun:', args.dryRun);
  const lg = plan.linkGaps;
  console.log('\nExcel link checks (rows that do not join to a quotation id in the quotation sheet):');
  console.log('  order lines (Order.xlsx) missing quotation:', lg.orderRowsMissingQuotation);
  console.log('  receipts missing quotation:', lg.receiptsMissingQuotation);
  console.log('  cutting list headers skipped / not importable (no receipt→quote or no valid cut lines):', lg.cuttingListsMissingQuoteLink);
  console.log('  production rows with no importable cutting list:', lg.productionMissingCuttingList);

  if (args.dryRun) {
    console.log('\nDry run only — no writes.');
    process.exit(0);
  }

  if (!fs.existsSync(path.dirname(args.dbPath))) {
    fs.mkdirSync(path.dirname(args.dbPath), { recursive: true });
  }

  const db = openDb(args.dbPath, false);
  if (!db) {
    console.error('Failed to open database');
    process.exit(1);
  }

  try {
    const meta = db.transaction(() => {
      const m = runImport(db, plan, args.branchId);
      let prune = null;
      if (args.legacyLinkPrune) prune = pruneLegacySalesLinkOrphans(db);
      return { ...m, prune };
    })();
    console.log('\nImport finished.');
    if (meta.cuttingSkipped) console.log('  Cutting lists skipped (no receipt→quote link or no valid lines):', meta.cuttingSkipped);
    if (meta.prune) {
      console.log('\nLegacy link prune (orphan / broken references removed):');
      console.log('  Fixed production_jobs quotation_ref:', meta.prune.fixedProductionJobRefs);
      console.log('  Removed:', meta.prune.removed);
    }
  } finally {
    db.close();
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry && import.meta.url === entry) {
  main();
}
