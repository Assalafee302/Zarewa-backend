#!/usr/bin/env node
/**
 * POST (one-shot): CL-26-2056 BR-KD physical-count ADJUSTMENT.
 * 1106 → 679 kg (−427), dated 2026-10-08. Does not edit posted movements.
 * Skips CL-KD-APR-1997.
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

const COIL_NO = 'CL-26-2056';
const BRANCH = 'BR-KD';
const POST_DATE = '2026-10-08';
const NEW_KG = 679;
const EXPECTED_ERP = 1106;
const REASON =
  'Physical count 5 Oct 2026 – 679 kg; agrees with metres run (~788 kg expected)';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const { assertPeriodOpen, appendAuditLog } = await import('../server/controlOps.js');
const { nextStockMovementHumanId } = await import('../server/humanId.js');
const { insertStockMovementTx } = await import('../server/stockMovementOps.js');
const { tryPostInventoryVarianceJournal } = await import('../server/glOps.js');
const { isGlobalCoilCatalogProductId, getProductRowForWorkspace } = await import(
  '../server/productBranchInventory.js'
);
const { stainedOnHandKg } = await import('../server/operations/stainedLotBalance.js');
const { insertCoilControlEventTx } = await import('../server/writeOps.js');

function roundKg3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const cfg = mysqlConfigFromEnv();
console.log(`[post] ${databaseLabel(cfg)} coil=${COIL_NO} type=ADJUSTMENT date=${POST_DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  assertPeriodOpen(db, POST_DATE, 'Coil ADJUSTMENT date');

  const before = db.prepare(`SELECT * FROM coil_lots WHERE coil_no = ?`).get(COIL_NO);
  if (!before) throw new Error(`Coil ${COIL_NO} not found.`);
  if (String(before.branch_id || '').trim() !== BRANCH) {
    throw new Error(`Coil is on ${before.branch_id}, expected ${BRANCH}.`);
  }

  const erpNow = roundKg3(Math.max(0, Number(before.qty_remaining) || Number(before.current_weight_kg) || 0));
  if (Math.abs(erpNow - EXPECTED_ERP) > 0.5) {
    throw new Error(`Abort: live ERP ${erpNow} ≠ expected ${EXPECTED_ERP}. Re-preview.`);
  }
  const reserved = roundKg3(Math.max(0, Number(before.qty_reserved) || 0));
  if (NEW_KG + 0.001 < reserved) {
    throw new Error(`Counted ${NEW_KG} kg below reserved ${reserved} kg.`);
  }

  const adjustmentKg = roundKg3(NEW_KG - erpNow);
  if (Math.abs(adjustmentKg + 427) > 0.5) {
    throw new Error(`Abort: adjustment ${adjustmentKg} ≠ −427. Re-preview.`);
  }

  const unitCost = Math.round(Number(before.unit_cost_ngn_per_kg) || 0);
  const valueNgn = Math.round(Math.abs(adjustmentKg) * unitCost);
  const productId = String(before.product_id || '').trim();
  if (!productId) throw new Error('Coil product id missing.');

  const result = db.transaction(() => {
    db.prepare(
      `UPDATE coil_lots SET qty_remaining = ?, current_weight_kg = ?, current_status = ? WHERE coil_no = ?`
    ).run(NEW_KG, NEW_KG, NEW_KG <= 0.0001 ? 'Consumed' : 'Available', COIL_NO);

    let productStockLevel;
    if (isGlobalCoilCatalogProductId(productId)) {
      const coilSum =
        Number(
          db.prepare(`SELECT COALESCE(SUM(qty_remaining), 0) AS s FROM coil_lots WHERE product_id = ?`).get(productId)
            ?.s
        ) || 0;
      productStockLevel = Math.round(coilSum + stainedOnHandKg(db, productId, null));
      const prow = getProductRowForWorkspace(db, productId, BRANCH);
      if (!prow) throw new Error(`Product ${productId} not found.`);
      const pb = String(prow.branch_id ?? '').trim();
      if (pb) {
        db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(
          productStockLevel,
          productId,
          pb
        );
      } else {
        db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ?`).run(productStockLevel, productId);
      }
    } else {
      throw new Error(`Unexpected non-global product ${productId} — aborting.`);
    }

    const movementId = nextStockMovementHumanId(db);
    insertStockMovementTx(db, {
      id: movementId,
      atISO: `${POST_DATE}T12:00:00`,
      type: 'ADJUSTMENT',
      productID: productId,
      qty: adjustmentKg,
      ref: COIL_NO,
      dateISO: POST_DATE,
      branchId: BRANCH,
      unitPriceNgn: unitCost > 0 ? unitCost : null,
      valueNgn: valueNgn > 0 ? valueNgn : null,
      detail: REASON.slice(0, 500),
    });

    let glJournalId = null;
    let glSkipped = true;
    if (unitCost > 0 && valueNgn > 0) {
      const gl = tryPostInventoryVarianceJournal(db, {
        entryDateISO: POST_DATE,
        amountNgn: valueNgn,
        direction: 'shortage',
        branchId: BRANCH,
        createdByUserId: null,
        sourceId: movementId,
        memo: `Coil count ${COIL_NO} ${adjustmentKg} kg`,
        sourceKind: 'COIL_ADJUSTMENT_GL',
      });
      if (!gl.ok) throw new Error(gl.error || 'Inventory variance GL posting failed.');
      glJournalId = gl.journalId ?? null;
      glSkipped = Boolean(gl.skipped);
    }

    insertCoilControlEventTx(db, {
      branchId: BRANCH,
      eventKind: 'adjust_remove_kg',
      coilNo: COIL_NO,
      productId,
      gaugeLabel: before.gauge_label,
      colour: before.colour,
      meters: null,
      kgCoilDelta: adjustmentKg,
      scrapReason: REASON.slice(0, 200),
      note: 'Physical count 5 Oct 2026 (posted 8 Oct ADJUSTMENT)',
      dateIso: POST_DATE,
      bookRef: 'Physical count 5 Oct 2026',
      creditScrapInventory: false,
      actorUserId: null,
      actorDisplay: 'ops-script',
    });

    appendAuditLog(db, {
      actor: null,
      action: 'coil.physical_count_adjustment',
      entityKind: 'coil_lot',
      entityId: COIL_NO,
      note: `${NEW_KG} kg set from ${erpNow} kg (−427)`,
      details: {
        coilNo: COIL_NO,
        bookKg: erpNow,
        countedKg: NEW_KG,
        varianceKg: adjustmentKg,
        dateISO: POST_DATE,
        reason: REASON,
        movementId,
        movementType: 'ADJUSTMENT',
        glJournalId,
        glSkipped,
        skippedCoil: 'CL-KD-APR-1997',
      },
    });

    return { movementId, productStockLevel, glJournalId, glSkipped };
  })();

  const after = db.prepare(`SELECT qty_remaining, current_weight_kg, current_status FROM coil_lots WHERE coil_no = ?`).get(
    COIL_NO
  );
  const skipped = db
    .prepare(`SELECT qty_remaining, current_weight_kg FROM coil_lots WHERE coil_no = ?`)
    .get('CL-KD-APR-1997');

  const out = {
    ok: true,
    posted: true,
    coilNo: COIL_NO,
    movementId: result.movementId,
    movementType: 'ADJUSTMENT',
    postDate: POST_DATE,
    erpBefore: erpNow,
    newOnHandKg: roundKg3(Number(after?.qty_remaining) || 0),
    currentWeightKg: roundKg3(Number(after?.current_weight_kg) || 0),
    status: after?.current_status,
    adjustmentKg,
    unitCostNgnPerKg: unitCost,
    valueNgn,
    productId,
    productStockLevel: result.productStockLevel,
    glJournalId: result.glJournalId,
    glSkipped: result.glSkipped,
    reason: REASON,
    skipped: {
      coilNo: 'CL-KD-APR-1997',
      qtyRemaining: skipped?.qty_remaining,
      note: 'Left unchanged per approval',
    },
  };

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'KD-coil-count-adjust-2056-post-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[post] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
