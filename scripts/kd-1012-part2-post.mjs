#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — approved items:
 * 1. Storm Shield PO-KD-26-0079: TM-KD-26-2997 is a real second payment (Taj statement 11 Sep).
 *    a) acknowledge cashier ack PPCA-MUQYSSR7-GDJR with bank evidence
 *    b) 12 Oct GL correction so JE-KD-26-3701 (₦5,698,360) matches TM-KD-26-2570 (₦5,920,240): +₦221,880
 *       Dr 2000 ₦1,720 (settles invoice ₦5,700,080) / Dr 1400 ₦220,160 (overpayment) / Cr 1002 Taj ₦221,880
 * 2. A5: receive CL-26-2096 Ivory Beige 0.20, 2,782 kg @ ₦1,720 on PO-KD-26-0078 line 1; close MT-KD-26-0019.
 * Usage: node scripts/kd-1012-part2-post.mjs [--dry]
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
const { postBalancedJournalTx } = await import('../server/glOps.js');
const { confirmGrn } = await import('../server/writeOps.js');
const { syncInTransitLoadFromGrn } = await import('../server/inTransitOps.js');
const { acknowledgePurchasePaymentCashierAck } = await import(
  '../server/finance/purchasePaymentCashierAckOps.js'
);

const ACK_ID = 'PPCA-MUQYSSR7-GDJR';
const ACK_NOTE = 'Taj statement 11 Sep, second debit ₦5,920,293.75';
const PO_STORM = 'PO-KD-26-0079';
const TM_2570 = 'TM-KD-26-2570';
const JE_3701 = 'JE-KD-26-3701';
const PO_JACK = 'PO-KD-26-0078';
const LINE_1 = 'L1789397359497-0-rsz2';
const NEW_COIL = 'CL-26-2096';
const LOAD = 'MT-KD-26-0019';
const A5_NOTE =
  'Substitute for ordered Bush Green 0.24 (2,750 kg) – supplier sent IB 0.20; received 12 Sep per store book; coil confirmed full and unused 12 Oct';
const actor = { id: null, name: 'ops-script', displayName: 'ops-script' };

const cfg = mysqlConfigFromEnv();
console.log(`[part2] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)} date=${DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const out = { date: DATE };

try {
  assertPeriodOpen(db, DATE, '12 Oct corrections');

  const problems = [];
  const ack = db.prepare(`SELECT * FROM purchase_payment_cashier_acks WHERE ack_id = ?`).get(ACK_ID);
  if (!ack || ack.status !== 'Pending' || ack.treasury_movement_id !== 'TM-KD-26-2997') problems.push('ack not pending on TM-2997');
  const tm = db.prepare(`SELECT amount_ngn FROM treasury_movements WHERE id = ?`).get(TM_2570);
  if (Math.round(Number(tm?.amount_ngn)) !== -5920240) problems.push('TM-2570 not −5,920,240');
  const jeCash = db
    .prepare(`SELECT SUM(credit_ngn) c FROM gl_journal_lines WHERE journal_id = ? AND account_id = 'acc-cash-2'`)
    .get(JE_3701);
  if (Math.round(Number(jeCash?.c)) !== 5698360) problems.push('JE-3701 cash credit not 5,698,360');
  const priorCorr = db
    .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'SUPPLIER_PAYMENT_CORRECTION_GL' AND source_id LIKE ?`)
    .get(`${TM_2570}:%`);
  if (priorCorr) problems.push(`correction already exists ${priorCorr.id}`);
  if (db.prepare(`SELECT 1 FROM coil_lots WHERE coil_no = ?`).get(NEW_COIL)) problems.push(`${NEW_COIL} exists`);
  const po = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get(PO_JACK);
  if (po?.status !== 'In Transit') problems.push(`PO-0078 status ${po?.status}`);
  const l1 = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ? AND line_key = ?`).get(PO_JACK, LINE_1);
  if (!l1 || Number(l1.qty_received) !== 0) problems.push('PO-0078 line 1 not at 0 received');
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part2] pre-checks OK');
  if (DRY) process.exit(0);

  // 1a. Cashier acknowledgement
  const a = acknowledgePurchasePaymentCashierAck(db, ACK_ID, {
    actor,
    note: ACK_NOTE,
    workspaceBranchId: BRANCH,
  });
  if (!a.ok) throw new Error(`ack: ${a.error}`);
  out.ack = { ackId: ACK_ID, status: a.ack?.status ?? 'Acknowledged' };
  console.log(`[1a] ${ACK_ID} acknowledged`);

  // 1b. GL correction for TM-2570
  const gl = db.transaction(() => {
    const r = postBalancedJournalTx(db, {
      entryDateISO: DATE,
      memo: `Correct supplier payment ${PO_STORM} GL from 5698360 to 5920240 (${TM_2570}; ${JE_3701})`,
      sourceKind: 'SUPPLIER_PAYMENT_CORRECTION_GL',
      sourceId: `${TM_2570}:1`,
      branchId: BRANCH,
      createdByUserId: null,
      lines: [
        { accountCode: '2000', debitNgn: 1720, memo: `${PO_STORM} invoice balance` },
        { accountCode: '1400', debitNgn: 220160, memo: `${PO_STORM} overpayment on ${TM_2570}` },
        { accountCode: '1002', creditNgn: 221880, memo: TM_2570 },
      ],
    });
    if (!r.ok || r.skipped) throw new Error(r.error || 'GL skipped');
    appendAuditLog(db, {
      actor: null,
      action: 'purchase_order.supplier_payment_gl_correct',
      entityKind: 'purchase_order',
      entityId: PO_STORM,
      note: `GL brought into line with ${TM_2570} (+₦221,880)`,
      details: { movementId: TM_2570, priorJournalId: JE_3701, journalId: r.journalId, deltaNgn: 221880, settlementNgn: 1720, advanceNgn: 220160 },
    });
    return r.journalId;
  })();
  out.glCorrection = gl;
  console.log(`[1b] GL correction ${gl}`);

  // 2. A5 receipt + load
  const g = confirmGrn(
    db,
    PO_JACK,
    [
      {
        lineKey: LINE_1,
        line_key: LINE_1,
        productID: 'PRD-102',
        qtyReceived: 2782,
        weightKg: 2782,
        coilNo: NEW_COIL,
        colour: 'Ivory Beige',
        gaugeLabel: '0.20mm',
        materialTypeName: 'Aluzinc (PPGI)',
        receivedAtISO: DATE,
        location: 'main store',
      },
    ],
    undefined,
    undefined,
    BRANCH,
    { actor, allowConversionMismatch: true }
  );
  if (!g.ok) throw new Error(`GRN: ${g.error}`);
  db.prepare(
    `UPDATE coil_lots SET material_origin_note = ?, supplier_expected_meters = NULL, supplier_conversion_kg_per_m = NULL WHERE coil_no = ?`
  ).run(A5_NOTE, NEW_COIL);
  appendAuditLog(db, {
    actor: null,
    action: 'purchase_order.grn_substitute',
    entityKind: 'purchase_order',
    entityId: PO_JACK,
    note: A5_NOTE,
    details: { coilNo: NEW_COIL, lineKey: LINE_1, kg: 2782, unitCostNgnPerKg: 1720, dateISO: DATE },
  });
  const ld = syncInTransitLoadFromGrn(db, PO_JACK, [{ receivedAtISO: DATE }], null);
  if (!ld.ok) throw new Error(`load: ${ld.error}`);
  const mv = db
    .prepare(`SELECT id, qty, value_ngn FROM stock_movements WHERE type = 'STORE_GRN' AND ref = ? AND detail LIKE ?`)
    .get(PO_JACK, `${NEW_COIL}%`);
  const je = db.prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'COIL_GRN' AND source_id = ?`).get(NEW_COIL);
  const lot = db.prepare(`SELECT coil_no, colour, gauge_label, qty_remaining, unit_cost_ngn_per_kg, landed_cost_ngn, received_at_iso FROM coil_lots WHERE coil_no = ?`).get(NEW_COIL);
  const poAfter = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get(PO_JACK);
  const loadAfter = db.prepare(`SELECT status, received_at_iso FROM in_transit_loads WHERE id = ?`).get(LOAD);
  out.a5 = { movementId: mv?.id, glJournalId: je?.id, lot, poStatus: poAfter?.status, load: loadAfter };
  console.log(`[A5] ${NEW_COIL} → ${mv?.id} / ${je?.id}; PO ${poAfter?.status}; load ${loadAfter?.status}`);

  const outPath = path.join(process.cwd(), 'exports', 'KD-1012-part2-post-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[part2] FAILED', e?.message || e);
  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part2-post-partial.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  db.close?.();
}
