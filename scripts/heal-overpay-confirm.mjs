/**
 * Heal live + scan similar bank-confirmed receipts that should have used overpay credit.
 *
 *   node scripts/heal-overpay-confirm.mjs --dry-run
 *   node scripts/heal-overpay-confirm.mjs --apply
 *   node scripts/heal-overpay-confirm.mjs --apply --receipt=LE-KD-26-1797
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../server/loadProjectEnv.js';

loadProjectEnv();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const localEnv = path.join(root, '.env.local');
const apply = process.argv.includes('--apply');
const dryRun = !apply;
const receiptArg = process.argv.find((a) => a.startsWith('--receipt='));
const receiptId = receiptArg ? receiptArg.slice('--receipt='.length).trim() : '';

function loadHostingerFromLocalComments() {
  if (!fs.existsSync(localEnv)) return;
  const raw = fs.readFileSync(localEnv, 'utf8');
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(
      /^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/
    );
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map[m[1]] = v;
  }
  if (map.ZAREWA_MYSQL_HOST) {
    process.env.ZAREWA_LOCAL_XAMPP = '0';
    Object.assign(process.env, map);
  }
}

loadHostingerFromLocalComments();

const { openConfiguredMysql } = await import('../server/cliMysql.js');
const {
  listReceiptsNeedingOverpayConfirmHeal,
  healReceiptOverpayConfirmTx,
  healReceiptsNeedingOverpayConfirm,
} = await import('../server/sales/receiptOverpayConfirmHeal.js');
const { patchSalesReceiptFinanceSettlement } = await import('../server/writeOps.js');

const { db, label } = openConfiguredMysql({ migrate: false });

function resolveActor() {
  const row =
    db
      .prepare(
        `SELECT id, username, display_name, role_key FROM app_users
         WHERE id = 'USR-ADMIN'
            OR (role_key IN ('admin', 'md', 'finance_officer') AND COALESCE(status,'active') IN ('active',''))
         ORDER BY CASE WHEN id = 'USR-ADMIN' THEN 0 ELSE 1 END, id
         LIMIT 1`
      )
      .get() || null;
  if (!row) {
    return { id: null, name: 'System', roleKey: 'system' };
  }
  return {
    id: row.id,
    name: row.display_name || row.username || row.id,
    displayName: row.display_name || row.username || row.id,
    roleKey: row.role_key || 'admin',
  };
}

const actor = resolveActor();

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

try {
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', db: label(), receiptId: receiptId || null, actor: { id: actor.id, name: actor.name } }));

  if (receiptId) {
    const row = db.prepare(`SELECT status, bank_received_amount_ngn, finance_reconciliation_saved_at_iso, finance_delivery_cleared_at_iso, amount_ngn FROM sales_receipts WHERE id = ?`).get(receiptId);
    // If a prior heal unconfirmed but failed audit/settle, finish settle only.
    const pending =
      row &&
      String(row.status || '').toLowerCase().includes('pending') &&
      !(row.finance_reconciliation_saved_at_iso && String(row.finance_reconciliation_saved_at_iso).trim());
    if (!dryRun && pending) {
      const settled = patchSalesReceiptFinanceSettlement(
        db,
        receiptId,
        {
          bankReceivedAmountNgn: roundMoney(row.amount_ngn) || roundMoney(row.bank_received_amount_ngn) || 0,
          clearForDelivery: true,
        },
        actor
      );
      console.log(JSON.stringify({ ok: settled.ok, resumedPendingSettle: true, settled }, null, 2));
      if (!settled.ok) process.exit(1);
    } else if (dryRun) {
      const [c] = listReceiptsNeedingOverpayConfirmHeal(db, { receiptIds: [receiptId] });
      console.log(JSON.stringify({ ok: true, dryRun: true, candidate: c || null, receipt: row }, null, 2));
    } else {
      const r = healReceiptOverpayConfirmTx(db, receiptId, actor, { dryRun: false });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exit(1);
    }
  } else {
    const r = healReceiptsNeedingOverpayConfirm(db, actor, {
      dryRun,
      limit: 200,
    });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  }
} finally {
  db.close();
}
