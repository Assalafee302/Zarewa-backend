#!/usr/bin/env node
/**
 * Upserts `coil_lots` from the physical register in the frontend `stockReference.js` (live opening stock, not demo seed).
 *
 * Rules:
 * - Uses the kg register for all `REFERENCE_KG_REGISTER_GROUPS` rows (includes aluzinc 0.28 + 0.24).
 * - Adds thin-register rows only for gauges **0.22, 0.2, 0.18** (same coils are not repeated from the 0.24 thin block).
 * - Reuses `importCoilLotsFromSpreadsheet` so product roll-ups and MySQL upsert behaviour match the app.
 * - Duplicate **C/NO** on the same logical import (e.g. 1577 on 0.24 IV and 0.55 GB) get a disambiguated `coil_no` (`1577+G055` style).
 * - Rows with no C/NO on the sheet get stable synthetic keys `OPENING-UNTAG-<n>`.
 *
 * Prerequisites: schema migrated; catalog products `COIL-ALU` and `PRD-102` exist for the target branch.
 *
 * Usage (production — point `.env` at live MySQL first, stop the API if you want a quiet window):
 *   ZAREWA_CONFIRM_OPENING_COIL_SYNC=1 node scripts/sync-opening-coil-register-mysql.mjs
 *
 * Optional:
 *   ZAREWA_OPENING_STOCK_REF=/absolute/path/to/stockReference.js
 *   ZAREWA_IMPORT_BRANCH_ID=BR-KD   (default from server)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import { mysqlConfigFromEnv, databaseLabel } from '../server/mysqlDatabase.js';
import { importCoilLotsFromSpreadsheet } from '../server/writeOps.js';
import { DEFAULT_BRANCH_ID } from '../server/branches.js';

loadProjectEnv();

if (String(process.env.ZAREWA_CONFIRM_OPENING_COIL_SYNC || '').trim() !== '1') {
  console.error(
    '[zarewa] Refusing: set ZAREWA_CONFIRM_OPENING_COIL_SYNC=1 to upsert opening coil rows into ' +
      databaseLabel(mysqlConfigFromEnv()) +
      '. Take a DB backup first; stop the API if needed.'
  );
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRef = path.resolve(scriptDir, '../../Zarewa-frontend-main/src/Data/stockReference.js');
const refPath = String(process.env.ZAREWA_OPENING_STOCK_REF || '').trim() || defaultRef;

if (!fs.existsSync(refPath)) {
  console.error('[zarewa] stockReference not found:', refPath);
  console.error('Set ZAREWA_OPENING_STOCK_REF to the absolute path of stockReference.js.');
  process.exit(1);
}

const mod = await import(pathToFileURL(refPath).href);
const thinGroups = mod.REFERENCE_THIN_GAUGE_GROUPS;
const kgGroups = mod.REFERENCE_KG_REGISTER_GROUPS;
if (!Array.isArray(thinGroups) || !Array.isArray(kgGroups)) {
  console.error('[zarewa] stockReference.js must export REFERENCE_THIN_GAUGE_GROUPS and REFERENCE_KG_REGISTER_GROUPS.');
  process.exit(1);
}

const NOTE = 'OPENING-PHYSICAL-REGISTER-2026';
const branchId = String(process.env.ZAREWA_IMPORT_BRANCH_ID || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;

function gaugeCore(g) {
  return String(g ?? '')
    .trim()
    .replace(/mm$/i, '')
    .trim();
}

/** @type {Map<string, number>} */
const coilUseCount = new Map();
let untagSeq = 0;

/**
 * @param {string} rawCoilNo
 * @param {string} gauge
 */
function allocateCoilNo(rawCoilNo, gauge) {
  const base = String(rawCoilNo ?? '').trim();
  if (!base) {
    untagSeq += 1;
    return `OPENING-UNTAG-${untagSeq}`;
  }
  const prev = coilUseCount.get(base) ?? 0;
  coilUseCount.set(base, prev + 1);
  if (prev === 0) return base;
  const g = gaugeCore(gauge).replace(/\./g, '');
  if (prev === 1) return `${base}+G${g}`;
  return `${base}+G${g}x${prev}`;
}

/** @returns {Array<Record<string, unknown>>} */
function buildSpreadsheetRows() {
  const rows = [];
  const preferredCores = ['0.28', '0.24'];
  const kgSorted = [
    ...kgGroups.filter((g) => preferredCores.includes(gaugeCore(g.gauge))).sort(
      (a, b) => preferredCores.indexOf(gaugeCore(a.gauge)) - preferredCores.indexOf(gaugeCore(b.gauge))
    ),
    ...kgGroups.filter((g) => !preferredCores.includes(gaugeCore(g.gauge))),
  ];

  for (const g of kgSorted) {
    const gauge = String(g.gauge || '');
    const core = gaugeCore(gauge);
    const isAluz = core === '0.28' || core === '0.24';
    const productID = isAluz ? 'PRD-102' : 'COIL-ALU';
    const materialTypeName = isAluz ? 'Aluzinc (PPGI)' : 'Aluminium';
    for (const r of g.rows || []) {
      const kg = Number(r.kg);
      if (!Number.isFinite(kg) || kg < 0) continue;
      const coilNo = allocateCoilNo(r.coilNo, gauge);
      rows.push({
        coilNo,
        currentKg: kg,
        gaugeLabel: gauge,
        colour: String(r.colour || '').trim() || null,
        productID,
        materialTypeName,
        materialOriginNote: NOTE,
      });
    }
  }

  for (const g of thinGroups) {
    if (gaugeCore(g.gauge) === '0.24') continue;
    const gauge = String(g.gauge || '');
    for (const r of g.rows || []) {
      const qty = Number(r.quantity);
      if (!Number.isFinite(qty) || qty < 0) continue;
      const coilNo = allocateCoilNo(r.coilNo, gauge);
      rows.push({
        coilNo,
        currentKg: qty,
        gaugeLabel: gauge,
        colour: String(r.colour || '').trim() || null,
        productID: 'PRD-102',
        materialTypeName: 'Aluzinc (PPGI)',
        materialOriginNote: NOTE,
      });
    }
  }

  return rows;
}

const spreadsheetRows = buildSpreadsheetRows();
console.log(
  `[zarewa] Prepared ${spreadsheetRows.length} coil row(s) from ${refPath} → ${databaseLabel(mysqlConfigFromEnv())} branch=${branchId}`
);

const db = createDatabase({ seed: false, reset: false });
const result = importCoilLotsFromSpreadsheet(
  db,
  { rows: spreadsheetRows, insertOnly: false },
  branchId,
  null
);

if (!result.ok) {
  console.error('[zarewa] Import failed:', result.error, result.errors);
  process.exit(1);
}

console.log('[zarewa] Upserted coil_lots:', result.imported);
if (result.skipped?.length) console.log('[zarewa] Skipped:', result.skipped);
if (result.errors?.length) console.log('[zarewa] Row errors:', result.errors);
console.log('[zarewa] Reconciled product IDs:', result.reconciledProductIDs);
