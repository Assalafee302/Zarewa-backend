#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — approved "go":
 * 1a  PO-KD-26-0086 line 1: gauge 0.20 → 0.24 (product …-0.20mm → …-0.24mm)
 * 1b  Receive 423 m on PO-0086 (STORE_GRN_STONE; GL Dr 1300 / Cr 2100 ₦2,834,100) → PO Received
 * 1c  Reverse 8 Oct reset line MV-26-00704 (+423 m): ADJUSTMENT −423 m, GL Dr 5055 / Cr 1300 ₦1,861,200
 * 1d  Cost of sale for 423 m already issued on PRO-KD-26-1279: GL Dr 5000 / Cr 1300 ₦2,834,100 (no movement)
 * 1e  Cashier ack PPCA-MUR0AUOI-UAC3
 * 3   SUP-020 add Zenith 1217150953; close WI-KD-26-2467
 *     QT-KD-26-1577 note: 2 stone-nail packs still owed
 * 4   Investigation case: Moniepoint 4 Sep ₦6,075,420 to RAMATU HUSSAINI JALLO
 * Usage: node scripts/kd-1012-part5-post.mjs [--dry]
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
const { postBalancedJournalTx, tryPostInventoryVarianceJournal } = await import('../server/glOps.js');
const { confirmGrn } = await import('../server/writeOps.js');
const { bumpProductStockLevel } = await import('../server/productBranchInventory.js');
const { acknowledgePurchasePaymentCashierAck } = await import('../server/finance/purchasePaymentCashierAckOps.js');
const { createInvestigationCase } = await import('../server/office/investigationOps.js');

const PO = 'PO-KD-26-0086';
const LINE = 'L1790947652275-0-6ee8';
const P020 = 'STONE-single-red-patch-black-0.20mm';
const P024 = 'STONE-single-red-patch-black-0.24mm';
const RESET_MV = 'MV-26-00704';
const actor = { id: null, name: 'ops-script', displayName: 'ops-script' };
const invActor = { id: 'USR-ADMIN', roleKey: 'admin', permissions: ['*'], displayName: 'ops-script' };

const cfg = mysqlConfigFromEnv();
console.log(`[part5] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)} date=${DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const out = { date: DATE };
const stoneLevel = () =>
  Number(db.prepare(`SELECT stock_level FROM products WHERE product_id = ? AND branch_id = ?`).get(P024, BRANCH)?.stock_level);

try {
  assertPeriodOpen(db, DATE, '12 Oct corrections');
  const problems = [];
  const line = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ? AND line_key = ?`).get(PO, LINE);
  if (line?.product_id !== P020 || Number(line?.qty_received) !== 0 || Number(line?.qty_ordered) !== 423) problems.push('PO-0086 line not as previewed');
  const po = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get(PO);
  if (po?.status !== 'Approved') problems.push(`PO status ${po?.status}`);
  const reset = db.prepare(`SELECT * FROM stock_movements WHERE id = ?`).get(RESET_MV);
  if (reset?.product_id !== P024 || Number(reset?.qty) !== 423 || Number(reset?.value_ngn) !== 1861200) problems.push('reset MV not as previewed');
  if (stoneLevel() !== 0) problems.push(`0.24 stock_level ${stoneLevel()} ≠ 0`);
  const ack = db.prepare(`SELECT status FROM purchase_payment_cashier_acks WHERE ack_id = 'PPCA-MUR0AUOI-UAC3'`).get();
  if (ack?.status !== 'Pending') problems.push(`ack ${ack?.status}`);
  const wi = db.prepare(`SELECT status FROM work_items WHERE id = 'WI-KD-26-2467'`).get();
  if (wi?.status !== 'open') problems.push(`WI ${wi?.status}`);
  const dupCase = db.prepare(`SELECT id FROM investigation_cases WHERE title LIKE '%RAMATU HUSSAINI JALLO%'`).get();
  if (dupCase) problems.push(`case exists ${dupCase.id}`);
  const cogsDup = db.prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'DIRECT_DELIVERY_COGS_GL' AND source_id = ?`).get(`${PO}:PRO-KD-26-1279`);
  if (cogsDup) problems.push(`COGS journal exists ${cogsDup.id}`);
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part5] pre-checks OK');
  if (DRY) process.exit(0);

  // 1a — line gauge/product
  db.transaction(() => {
    db.prepare(
      `UPDATE purchase_order_lines SET product_id = ?, gauge = '0.24mm', product_name = 'Stone coated Single / Red patch black / 0.24mm' WHERE po_id = ? AND line_key = ?`
    ).run(P024, PO, LINE);
    appendAuditLog(db, {
      actor: null,
      action: 'purchase_order.line_spec_correct',
      entityKind: 'purchase_order',
      entityId: PO,
      note: 'Line 1 gauge 0.20 → 0.24 (matches QT-KD-26-1577 and ₦6,700 price)',
      details: { lineKey: LINE, previous: { productId: P020, gauge: '0.20mm' }, next: { productId: P024, gauge: '0.24mm' } },
    });
  })();
  console.log('[1a] line → 0.24');

  // 1b — receipt
  const g = confirmGrn(
    db,
    PO,
    [{ lineKey: LINE, productID: P024, qtyReceived: 423, receivedAtISO: DATE, location: 'Direct to site – Abu Ahmed Islamiya (QT-KD-26-1577)' }],
    undefined,
    undefined,
    BRANCH,
    { actor }
  );
  if (!g.ok) throw new Error(`GRN: ${g.error}`);
  const grnMv = db.prepare(`SELECT id, qty, value_ngn FROM stock_movements WHERE ref = ? AND type = 'STORE_GRN_STONE'`).get(PO);
  const grnJe = db.prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'STONE_GRN' AND source_id = ?`).get(`ST-${PO}-${LINE}`);
  out.grn = { movementId: grnMv?.id, qty: grnMv?.qty, valueNgn: grnMv?.value_ngn, glJournalId: grnJe?.id, poStatus: db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get(PO)?.status };
  console.log(`[1b] ${grnMv?.id} +${grnMv?.qty} m ₦${grnMv?.value_ngn} / ${grnJe?.id}; PO ${out.grn.poStatus}`);

  // 1c + 1d
  const r = db.transaction(() => {
    if (!bumpProductStockLevel(db, P024, BRANCH, -423)) throw new Error('stock bump failed');
    const movementId = nextStockMovementHumanId(db);
    insertStockMovementTx(db, {
      id: movementId,
      atISO: `${DATE}T12:00:00`,
      type: 'ADJUSTMENT',
      productID: P024,
      qty: -423,
      ref: RESET_MV,
      dateISO: DATE,
      branchId: BRANCH,
      unitPriceNgn: 4400,
      valueNgn: 1861200,
      detail: 'Reset +423 m was Banbo direct delivery – now received on PO-KD-26-0086',
    });
    const v = tryPostInventoryVarianceJournal(db, {
      entryDateISO: DATE,
      amountNgn: 1861200,
      direction: 'shortage',
      branchId: BRANCH,
      createdByUserId: null,
      sourceId: movementId,
      memo: `Reverse 8 Oct reset ${RESET_MV} (+423 m) – Banbo direct delivery received on ${PO}`,
      sourceKind: 'INVENTORY_VARIANCE_GL',
    });
    if (!v.ok || v.skipped) throw new Error(v.error || 'variance GL skipped');
    const c = postBalancedJournalTx(db, {
      entryDateISO: DATE,
      memo: `Cost of sale – 423 m Single Red patch black 0.24 delivered direct to site (QT-KD-26-1577, PRO-KD-26-1279; ${PO})`,
      sourceKind: 'DIRECT_DELIVERY_COGS_GL',
      sourceId: `${PO}:PRO-KD-26-1279`,
      branchId: BRANCH,
      createdByUserId: null,
      lines: [
        { accountCode: '5000', debitNgn: 2834100, memo: 'QT-KD-26-1577' },
        { accountCode: '1300', creditNgn: 2834100, memo: PO },
      ],
    });
    if (!c.ok || c.skipped) throw new Error(c.error || 'COGS GL skipped');
    appendAuditLog(db, {
      actor: null,
      action: 'stone.direct_delivery_match',
      entityKind: 'purchase_order',
      entityId: PO,
      note: 'Banbo 423 m delivered direct to Abu Ahmed Islamiya (QT-KD-26-1577); reset reversed; cost of sale posted',
      details: { reverseMovementId: movementId, varianceJournalId: v.journalId, cogsJournalId: c.journalId, resetMovementId: RESET_MV },
    });
    return { movementId, varianceJournalId: v.journalId, cogsJournalId: c.journalId };
  })();
  out.reset = r;
  console.log(`[1c] ${r.movementId} / ${r.varianceJournalId}; [1d] ${r.cogsJournalId}; 0.24 stock now ${stoneLevel()}`);

  // 1e
  const a = acknowledgePurchasePaymentCashierAck(db, 'PPCA-MUR0AUOI-UAC3', {
    actor,
    note: 'Moniepoint 16 Sep 16:10, ₦2,834,100 to BINGTUAN LIN, Access Bank',
    workspaceBranchId: BRANCH,
  });
  if (!a.ok) throw new Error(`ack: ${a.error}`);
  console.log('[1e] ack done');

  // 3 — supplier bank + WI close + quote note
  db.transaction(() => {
    const s = db.prepare(`SELECT supplier_profile_json FROM suppliers WHERE supplier_id = 'SUP-020'`).get();
    const prof = JSON.parse(s.supplier_profile_json || '{}');
    prof.bankAccounts = Array.isArray(prof.bankAccounts) ? prof.bankAccounts : [];
    if (!prof.bankAccounts.some((b) => String(b.accountNumber) === '1217150953')) {
      prof.bankAccounts.push({ bankName: 'Zenith Bank', accountName: 'E. BEST ALUMINIUM LTD', accountNumber: '1217150953', sortCode: '', currency: 'NGN' });
    }
    db.prepare(`UPDATE suppliers SET supplier_profile_json = ? WHERE supplier_id = 'SUP-020'`).run(JSON.stringify(prof));
    appendAuditLog(db, { actor: null, action: 'supplier.bank_account_add', entityKind: 'supplier', entityId: 'SUP-020', note: 'Zenith 1217150953 E. BEST ALUMINIUM LTD (bank-confirmed PO-KD-26-0077 payments 11 Sep)' });

    const now = new Date().toISOString();
    db.prepare(`UPDATE work_items SET status = 'closed', closed_at_iso = ?, updated_at_iso = ?, key_decision_summary = ? WHERE id = 'WI-KD-26-2467' AND status = 'open'`).run(
      now, now, 'Coil 2205 = store-book 2099, IB 0.55, 71 kg – resolved 12 Oct'
    );
    appendAuditLog(db, { actor: null, action: 'work_item.close', entityKind: 'work_item', entityId: 'WI-KD-26-2467', note: 'Coil 2205 = store-book 2099, IB 0.55, 71 kg – resolved 12 Oct' });

    db.prepare(`UPDATE quotations SET quotation_lifecycle_note = ? WHERE id = 'QT-KD-26-1577'`).run(
      '2 stone-nail packs still owed to customer (7 quoted, 5 issued on PRO-KD-26-1279) – 12 Oct 2026'
    );
    appendAuditLog(db, { actor: null, action: 'quotation.note', entityKind: 'quotation', entityId: 'QT-KD-26-1577', note: '2 stone-nail packs still owed to customer' });
  })();
  console.log('[3] SUP-020 bank added; WI-KD-26-2467 closed; QT-1577 note');

  // 4 — investigation case
  const inv = createInvestigationCase(
    db,
    {
      title: 'Moniepoint 4 Sep ₦6,075,420 to RAMATU HUSSAINI JALLO, TAJ *****44615 – not in ERP',
      caseType: 'unknown_payment',
      amountAtRiskNgn: 6075420,
      branchId: BRANCH,
      ownerUserId: 'USR-ADMIN',
      reviewDate: '2026-10-19',
      note: 'Moniepoint 6432680767 debit 4 Sep 2026 12:56. No ERP treasury movement, refund or payment request. Not linked to customer CUS-KD-26-0578 Hussaini Jalo (his bank: OPay 8166668484). OM to identify.',
    },
    invActor
  );
  if (!inv?.ok && !inv?.case && !inv?.id) throw new Error(`case: ${inv?.error || JSON.stringify(inv).slice(0, 200)}`);
  out.caseId = inv?.case?.id || inv?.id;
  console.log(`[4] case ${out.caseId}`);

  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part5-post-result.json'), JSON.stringify(out, null, 2));
} catch (e) {
  console.error('[part5] FAILED', e?.message || e);
  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part5-post-partial.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  db.close?.();
}
