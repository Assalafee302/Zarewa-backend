#!/usr/bin/env node
/**
 * Step 2 — Compare Excel sources (docs/import) to SQLite legacy quotation rows.
 *
 *   npm run import:validate
 *   npm run import:validate -- --db data/zarewa-import-staging.sqlite
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAccessImportPlan } from '../server/importAccessSalesPack.mjs';
import { defaultDbPath } from '../server/db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs() {
  let dbPath = process.env.ZAREWA_DB ? path.resolve(process.env.ZAREWA_DB) : defaultDbPath();
  let importDir = path.join(root, 'docs', 'import');
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--db' && process.argv[i + 1]) dbPath = path.resolve(process.argv[++i]);
    if (process.argv[i] === '--dir' && process.argv[i + 1]) importDir = path.resolve(process.argv[++i]);
  }
  return { dbPath, importDir };
}

function legacyFromQt(id) {
  const m = String(id).match(/^QT-LEGACY-(.+)$/);
  return m ? m[1] : '';
}

const { dbPath, importDir } = parseArgs();

if (!fs.existsSync(dbPath)) {
  console.error('Database not found:', dbPath);
  process.exit(1);
}

const plan = buildAccessImportPlan(importDir);
if (plan.missing.length) {
  console.error('Missing Excel files:', plan.missing.join(', '));
  process.exit(1);
}

/** Excel: line total sum per legacy quotation id */
const excelTotalByQ = new Map();
for (const [qid, lines] of plan.linesByQuote) {
  let s = 0;
  for (const l of lines) s += Math.round(Number(l.qty) * Number(l.unitPrice));
  excelTotalByQ.set(qid, s);
}

const excelPaidRaw = plan.paidByQuote;

const db = new Database(dbPath, { readonly: true });
const qtRows = db
  .prepare(`SELECT id, customer_id, total_ngn, paid_ngn FROM quotations WHERE id LIKE 'QT-LEGACY-%'`)
  .all();

const ledgerByQ = new Map();
for (const row of db
  .prepare(
    `SELECT quotation_ref AS q, COALESCE(SUM(amount_ngn),0) AS s FROM ledger_entries WHERE type = 'RECEIPT' AND quotation_ref LIKE 'QT-LEGACY-%' GROUP BY quotation_ref`
  )
  .all()) {
  ledgerByQ.set(row.q, Number(row.s) || 0);
}
db.close();

const sqliteByLegacy = new Map();
for (const row of qtRows) {
  const lq = legacyFromQt(row.id);
  if (lq) sqliteByLegacy.set(lq, row);
}

let mismTotal = 0;
let mismPaid = 0;
let mismLedger = 0;
/** @type {Array<Record<string, unknown>>} */
const samplesTotal = [];
/** @type {Array<Record<string, unknown>>} */
const samplesPaid = [];

for (const [lq, exTotal] of excelTotalByQ) {
  const row = sqliteByLegacy.get(lq);
  if (!row) continue;
  const sx = Number(row.total_ngn) || 0;
  if (exTotal !== sx) {
    mismTotal++;
    if (samplesTotal.length < 20) samplesTotal.push({ legacyQuotationId: lq, excelLineSum: exTotal, sqliteTotalNgn: sx });
  }

  const epRaw = excelPaidRaw.get(lq) || 0;
  const expectedPaid = exTotal > 0 ? Math.min(epRaw, exTotal) : epRaw;
  const sp = Number(row.paid_ngn) || 0;
  if (expectedPaid !== sp) {
    mismPaid++;
    if (samplesPaid.length < 20) {
      samplesPaid.push({
        legacyQuotationId: lq,
        excelReceiptsSum: epRaw,
        expectedPaidStored: expectedPaid,
        sqlitePaidNgn: sp,
      });
    }
  }
}

for (const row of qtRows) {
  const leg = ledgerByQ.get(row.id) || 0;
  const sp = Number(row.paid_ngn) || 0;
  if (leg !== sp) mismLedger++;
}

const excelQuoteIds = new Set([...excelTotalByQ.keys()]);
const sqliteQuoteIds = new Set(sqliteByLegacy.keys());
let onlyExcel = 0;
let onlySqlite = 0;
for (const id of excelQuoteIds) if (!sqliteQuoteIds.has(id)) onlyExcel++;
for (const id of sqliteQuoteIds) if (!excelQuoteIds.has(id)) onlySqlite++;

console.log('Access import validation');
console.log('  DB:', dbPath);
console.log('  import dir:', importDir);
console.log('  Legacy quotations in SQLite:', qtRows.length);
console.log('  Legacy quotations with order lines in Excel:', excelQuoteIds.size);
console.log('  Quotation total_ngn mismatches (Excel line sum vs SQLite):', mismTotal);
console.log('  paid_ngn mismatches (expected from receipts vs SQLite):', mismPaid);
console.log('  Receipts where SUM(ledger) ≠ paid_ngn (and paid > 0):', mismLedger);
console.log('  Order IDs only in Excel (no matching QT-LEGACY row):', onlyExcel);
console.log('  QT-LEGACY rows only in DB (no Excel order bucket):', onlySqlite);

if (samplesTotal.length) {
  console.log('\nSample total mismatches (up to 20):');
  for (const s of samplesTotal) console.log(' ', s);
}
if (samplesPaid.length) {
  console.log('\nSample paid mismatches (up to 20):');
  for (const s of samplesPaid) console.log(' ', s);
}

console.log('\nCutting lists skipped on last import — re-run import to log count, or inspect importAccessSalesPack output.');
console.log('Step 3 — Review: npm run import:merge-report');
