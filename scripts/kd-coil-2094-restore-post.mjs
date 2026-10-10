#!/usr/bin/env node
/**
 * POST: Restore CL-26-2094 BR-KD 2,122.89 → 2,615 kg (+492.11 COIL_RETURN).
 * Reverses stock-check scrap MV-26-00652 / CCR-KD-26-0038 (theoretical 1.935 kg/m).
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

const COIL_NO = 'CL-26-2094';
const BRANCH = 'BR-KD';
const TARGET_KG = 2615;
const EXPECTED_ERP = 2122.89;
const POST_DATE = '2026-10-10';
const REASON =
  'Reverse incorrect 7 Oct 2026 stock-check scrap (−492.11 kg @ 1.935 kg/m). Restore to last job closing weight 2,615 kg';
const NOTE = 'Undo MV-26-00652 / CCR-KD-26-0038 · jobs booked ~1.18 kg/m · prod used 749';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const { returnCoilMaterialToStock } = await import('../server/writeOps.js');

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const cfg = mysqlConfigFromEnv();
console.log(`[post] ${databaseLabel(cfg)} coil=${COIL_NO} date=${POST_DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const before = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(COIL_NO);
  if (!before) throw new Error(`Coil ${COIL_NO} not found.`);
  if (String(before.branch_id || '').trim() !== BRANCH) {
    throw new Error(`Coil is on ${before.branch_id}, expected ${BRANCH}.`);
  }

  const erpNow = roundKg3(Math.max(0, Number(before.qty_remaining) || Number(before.current_weight_kg) || 0));
  if (Math.abs(erpNow - EXPECTED_ERP) > 0.05) {
    throw new Error(`Abort: live ERP ${erpNow} ≠ expected ${EXPECTED_ERP}. Re-preview.`);
  }

  const restoreKg = roundKg3(TARGET_KG - erpNow);
  if (Math.abs(restoreKg - 492.11) > 0.05) {
    throw new Error(`Abort: restore ${restoreKg} ≠ 492.11. Re-preview.`);
  }

  const already = db
    .prepare(
      `SELECT id, qty, detail, date_iso FROM stock_movements
       WHERE ref = ? AND type = 'COIL_RETURN' AND detail LIKE ? LIMIT 5`
    )
    .all(COIL_NO, '%Reverse incorrect 7 Oct 2026 stock-check scrap%');
  if (already.length) {
    throw new Error(`Abort: restore already posted (${already.map((r) => r.id).join(', ')}).`);
  }

  // actor null → audit_log.actor_user_id NULL (FK-safe); name falls back to "System"
  const r = returnCoilMaterialToStock(
    db,
    {
      coilNo: COIL_NO,
      kg: restoreKg,
      reason: REASON,
      note: NOTE,
      dateISO: POST_DATE,
      bookRef: 'Coil stock check reverse 10 Oct 2026',
      controlEventKind: 'adjust_add_kg',
    },
    { workspaceBranchId: BRANCH, actor: null }
  );

  if (!r.ok) throw new Error(r.error || 'returnCoilMaterialToStock failed');

  const after = db
    .prepare(`SELECT qty_remaining, current_weight_kg, current_status, qty_reserved FROM coil_lots WHERE coil_no = ?`)
    .get(COIL_NO);

  const out = {
    ok: true,
    posted: true,
    coilNo: COIL_NO,
    postDate: POST_DATE,
    erpBefore: erpNow,
    restoreKg,
    erpAfter: roundKg3(Number(after?.qty_remaining) || 0),
    currentWeightKg: roundKg3(Number(after?.current_weight_kg) || 0),
    status: after?.current_status,
    reserved: roundKg3(Number(after?.qty_reserved) || 0),
    targetKg: TARGET_KG,
    hitTarget: Math.abs(roundKg3(Number(after?.qty_remaining) || 0) - TARGET_KG) <= 0.05,
    apiResult: r,
    reason: REASON,
  };

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'KD-coil-2094-restore-post-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[post] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
