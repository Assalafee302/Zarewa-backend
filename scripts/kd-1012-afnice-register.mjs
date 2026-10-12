#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — AFNICE ₦20,000,000 pass-through (OM-approved). Posts NOTHING financial.
 * - Creates the explained-items register (if missing) and one Locked record.
 * - Marks Moniepoint (treasury 4) Sept statement lines 260, 263, 268, 293, 323 as Excluded and links them.
 * - Links TM-KD-26-2489 (receipt unchanged).
 * Usage: node scripts/kd-1012-afnice-register.mjs [--dry]
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
for (const k of Object.keys(env)) process.env[k] = env[k];
process.env.ZAREWA_MYSQL_PORT ||= '3306';
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const DRY = process.argv.includes('--dry');
const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { appendAuditLog } = await import('../server/controlOps.js');
const { bankLineFingerprint, createExplainedItem, ensureExplainedItemsSchema, loadExplainedIndex, lockedItemFor } =
  await import('../server/finance/explainedItemsOps.js');
const { syncFinanceBankReconExceptionWorkItem } = await import('../server/financeWorkItems.js');

const MONIEPOINT = 4;
const STATEMENT_LINES = [
  { n: 260, date: '2026-09-09', amt: 20000000 },
  { n: 263, date: '2026-09-09', amt: -2800020 },
  { n: 268, date: '2026-09-09', amt: -200020 },
  { n: 293, date: '2026-09-10', amt: -8000020 },
  { n: 323, date: '2026-09-11', amt: -4000020 },
];
const EXPLANATION =
  'On 9 Sep 2026 ₦20,000,000 was received on Moniepoint 6432680767 from AFNICE FURNITURES AND ELECTRONIC. ' +
  'It was fully applied the same week: ₦5,000,000 recorded as Qs Isa receipt TM-KD-26-2489; ' +
  '₦8,000,000 to Abdulrahman Abubakar Salisu (Jaiz, 10 Sep); ₦4,000,000 to Abdulrahman Uthman Sali (OPay, 11 Sep); ' +
  '₦2,800,000 to Boniface Ojochegbe Ogwu (Stanbic, 9 Sep); ₦200,000 to Auwal Abubakar (OPay, 9 Sep). ' +
  'Total ₦20,000,000 plus ₦80 transfer fees. Cleared and approved by the Operations Manager on 12 Oct 2026. ' +
  'Not a sale, purchase, refund or company expense; intentionally not posted in the ERP.';

const cfg = mysqlConfigFromEnv();
console.log(`[afnice] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const preview = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'exports', 'MONIEPOINT-Sep2026-recon-import-preview.json'), 'utf8')
  ).lines;
  const recon = [];
  for (const s of STATEMENT_LINES) {
    const p = preview.find((l) => l.line === s.n);
    if (!p || p.bankDateISO !== s.date || Math.round(p.amountStatement) !== Math.round(s.amt)) {
      throw new Error(`Preview line ${s.n} does not match ${s.date} ${s.amt}`);
    }
    const row = db
      .prepare(
        `SELECT id, bank_date_iso, amount_ngn, description, status FROM bank_reconciliation_lines
         WHERE treasury_account_id = ? AND bank_date_iso = ? AND amount_ngn = ? AND description = ?`
      )
      .get(MONIEPOINT, s.date, Math.round(s.amt), p.description);
    if (!row) throw new Error(`Moniepoint recon line ${s.n} not found — has the September import committed?`);
    recon.push({ ...s, id: row.id, status: row.status, description: p.description });
  }
  const tm = db.prepare(`SELECT id, amount_ngn FROM treasury_movements WHERE id = 'TM-KD-26-2489'`).get();
  if (Math.round(Number(tm?.amount_ngn)) !== 5000000) throw new Error('TM-KD-26-2489 not ₦5,000,000');
  ensureExplainedItemsSchema(db);
  const already = lockedItemFor(loadExplainedIndex(db), 'treasury_movement', 'TM-KD-26-2489');
  if (already) throw new Error(`Already registered as ${already.id}`);
  console.log('[afnice] pre-checks OK', recon.map((r) => `${r.n}=${r.id}`).join(' '));
  if (DRY) process.exit(0);

  let itemId = null;
  db.transaction(() => {
    const r = createExplainedItem(
      db,
      {
        branchId: 'BR-KD',
        title: 'AFNICE ₦20,000,000 pass-through – September 2026',
        shortLabel: 'AFNICE ₦20M',
        explanation: EXPLANATION,
        amountInNgn: 20000000,
        amountOutNgn: 20000080,
        treasuryAccountId: MONIEPOINT,
        bankAccountLabel: 'Moniepoint 6432680767',
        periodKey: '2026-09',
        approvedByName: 'Abdulrahman Uthman Sali (OM)',
        approvedAtISO: '2026-10-12T12:00:00.000Z',
        status: 'Locked',
        links: [
          ...recon.map((l) => ({
            entityType: 'bank_recon_line',
            entityId: l.id,
            fingerprint: bankLineFingerprint(l.date, l.amt, l.description),
            note: `Moniepoint statement line ${l.n}`,
          })),
          { entityType: 'treasury_movement', entityId: 'TM-KD-26-2489', note: 'Qs Isa receipt ₦5,000,000 (unchanged)' },
        ],
        alreadyInTransaction: true,
      },
      { displayName: 'ops-script' }
    );
    if (!r.ok) throw new Error(r.error);
    itemId = r.id;
    const upd = db.prepare(`UPDATE bank_reconciliation_lines SET status = 'Excluded', system_match = ? WHERE id = ?`);
    for (const l of recon) {
      upd.run(`EXPLAINED:${itemId} · Explained – excluded (AFNICE ₦20M pass-through)`, l.id);
      appendAuditLog(db, {
        actor: null,
        action: 'bank_reconciliation.explained_exclude',
        entityKind: 'bank_reconciliation_line',
        entityId: l.id,
        note: `Explained – excluded · ${itemId}`,
        details: { previousStatus: l.status, statementLine: l.n },
      });
    }
  })();
  try {
    syncFinanceBankReconExceptionWorkItem(db, 'BR-KD', null);
  } catch (e) {
    console.error('work item sync (non-fatal):', e?.message || e);
  }
  console.log(`[afnice] register ${itemId}; excluded ${recon.map((l) => l.id).join(', ')}`);
} catch (e) {
  console.error('[afnice] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
