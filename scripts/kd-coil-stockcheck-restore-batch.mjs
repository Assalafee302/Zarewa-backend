#!/usr/bin/env node
/**
 * POST: Reverse 7 Oct 2026 theoretical kg/m stock-check scraps on BR-KD coils
 * where on-hand is below last completed job closing kg by the scrap amount.
 *
 * Does NOT touch end-of-roll tail scraps or physical-count adjustments.
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
Object.assign(process.env, env);
process.env.ZAREWA_MYSQL_PORT = env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const BRANCH = 'BR-KD';
const POST_DATE = '2026-10-10';

/** Coils with same theoretical rate scrap pattern as CL-26-2094 (already restored). */
const TARGETS = [
  {
    coilNo: 'CL-26-2102',
    expectedErp: 1434.5,
    targetKg: 1546,
    scrapMv: 'MV-26-00655',
    reason:
      'Reverse incorrect 7 Oct 2026 stock-check scrap (−111.5 kg @ 2.270 kg/m). Restore to last job closing weight 1,546 kg',
  },
  {
    coilNo: 'CL-KD-APR-1399',
    expectedErp: 474.31,
    targetKg: 575,
    scrapMv: 'MV-26-00654',
    reason:
      'Reverse incorrect 7 Oct 2026 stock-check scrap (−100.69 kg @ 1.319 kg/m). Restore to last job closing weight 575 kg',
  },
  {
    coilNo: 'CL-KD-APR-1997',
    expectedErp: 1594.67,
    targetKg: 1634,
    scrapMv: 'MV-26-00651',
    reason:
      'Reverse residual 7 Oct 2026 stock-check theoretical scrap (−39.33 kg vs last job close). Restore to last job closing weight 1,634 kg',
  },
];

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const { returnCoilMaterialToStock } = await import('../server/writeOps.js');

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const cfg = mysqlConfigFromEnv();
console.log(`[batch] ${databaseLabel(cfg)} branch=${BRANCH} date=${POST_DATE} n=${TARGETS.length}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

const results = [];

try {
  for (const t of TARGETS) {
    const before = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(t.coilNo);
    if (!before) {
      results.push({ coilNo: t.coilNo, ok: false, error: 'not found' });
      continue;
    }
    if (String(before.branch_id || '').trim() !== BRANCH) {
      results.push({ coilNo: t.coilNo, ok: false, error: `branch ${before.branch_id}` });
      continue;
    }

    const erpNow = roundKg3(Math.max(0, Number(before.qty_remaining) || Number(before.current_weight_kg) || 0));
    if (Math.abs(erpNow - t.expectedErp) > 0.05) {
      results.push({
        coilNo: t.coilNo,
        ok: false,
        error: `ERP ${erpNow} ≠ expected ${t.expectedErp}`,
        erpNow,
      });
      continue;
    }

    const restoreKg = roundKg3(t.targetKg - erpNow);
    if (restoreKg <= 0.05) {
      results.push({ coilNo: t.coilNo, ok: false, error: `restoreKg ${restoreKg} not positive`, erpNow });
      continue;
    }

    const already = db
      .prepare(
        `SELECT id FROM stock_movements
         WHERE ref = ? AND type = 'COIL_RETURN' AND detail LIKE ? LIMIT 1`
      )
      .get(t.coilNo, '%Reverse incorrect 7 Oct 2026 stock-check scrap%');
    const already2 = db
      .prepare(
        `SELECT id FROM stock_movements
         WHERE ref = ? AND type = 'COIL_RETURN' AND detail LIKE ? LIMIT 1`
      )
      .get(t.coilNo, '%Reverse residual 7 Oct 2026 stock-check%');
    if (already || already2) {
      results.push({
        coilNo: t.coilNo,
        ok: false,
        error: `already restored (${(already || already2).id})`,
        erpNow,
      });
      continue;
    }

    const r = returnCoilMaterialToStock(
      db,
      {
        coilNo: t.coilNo,
        kg: restoreKg,
        reason: t.reason,
        note: `Undo ${t.scrapMv} · align to job close ${t.targetKg}`,
        dateISO: POST_DATE,
        bookRef: 'Coil stock check reverse 10 Oct 2026',
        controlEventKind: 'adjust_add_kg',
      },
      { workspaceBranchId: BRANCH, actor: null }
    );

    if (!r.ok) {
      results.push({ coilNo: t.coilNo, ok: false, error: r.error, erpNow, restoreKg });
      continue;
    }

    const after = db
      .prepare(`SELECT qty_remaining, current_weight_kg, current_status FROM coil_lots WHERE coil_no = ?`)
      .get(t.coilNo);

    results.push({
      coilNo: t.coilNo,
      ok: true,
      erpBefore: erpNow,
      restoreKg,
      erpAfter: roundKg3(Number(after?.qty_remaining) || 0),
      targetKg: t.targetKg,
      hitTarget: Math.abs(roundKg3(Number(after?.qty_remaining) || 0) - t.targetKg) <= 0.05,
      status: after?.current_status,
      scrapMv: t.scrapMv,
    });
    console.log(`OK ${t.coilNo} ${erpNow} → ${after?.qty_remaining} (+${restoreKg})`);
  }

  const out = {
    ok: results.every((r) => r.ok),
    posted: true,
    postDate: POST_DATE,
    branch: BRANCH,
    results,
  };
  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'KD-coil-stockcheck-restore-batch-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
  if (!out.ok) process.exitCode = 1;
} catch (e) {
  console.error('[batch] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
