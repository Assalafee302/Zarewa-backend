#!/usr/bin/env node
/**
 * READ-ONLY: Preview BR-KD coil ADJUSTMENT lines from 5 Oct physical count.
 * Date to post (if approved): 2026-10-08. Does not INSERT/UPDATE/DELETE.
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

const POST_DATE = '2026-10-08';
const BRANCH = 'BR-KD';
const MOVEMENT_TYPE = 'ADJUSTMENT';

const TARGETS = [
  {
    coilNo: 'CL-KD-APR-1997',
    colour: 'Ivory Beige',
    gauge: '0.40',
    newKg: 1633,
    expectedErpHint: 2634,
    reason: 'Physical count 5 Oct 2026 – 1,633 kg; ERP above received weight',
  },
  {
    coilNo: 'CL-26-2056',
    colour: 'Bush Green',
    gauge: '0.28',
    newKg: 679,
    expectedErpHint: 1106,
    reason: 'Physical count 5 Oct 2026 – 679 kg; agrees with metres run (~788 kg expected)',
  },
];

const cfg = mysqlConfigFromEnv();
console.log(`[preview] READ-ONLY ${databaseLabel(cfg)} branch=${BRANCH} type=${MOVEMENT_TYPE} date=${POST_DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const lines = [];
  for (const t of TARGETS) {
    const row = db
      .prepare(
        `SELECT coil_no, colour, gauge_label, branch_id, product_id,
                qty_remaining, current_weight_kg, qty_reserved, qty_received, weight_kg,
                unit_cost_ngn_per_kg, current_status, landed_cost_ngn
         FROM coil_lots WHERE coil_no = ?`
      )
      .get(t.coilNo);

    if (!row) {
      lines.push({ coilNo: t.coilNo, ok: false, error: 'Coil not found' });
      continue;
    }

    const erpNow = Math.round((Number(row.qty_remaining) || Number(row.current_weight_kg) || 0) * 1000) / 1000;
    const reserved = Math.round((Number(row.qty_reserved) || 0) * 1000) / 1000;
    const unitCost = Math.round(Number(row.unit_cost_ngn_per_kg) || 0);
    const adjustmentKg = Math.round((t.newKg - erpNow) * 1000) / 1000;
    const valueNgn = Math.round(Math.abs(adjustmentKg) * unitCost);

    const periodKey = POST_DATE.slice(0, 7);
    const octLock = db
      .prepare(`SELECT period_key, reason FROM accounting_period_locks WHERE period_key = ?`)
      .get(periodKey);
    const sepLock = db
      .prepare(`SELECT period_key, reason FROM accounting_period_locks WHERE period_key = ?`)
      .get('2026-09');

    lines.push({
      ok: true,
      coilNo: t.coilNo,
      colour: row.colour || t.colour,
      gauge: row.gauge_label || t.gauge,
      branchId: row.branch_id,
      productId: row.product_id,
      status: row.current_status,
      qtyReceived: Number(row.qty_received) || Number(row.weight_kg) || null,
      reservedKg: reserved,
      erpNow,
      expectedErpHint: t.expectedErpHint,
      erpMatchesHint: Math.abs(erpNow - t.expectedErpHint) < 1.5,
      newKg: t.newKg,
      adjustmentKg,
      unitCostNgnPerKg: unitCost,
      valueNgn,
      movementType: MOVEMENT_TYPE,
      postDate: POST_DATE,
      reason: t.reason,
      periodKey,
      octoberLocked: Boolean(octLock),
      septemberLocked: Boolean(sepLock),
      blockedBelowReserved: t.newKg + 0.001 < reserved,
    });
  }

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `KD-coil-count-adjust-preview-${stamp}.json`);
  const payload = {
    previewOnly: true,
    posted: false,
    branchId: BRANCH,
    postDate: POST_DATE,
    movementType: MOVEMENT_TYPE,
    note: 'Do not edit any posted movement. New ADJUSTMENT only after "go".',
    lines,
    totals: {
      adjustmentKg: lines.reduce((s, l) => s + (l.adjustmentKg || 0), 0),
      valueNgn: lines.reduce((s, l) => s + (l.valueNgn || 0), 0),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log('\n=== Coil ADJUSTMENT preview (NOT POSTED) ===');
  console.table(
    lines.map((l) => ({
      coil: l.coilNo,
      colour: l.colour,
      gauge: l.gauge,
      erpNow: l.erpNow,
      newKg: l.newKg,
      adjustmentKg: l.adjustmentKg,
      unitCost: l.unitCostNgnPerKg,
      valueNgn: l.valueNgn,
      erpOk: l.erpMatchesHint,
      reserved: l.reservedKg,
      OctOpen: !l.octoberLocked,
      SepLocked: l.septemberLocked,
    }))
  );
  console.log('\nTotals:', payload.totals);
  for (const l of lines) {
    if (l.ok && !l.erpMatchesHint) {
      console.log(
        `\nNOTE ${l.coilNo}: live ERP ${l.erpNow} kg ≠ your hint ${l.expectedErpHint} kg.` +
          ` Adjustment from live book → ${l.newKg} is ${l.adjustmentKg > 0 ? '+' : ''}${l.adjustmentKg} kg.`
      );
    }
    console.log(`Reason ${l.coilNo}: ${l.reason}`);
  }
  console.log('Wrote', outPath);
} finally {
  db.close?.();
}
