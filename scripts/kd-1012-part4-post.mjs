#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — store verification, approved "go":
 *  - CL-26-2060: complete PRO-KD-26-1122 (Nazifi, 15 m, closing 154 kg) then COIL_SCRAP 154 kg
 *  - CL-KD-APR-1512: ADJUSTMENT 261 → 159 kg; note "tag 1806"
 *  - CL-26-2038: COIL_SCRAP 203 kg
 *  - CL-26-2062: COIL_SCRAP 105 kg
 *  - MV-26-00497 (CL-26-2205 GRN): date 2099-09-15 → 2026-09-15 only (OM-approved exception)
 * Usage: node scripts/kd-1012-part4-post.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';

function commentedMysql(envPath) {
  const map = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
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

const DRY = process.argv.includes('--dry');
const BRANCH = 'BR-KD';
const DATE = '2026-10-12';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { assertPeriodOpen, appendAuditLog } = await import('../server/controlOps.js');
const { nextStockMovementHumanId } = await import('../server/humanId.js');
const { insertStockMovementTx } = await import('../server/stockMovementOps.js');
const { tryPostInventoryVarianceJournal } = await import('../server/glOps.js');
const { isGlobalCoilCatalogProductId, getProductRowForWorkspace } = await import(
  '../server/productBranchInventory.js'
);
const { stainedOnHandKg } = await import('../server/operations/stainedLotBalance.js');
const { insertCoilControlEventTx, postCoilScrap } = await import('../server/writeOps.js');
const { completeProductionJob } = await import('../server/productionTraceability.js');

const roundKg3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const actor = { id: null, name: 'ops-script', displayName: 'ops-script' };

const JOB = 'PRO-KD-26-1122';
const ADJ = {
  coilNo: 'CL-KD-APR-1512',
  expectKg: 261,
  newKg: 159,
  reason: 'Physical check 12 Oct 2026 – found tagged 1806, 159 kg; ERP number kept, coil re-marked 1512',
};
const SCRAPS = [
  { coilNo: 'CL-26-2038', expectKg: 203, reason: 'End-of-roll tail not found – 12 Oct 2026 verification (last used 13 Jul)' },
  { coilNo: 'CL-26-2062', expectKg: 105, reason: 'Roll finished – 0.28 end spoil / scale difference' },
];
const MV_FIX = { id: 'MV-26-00497', from: '2099-09-15', to: '2026-09-15', note: 'Year keying error; OM approved 12 Oct 2026' };

const cfg = mysqlConfigFromEnv();
console.log(`[part4] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)} date=${DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const coil = (cn) => db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(cn);
const onHand = (r) => roundKg3(Math.max(0, Number(r.qty_remaining) || Number(r.current_weight_kg) || 0));
const lastMv = (cn, type) =>
  db
    .prepare(`SELECT id, qty FROM stock_movements WHERE ref = ? AND type = ? AND date_iso = ? ORDER BY at_iso DESC, id DESC`)
    .get(cn, type, DATE);
const out = { date: DATE, lines: [] };

try {
  assertPeriodOpen(db, DATE, '12 Oct corrections');
  const problems = [];
  const job = db.prepare(`SELECT status, planned_meters FROM production_jobs WHERE job_id = ?`).get(JOB);
  if (job?.status !== 'Running') problems.push(`${JOB} status ${job?.status}`);
  const c2060 = coil('CL-26-2060');
  if (onHand(c2060) !== 188 || Number(c2060.qty_reserved) !== 188) problems.push('2060 not 188/188 reserved');
  const a = coil(ADJ.coilNo);
  if (onHand(a) !== ADJ.expectKg) problems.push(`${ADJ.coilNo} ERP ${onHand(a)}`);
  for (const s of SCRAPS) {
    const r = coil(s.coilNo);
    if (onHand(r) !== s.expectKg || Number(r.qty_reserved) > 0) problems.push(`${s.coilNo} ERP ${onHand(r)} res ${r.qty_reserved}`);
  }
  const mv = db.prepare(`SELECT date_iso, qty, value_ngn FROM stock_movements WHERE id = ?`).get(MV_FIX.id);
  if (mv?.date_iso !== MV_FIX.from) problems.push(`${MV_FIX.id} date ${mv?.date_iso}`);
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part4] pre-checks OK');
  if (DRY) process.exit(0);

  // 1. CL-26-2060 — complete Nazifi job, then scrap the remainder
  const done = completeProductionJob(
    db,
    JOB,
    {
      completedAtISO: `${DATE}T12:00:00.000Z`,
      productionDateISO: DATE,
      allocations: [{ coilNo: 'CL-26-2060', closingWeightKg: 154, metersProduced: 15, finishCoil: false }],
      conversionVarianceReasonCode: 'other',
      conversionVarianceReasonText: 'Completed 12 Oct 2026 at 2.27 kg/m per OM (job left running since 9 Oct)',
    },
    { actor, workspaceBranchId: BRANCH }
  );
  if (!done?.ok) throw new Error(`${JOB} completion: ${done?.error}`);
  const cons = db
    .prepare(`SELECT id, qty FROM stock_movements WHERE ref = ? AND type = 'COIL_CONSUMPTION' AND detail LIKE 'CL-26-2060%' ORDER BY at_iso DESC, id DESC`)
    .get(JOB);
  const after2060 = coil('CL-26-2060');
  out.lines.push({ coilNo: 'CL-26-2060', step: 'complete PRO-KD-26-1122', kg: cons?.qty, movementId: cons?.id, afterKg: onHand(after2060), reservedAfter: after2060.qty_reserved });
  console.log(`[2060] ${JOB} completed → ${cons?.id} (${cons?.qty} kg); coil now ${onHand(after2060)} kg`);

  const rem = onHand(after2060);
  if (Math.abs(rem - 154) > 0.01) throw new Error(`2060 after completion is ${rem}, expected 154 — stopping before scrap.`);
  const s60 = postCoilScrap(
    db,
    { coilNo: 'CL-26-2060', kg: rem, reason: 'Roll finished – end spoil', dateISO: DATE, creditScrapInventory: false },
    { workspaceBranchId: BRANCH, actor: null }
  );
  if (!s60.ok) throw new Error(`2060 scrap: ${s60.error}`);
  out.lines.push({ coilNo: 'CL-26-2060', step: 'COIL_SCRAP', kg: -rem, movementId: lastMv('CL-26-2060', 'COIL_SCRAP')?.id });
  console.log(`[2060] scrap −${rem} → ${lastMv('CL-26-2060', 'COIL_SCRAP')?.id}`);

  // 2. CL-KD-APR-1512 — ADJUSTMENT + note
  {
    const before = coil(ADJ.coilNo);
    const erpNow = onHand(before);
    const adj = roundKg3(ADJ.newKg - erpNow);
    const unitCost = Math.round(Number(before.unit_cost_ngn_per_kg) || 0);
    const valueNgn = Math.round(Math.abs(adj) * unitCost);
    const productId = String(before.product_id || '').trim();
    if (!isGlobalCoilCatalogProductId(productId)) throw new Error(`Unexpected product ${productId}`);
    const priorNote = String(before.material_origin_note || '').trim();
    const r = db.transaction(() => {
      db.prepare(
        `UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ?, current_status = 'Available', material_origin_note = ? WHERE coil_no = ?`
      ).run(ADJ.newKg, ADJ.newKg, priorNote ? `${priorNote}; tag 1806` : 'tag 1806', ADJ.coilNo);
      const coilSum =
        Number(db.prepare(`SELECT COALESCE(SUM(qty_remaining),0) AS s FROM coil_lots WHERE product_id = ?`).get(productId)?.s) || 0;
      const level = Math.round(coilSum + stainedOnHandKg(db, productId, null));
      const prow = getProductRowForWorkspace(db, productId, BRANCH);
      const pb = String(prow?.branch_id ?? '').trim();
      if (pb) db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(level, productId, pb);
      else db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(level, productId);
      const movementId = nextStockMovementHumanId(db);
      insertStockMovementTx(db, {
        id: movementId,
        atISO: `${DATE}T12:00:00`,
        type: 'ADJUSTMENT',
        productID: productId,
        qty: adj,
        ref: ADJ.coilNo,
        dateISO: DATE,
        branchId: BRANCH,
        unitPriceNgn: unitCost || null,
        valueNgn: valueNgn || null,
        detail: ADJ.reason,
      });
      const gl = tryPostInventoryVarianceJournal(db, {
        entryDateISO: DATE,
        amountNgn: valueNgn,
        direction: 'shortage',
        branchId: BRANCH,
        createdByUserId: null,
        sourceId: movementId,
        memo: `Coil count ${ADJ.coilNo} ${adj} kg`,
        sourceKind: 'COIL_ADJUSTMENT_GL',
      });
      if (!gl.ok) throw new Error(gl.error || 'Variance GL failed');
      insertCoilControlEventTx(db, {
        branchId: BRANCH,
        eventKind: 'adjust_remove_kg',
        coilNo: ADJ.coilNo,
        productId,
        gaugeLabel: before.gauge_label,
        colour: before.colour,
        meters: null,
        kgCoilDelta: adj,
        scrapReason: ADJ.reason.slice(0, 200),
        note: 'Physical tag 1806; re-marked 1512',
        dateIso: DATE,
        bookRef: 'Store verification 12 Oct 2026',
        creditScrapInventory: false,
        actorUserId: null,
        actorDisplay: 'ops-script',
      });
      appendAuditLog(db, {
        actor: null,
        action: 'coil.physical_count_adjustment',
        entityKind: 'coil_lot',
        entityId: ADJ.coilNo,
        note: `${ADJ.newKg} kg set from ${erpNow} kg (${adj}); tag 1806`,
        details: { bookKg: erpNow, countedKg: ADJ.newKg, varianceKg: adj, dateISO: DATE, reason: ADJ.reason, movementId, glJournalId: gl.journalId ?? null },
      });
      return { movementId, glJournalId: gl.journalId ?? null, valueNgn };
    })();
    out.lines.push({ coilNo: ADJ.coilNo, step: 'ADJUSTMENT', kg: adj, ...r });
    console.log(`[1512] ${adj} kg → ${r.movementId} / ${r.glJournalId}`);
  }

  // 3. Scraps 2038, 2062
  for (const s of SCRAPS) {
    const kg = onHand(coil(s.coilNo));
    const r = postCoilScrap(
      db,
      { coilNo: s.coilNo, kg, reason: s.reason, dateISO: DATE, creditScrapInventory: false },
      { workspaceBranchId: BRANCH, actor: null }
    );
    if (!r.ok) throw new Error(`${s.coilNo}: ${r.error}`);
    const m = lastMv(s.coilNo, 'COIL_SCRAP');
    out.lines.push({ coilNo: s.coilNo, step: 'COIL_SCRAP', kg: -kg, movementId: m?.id });
    console.log(`[${s.coilNo}] −${kg} → ${m?.id}`);
  }

  // 4. MV-26-00497 date only
  db.transaction(() => {
    db.prepare(`UPDATE stock_movements SET date_iso = ?, at_iso = ? WHERE id = ? AND date_iso = ?`).run(
      MV_FIX.to,
      `${MV_FIX.to}T12:00:00`,
      MV_FIX.id,
      MV_FIX.from
    );
    appendAuditLog(db, {
      actor: null,
      action: 'stock_movement.date_correction',
      entityKind: 'stock_movement',
      entityId: MV_FIX.id,
      note: MV_FIX.note,
      details: { previous: MV_FIX.from, next: MV_FIX.to, coilNo: 'CL-26-2205', qtyUnchanged: 71, valueUnchanged: 461500 },
    });
  })();
  out.mvFix = db.prepare(`SELECT id, date_iso, at_iso, qty, value_ngn FROM stock_movements WHERE id = ?`).get(MV_FIX.id);
  console.log(`[MV] ${MV_FIX.id} → ${out.mvFix.date_iso}`);

  const outPath = path.join(process.cwd(), 'exports', 'KD-1012-part4-post-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[part4] FAILED', e?.message || e);
  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part4-post-partial.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  db.close?.();
}
