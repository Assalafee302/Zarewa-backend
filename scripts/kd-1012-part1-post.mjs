#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 corrections — Part 1 (approved "go").
 * A1 CL-26-2058 → 36 kg (ADJUSTMENT −20) + colour Ivory Beige
 * A2 CL-26-2056 COIL_SCRAP −55
 * A3 17 end-of-roll tails COIL_SCRAP to 0 (CL-26-2205 excluded: colour → Ivory Beige, keep 71 kg)
 * A4 CL-26-2027 COIL_SCRAP −848
 * Uncoiler: fixed asset + 12 Oct GL Dr 1500 / Cr 1004, close INV-KD-26-0008.
 * All new movements dated 2026-10-12. September stays locked; no posted movement is edited.
 * Usage: node scripts/kd-1012-part1-post.mjs [--dry]
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
const { tryPostInventoryVarianceJournal, postBalancedJournalTx } = await import('../server/glOps.js');
const { isGlobalCoilCatalogProductId, getProductRowForWorkspace } = await import(
  '../server/productBranchInventory.js'
);
const { stainedOnHandKg } = await import('../server/operations/stainedLotBalance.js');
const { insertCoilControlEventTx, postCoilScrap, patchCoilLotMasterData } = await import('../server/writeOps.js');

const roundKg3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const TAIL_REASON = 'End-of-roll tail not found – 9 Oct 2026 verification';
const SCRAPS = [
  { coilNo: 'CL-26-2056', expectKg: 55, reason: 'Roll finished – 9 Oct 2026 verification', item: 'A2' },
  ...[
    ['CL-KD-APR-1741', 41.25], ['CL-KD-APR-1935', 75], ['CL-KD-APR-1857', 71], ['CL-KD-APR-1987', 76.73],
    ['CL-KD-APR-1841', 65], ['CL-KD-APR-1979', 71], ['CL-KD-APR-1976', 84], ['CL-KD-APR-1998', 38],
    ['CL-KD-APR-1906', 38], ['CL-KD-APR-1901', 46], ['CL-KD-APR-1577', 8], ['CL-KD-APR-2006', 27],
    ['CL-KD-APR-1880', 7], ['CL-26-2021', 60], ['CL-26-1970', 54], ['CL-26-2059', 86], ['CL-26-2200', 1],
  ].map(([coilNo, expectKg]) => ({ coilNo, expectKg, reason: TAIL_REASON, item: 'A3' })),
  {
    coilNo: 'CL-26-2027',
    expectKg: 848,
    reason: 'Coil does not exist – confirmed by OM; it was mistaken for another coil (9 Oct 2026 verification)',
    item: 'A4',
  },
];
const A1 = {
  coilNo: 'CL-26-2058',
  expectKg: 56,
  newKg: 36,
  colour: 'Ivory Beige',
  reason: '9 Oct 2026 verification – colour is Ivory Beige; 108 kg',
  note: 'Counted 108 kg on 9 Oct; 72 kg used 10 Oct on PRO-KD-26-1456 → 36 kg',
};
const RECOLOUR_2205 = { coilNo: 'CL-26-2205', expectKg: 71, colour: 'Ivory Beige' };
const UNCOILER = {
  movementId: 'TM-KD-26-3096',
  caseId: 'INV-KD-26-0008',
  amountNgn: 430000,
  decision: 'Confirmed by OM: manual uncoiler',
};

const cfg = mysqlConfigFromEnv();
console.log(`[part1] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)} branch=${BRANCH} date=${DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

const coil = (cn) => db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(cn);
const onHand = (row) => roundKg3(Math.max(0, Number(row.qty_remaining) || Number(row.current_weight_kg) || 0));
const movementsFor = (cn) =>
  db
    .prepare(
      `SELECT id, type, qty, value_ngn FROM stock_movements WHERE ref = ? AND date_iso = ? AND type IN ('COIL_SCRAP','ADJUSTMENT') ORDER BY at_iso, id`
    )
    .all(cn, DATE);

const out = { date: DATE, dry: DRY, lines: [], uncoiler: null };

try {
  assertPeriodOpen(db, DATE, '12 Oct corrections');

  // ---- Pre-checks: abort before any write if live ERP differs from the preview ----
  const problems = [];
  for (const t of [A1, RECOLOUR_2205, ...SCRAPS]) {
    const r = coil(t.coilNo);
    if (!r) { problems.push(`${t.coilNo} not found`); continue; }
    if (String(r.branch_id || '').trim() !== BRANCH) problems.push(`${t.coilNo} on ${r.branch_id}`);
    if (Math.abs(onHand(r) - t.expectKg) > 0.01) problems.push(`${t.coilNo} ERP ${onHand(r)} ≠ ${t.expectKg}`);
    if ((Number(r.qty_reserved) || 0) > 0.0001) problems.push(`${t.coilNo} has ${r.qty_reserved} kg reserved`);
    if (movementsFor(t.coilNo).length) problems.push(`${t.coilNo} already has a ${DATE} scrap/adjustment`);
  }
  const tm = db.prepare(`SELECT * FROM treasury_movements WHERE id = ?`).get(UNCOILER.movementId);
  if (!tm || Math.round(Number(tm.amount_ngn)) !== -UNCOILER.amountNgn) problems.push('TM-KD-26-3096 not −430,000');
  const inv = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(UNCOILER.caseId);
  if (!inv || inv.status !== 'open') problems.push(`${UNCOILER.caseId} not open`);
  if (Number(inv?.suspended_ngn) > 0) problems.push(`${UNCOILER.caseId} has suspense — review close path`);
  const faDup = db.prepare(`SELECT id FROM fixed_assets WHERE treasury_reference = ?`).get(UNCOILER.movementId);
  if (faDup) problems.push(`Fixed asset already exists for TM-KD-26-3096 (${faDup.id})`);
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part1] pre-checks OK');
  if (DRY) {
    console.log('[part1] dry run — nothing written');
    process.exit(0);
  }

  // ---- A1: ADJUSTMENT −20 kg, then colour ----
  {
    const before = coil(A1.coilNo);
    const erpNow = onHand(before);
    const adj = roundKg3(A1.newKg - erpNow);
    const unitCost = Math.round(Number(before.unit_cost_ngn_per_kg) || 0);
    const valueNgn = Math.round(Math.abs(adj) * unitCost);
    const productId = String(before.product_id || '').trim();
    if (!isGlobalCoilCatalogProductId(productId)) throw new Error(`Unexpected product ${productId}`);
    const r = db.transaction(() => {
      db.prepare(`UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ?, current_status = ? WHERE coil_no = ?`).run(
        A1.newKg, A1.newKg, 'Available', A1.coilNo
      );
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
        ref: A1.coilNo,
        dateISO: DATE,
        branchId: BRANCH,
        unitPriceNgn: unitCost || null,
        valueNgn: valueNgn || null,
        detail: `${A1.reason}. ${A1.note}`.slice(0, 500),
      });
      const gl = tryPostInventoryVarianceJournal(db, {
        entryDateISO: DATE,
        amountNgn: valueNgn,
        direction: 'shortage',
        branchId: BRANCH,
        createdByUserId: null,
        sourceId: movementId,
        memo: `Coil count ${A1.coilNo} ${adj} kg`,
        sourceKind: 'COIL_ADJUSTMENT_GL',
      });
      if (!gl.ok) throw new Error(gl.error || 'Variance GL failed');
      insertCoilControlEventTx(db, {
        branchId: BRANCH,
        eventKind: 'adjust_remove_kg',
        coilNo: A1.coilNo,
        productId,
        gaugeLabel: before.gauge_label,
        colour: A1.colour,
        meters: null,
        kgCoilDelta: adj,
        scrapReason: A1.reason.slice(0, 200),
        note: A1.note,
        dateIso: DATE,
        bookRef: '9 Oct 2026 verification',
        creditScrapInventory: false,
        actorUserId: null,
        actorDisplay: 'ops-script',
      });
      appendAuditLog(db, {
        actor: null,
        action: 'coil.physical_count_adjustment',
        entityKind: 'coil_lot',
        entityId: A1.coilNo,
        note: `${A1.newKg} kg set from ${erpNow} kg (${adj})`,
        details: { coilNo: A1.coilNo, bookKg: erpNow, countedKg: A1.newKg, varianceKg: adj, dateISO: DATE, reason: A1.reason, movementId, glJournalId: gl.journalId ?? null },
      });
      return { movementId, glJournalId: gl.journalId ?? null };
    })();
    const col = patchCoilLotMasterData(db, A1.coilNo, { colour: A1.colour }, { workspaceBranchId: BRANCH, actor: null });
    if (!col.ok) throw new Error(`A1 colour: ${col.error}`);
    out.lines.push({ item: 'A1', coilNo: A1.coilNo, type: 'ADJUSTMENT', erpBefore: erpNow, kg: adj, unitCost, valueNgn, ...r, colour: `${before.colour} → ${A1.colour}` });
    console.log(`[A1] ${A1.coilNo} ${adj} kg → ${r.movementId} / ${r.glJournalId}; colour → ${A1.colour}`);
  }

  // ---- A2/A3/A4: COIL_SCRAP to 0 ----
  for (const s of SCRAPS) {
    const before = coil(s.coilNo);
    const kg = Number(before.qty_remaining) || Number(before.current_weight_kg) || 0;
    const res = postCoilScrap(
      db,
      { coilNo: s.coilNo, kg, reason: s.reason, dateISO: DATE, creditScrapInventory: false },
      { workspaceBranchId: BRANCH, actor: null }
    );
    if (!res?.ok) throw new Error(`${s.item} ${s.coilNo}: ${res?.error}`);
    const mv = movementsFor(s.coilNo).filter((m) => m.type === 'COIL_SCRAP').pop();
    const gl = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_id LIKE ? AND entry_date_iso = ? ORDER BY created_at_iso DESC`)
      .get(`scrap:${s.coilNo}:${DATE}%`, DATE);
    const unitCost = Number(before.unit_cost_ngn_per_kg) || 0;
    out.lines.push({ item: s.item, coilNo: s.coilNo, type: 'COIL_SCRAP', erpBefore: roundKg3(kg), kg: -roundKg3(kg), unitCost, valueNgn: Math.round(kg * unitCost), movementId: mv?.id ?? null, glJournalId: gl?.id ?? null, after: onHand(coil(s.coilNo)) });
    console.log(`[${s.item}] ${s.coilNo} −${roundKg3(kg)} kg → ${mv?.id} / ${gl?.id}`);
  }

  // ---- CL-26-2205: colour only, keep 71 kg ----
  {
    const before = coil(RECOLOUR_2205.coilNo);
    const col = patchCoilLotMasterData(db, RECOLOUR_2205.coilNo, { colour: RECOLOUR_2205.colour }, { workspaceBranchId: BRANCH, actor: null });
    if (!col.ok) throw new Error(`2205 colour: ${col.error}`);
    out.lines.push({ item: 'A3-excluded', coilNo: RECOLOUR_2205.coilNo, type: 'master data', colour: `${before.colour} → ${RECOLOUR_2205.colour}`, kept: onHand(before) });
    console.log(`[2205] colour ${before.colour} → ${RECOLOUR_2205.colour}, kept ${onHand(before)} kg`);
  }

  // ---- Uncoiler ----
  {
    const r = db.transaction(() => {
      const now = new Date().toISOString();
      const faId = `FA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(
        `INSERT INTO fixed_assets (id, name, category, branch_id, acquisition_date_iso, cost_ngn, salvage_ngn, useful_life_months,
          depreciation_method, status, disposal_date_iso, treasury_reference, notes, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        faId, 'Manual uncoiler', 'plant', BRANCH, '2026-09-22', UNCOILER.amountNgn, 0, 60, 'straight_line', 'active', null,
        UNCOILER.movementId,
        'Moniepoint debit 22 Sep 2026 to Ademiluwa Paul Kunle (Union Bank 0013595396), ref TRF|2MPTjxi41|2102324803013160960. Confirmed by OM. Capitalised by 12 Oct 2026 journal; September untouched.',
        now, now, null, null
      );
      const gl = postBalancedJournalTx(db, {
        entryDateISO: DATE,
        memo: 'Capital – Plant & machinery: Manual uncoiler (TM-KD-26-3096, 22 Sep 2026 Moniepoint debit)',
        sourceKind: 'FIXED_ASSET_CAPITALISE_GL',
        sourceId: `${UNCOILER.movementId}:${faId}`,
        branchId: BRANCH,
        createdByUserId: null,
        lines: [
          { accountCode: '1500', debitNgn: UNCOILER.amountNgn, memo: 'Manual uncoiler' },
          { accountCode: '1004', creditNgn: UNCOILER.amountNgn, memo: 'Moniepoint debit 22 Sep 2026 (TM-KD-26-3096)' },
        ],
      });
      if (!gl.ok || gl.skipped) throw new Error(gl.error || 'Uncoiler journal skipped/failed');
      db.prepare(
        `UPDATE investigation_cases SET status = 'cleared', amount_recovered_ngn = suspended_ngn,
           closed_by_user_id = NULL, closed_at_iso = ?, decision_note = ? WHERE id = ?`
      ).run(now, UNCOILER.decision, UNCOILER.caseId);
      db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
        `INVN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        UNCOILER.caseId,
        'ops-script',
        now,
        `${UNCOILER.decision}. Fixed asset ${faId}; journal ${gl.journalId} (12 Oct 2026, Dr 1500 / Cr 1004).`
      );
      appendAuditLog(db, {
        actor: null,
        action: 'investigation.close',
        entityKind: 'investigation',
        entityId: UNCOILER.caseId,
        note: UNCOILER.decision,
        details: { outcome: 'cleared', fixedAssetId: faId, glJournalId: gl.journalId, movementId: UNCOILER.movementId },
      });
      appendAuditLog(db, {
        actor: null,
        action: 'fixed_asset.create',
        entityKind: 'fixed_asset',
        entityId: faId,
        note: 'Manual uncoiler ₦430,000 (TM-KD-26-3096)',
        details: { glJournalId: gl.journalId, acquisitionDateIso: '2026-09-22', category: 'plant' },
      });
      return { fixedAssetId: faId, glJournalId: gl.journalId };
    })();
    out.uncoiler = { ...r, caseId: UNCOILER.caseId, status: 'cleared' };
    console.log(`[uncoiler] ${r.fixedAssetId} / ${r.glJournalId}; ${UNCOILER.caseId} cleared`);
  }

  const outPath = path.join(process.cwd(), 'exports', 'KD-1012-part1-post-result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[part1] FAILED', e?.message || e);
  const outPath = path.join(process.cwd(), 'exports', 'KD-1012-part1-post-partial.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  db.close?.();
}
