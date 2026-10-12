#!/usr/bin/env node
/**
 * READ-ONLY: BR-KD opening-reset preview via previewOpeningStockReset (no writes).
 * Uses commented ZAREWA_MYSQL_* from .env.local (Hostinger).
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
// Allow connecting to prod schema for this explicit ops script.
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const { previewOpeningStockReset } = await import('../server/operations/openingStockResetOps.js');

const cfg = mysqlConfigFromEnv();
console.log(`[preview] READ-ONLY ${databaseLabel(cfg)} branch=BR-KD`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const prev = previewOpeningStockReset(db, 'BR-KD');
  if (!prev.ok) {
    console.error(prev);
    process.exit(1);
  }

  const postable = prev.lines.filter(
    (l) => l.adjustment != null && Math.abs(l.adjustment) > 1e-9 && !l.ambiguous
  );

  console.log('\n=== Summary ===');
  console.log(JSON.stringify({ ...prev.summary, previewHash: prev.previewHash, postableCount: postable.length }, null, 2));

  console.log('\n=== Excluded accessories (already reset) ===');
  console.table(prev.excludedAccessories);

  console.log('\n=== Accessories to post ===');
  console.table(
    prev.lines
      .filter((l) => l.group === 'accessory')
      .map((l) => ({
        productId: l.productId,
        erpNow: l.erpNow,
        target: l.target,
        adjustment: l.adjustment,
        unitCostNgn: l.unitCostNgn,
        reason: l.reason,
      }))
  );

  console.log('\n=== Flatsheet (non-zero adj or counted) ===');
  console.table(
    prev.lines
      .filter((l) => l.group === 'stone_flatsheet' && (l.target > 0 || Math.abs(l.adjustment || 0) > 1e-9))
      .map((l) => ({
        productId: l.productId,
        unit: l.unit,
        erpNow: l.erpNow,
        target: l.target,
        adjustment: l.adjustment,
        role: l.role,
      }))
  );

  console.log('\n=== Stone metres COUNTED (0.20 mm) ===');
  console.table(
    prev.lines
      .filter((l) => l.group === 'stone_metre' && l.role === 'primary')
      .map((l) => ({
        productId: l.productId,
        erpNow: l.erpNow,
        target: l.target,
        adjustment: l.adjustment,
        unitCostNgn: l.unitCostNgn,
      }))
  );

  console.log('\n=== Other stone metres → 0 (incl. Single) — full list ===');
  console.table(
    (prev.zeroOtherMetre || []).map((z) => ({
      productId: z.productId,
      erpNow: z.erpNow,
      target: z.target,
      adjustment: z.adjustment,
      isSingle: z.isSingle ? 'Y' : '',
    }))
  );

  const out = path.resolve('exports', 'kd-opening-reset-preview.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(prev, null, 2));
  console.log(`\n[preview] wrote ${out}`);
  console.log(`[preview] previewHash=${prev.previewHash}`);
} finally {
  try {
    db.close?.();
  } catch {
    /* ignore */
  }
}
