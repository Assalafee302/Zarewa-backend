#!/usr/bin/env node
/**
 * READ-ONLY: Preview restoring CL-26-2094 from 2,122.89 → 2,615 kg.
 * Reverses stock-check scrap MV-26-00652 / CCR-KD-26-0038 (−492.11 kg on 2026-10-07)
 * that used theoretical 1.935 kg/m instead of job closing weights (last close = 2,615).
 */
import fs from 'node:fs';
import path from 'node:path';

function commentedMysql(envPath) {
  const map = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[m[1]] = v;
  }
  return map;
}

const env = commentedMysql(path.join(process.cwd(), '.env.local'));
process.env.ZAREWA_MYSQL_HOST = env.ZAREWA_MYSQL_HOST;
process.env.ZAREWA_MYSQL_PORT = env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = env.ZAREWA_MYSQL_USER;
process.env.ZAREWA_MYSQL_PASSWORD = env.ZAREWA_MYSQL_PASSWORD || '';
process.env.ZAREWA_MYSQL_DATABASE = env.ZAREWA_MYSQL_DATABASE;
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);

const COIL_NO = 'CL-26-2094';
const BRANCH = 'BR-KD';
const TARGET_KG = 2615;
const EXPECTED_ERP = 2122.89;
const SCRAP_REF = 'MV-26-00652';

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const cfg = mysqlConfigFromEnv();
console.log(`[preview] READ-ONLY ${databaseLabel(cfg)} coil=${COIL_NO}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const row = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(COIL_NO);
  if (!row) throw new Error('Coil not found');

  const erpNow = roundKg3(Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0));
  const restoreKg = roundKg3(TARGET_KG - erpNow);
  const scrap = db
    .prepare(`SELECT id, type, qty, detail, date_iso FROM stock_movements WHERE id = ?`)
    .get(SCRAP_REF);

  const out = {
    ok: true,
    readOnly: true,
    coilNo: COIL_NO,
    branchId: row.branch_id,
    colour: row.colour,
    gauge: row.gauge_label,
    productId: row.product_id,
    receivedKg: Number(row.qty_received) || Number(row.weight_kg) || 0,
    erpNow,
    expectedErp: EXPECTED_ERP,
    erpMatchesExpected: Math.abs(erpNow - EXPECTED_ERP) <= 0.02,
    targetKg: TARGET_KG,
    restoreKg,
    method: 'returnCoilMaterialToStock → COIL_RETURN (+kg) nets against COIL_SCRAP in book',
    scrapToReverse: scrap || null,
    reason:
      'Reverse incorrect 7 Oct 2026 stock-check scrap (−492.11 kg @ 1.935 kg/m). Restore to last job closing weight 2,615 kg (prod used 749).',
    afterWouldShow: {
      stockKg: TARGET_KG,
      prodUsed: 749,
      incidentScrapNet: 0,
      bookUsed: roundKg3((Number(row.qty_received) || 3364) - TARGET_KG),
    },
  };

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'KD-coil-2094-restore-preview.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[preview] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
