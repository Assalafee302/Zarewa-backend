#!/usr/bin/env node
/**
 * POST: Backfill missing company-cut retention credit for RF-KD-26-9737 (Aminu Ibrahim).
 * Payment note already records: company cut ₦8,738 → retention ledger (row was never inserted).
 *
 *   node scripts/_aminu-9737-retention-credit-post.mjs           # preview
 *   node scripts/_aminu-9737-retention-credit-post.mjs --post    # apply
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
Object.assign(process.env, {
  ZAREWA_MYSQL_HOST: env.ZAREWA_MYSQL_HOST,
  ZAREWA_MYSQL_PORT: env.ZAREWA_MYSQL_PORT || '3306',
  ZAREWA_MYSQL_USER: env.ZAREWA_MYSQL_USER,
  ZAREWA_MYSQL_PASSWORD: env.ZAREWA_MYSQL_PASSWORD || '',
  ZAREWA_MYSQL_DATABASE: env.ZAREWA_MYSQL_DATABASE,
  ZAREWA_ALLOW_PROD_MYSQL_SCRIPT: '1',
});

const DO_POST = process.argv.includes('--post');
const REFUND_ID = 'RF-KD-26-9737';
const BRANCH = 'BR-KD';
const EXPECTED_CUT = 8738;

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const {
  creditCompanyRetentionFromRefundTx,
  getCompanyRetentionSummary,
} = await import('../server/finance/refundCompanyRetentionLedger.js');

function roundMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function cutFromNote(note) {
  const m = String(note || '').match(/company cut\s*[₦N]?\s*([\d,]+)/i);
  return m ? roundMoney(String(m[1]).replace(/,/g, '')) : 0;
}

function cutFromSplits(raw) {
  try {
    const splits = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(splits)) return 0;
    return splits.reduce((s, x) => s + roundMoney(x?.companyDeductionNgn), 0);
  } catch {
    return 0;
  }
}

const cfg = mysqlConfigFromEnv();
console.log(`[${DO_POST ? 'post' : 'preview'}] ${databaseLabel(cfg)} ${REFUND_ID}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const beforeSummary = getCompanyRetentionSummary(db, BRANCH);
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(REFUND_ID);
  if (!row) throw new Error(`Refund ${REFUND_ID} not found.`);
  if (String(row.branch_id || '').trim() !== BRANCH) {
    throw new Error(`Refund branch ${row.branch_id} ≠ ${BRANCH}.`);
  }

  const existing = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn, note FROM refund_company_retention_entries
       WHERE entry_type = 'credit' AND source_kind = 'REFUND_COMPANY_CUT' AND source_id = ?`
    )
    .get(REFUND_ID);

  const fromNote = cutFromNote(row.payment_note);
  const fromSplits = cutFromSplits(row.split_distributions_json);
  const amountNgn = fromNote || fromSplits || EXPECTED_CUT;

  const preview = {
    ok: true,
    readOnly: !DO_POST,
    refundId: REFUND_ID,
    status: row.status,
    customerName: row.customer_name,
    approvedNgn: roundMoney(row.approved_amount_ngn ?? row.amount_ngn),
    paidNgn: roundMoney(row.paid_amount_ngn),
    paymentNoteSlice: String(row.payment_note || '').slice(0, 180),
    cutFromNote: fromNote,
    cutFromSplits: fromSplits,
    amountToCreditNgn: amountNgn,
    existingLedger: existing || null,
    openBeforeNgn: beforeSummary.totalOpenNgn,
    openCreditsBefore: beforeSummary.credits.length,
    impliedOpenAfterNgn: beforeSummary.totalOpenNgn + (existing ? 0 : amountNgn),
  };

  if (existing?.id) {
    console.log(JSON.stringify({ ...preview, skipped: true, reason: 'already_credited' }, null, 2));
    process.exit(0);
  }
  if (amountNgn !== EXPECTED_CUT) {
    throw new Error(`Abort: cut ${amountNgn} ≠ expected ${EXPECTED_CUT}. Re-check.`);
  }
  if (!/company cut/i.test(String(row.payment_note || ''))) {
    throw new Error('Abort: payment note does not mention company cut.');
  }

  if (!DO_POST) {
    console.log(JSON.stringify(preview, null, 2));
    console.log('\nRe-run with --post to credit retention.');
    process.exit(0);
  }

  const actor = { id: null, name: 'System · retention backfill Aminu RF-KD-26-9737' };
  const posted = db.transaction(() =>
    creditCompanyRetentionFromRefundTx(db, {
      refundId: REFUND_ID,
      branchId: BRANCH,
      amountNgn,
      actor,
      note: `Company cut ₦${amountNgn.toLocaleString('en-NG')} from refund ${REFUND_ID} (backfill — payment note already settled cut at approval)`,
    })
  )();

  if (!posted?.ok || posted?.skipped) {
    throw new Error(`Credit failed: ${JSON.stringify(posted)}`);
  }

  const afterSummary = getCompanyRetentionSummary(db, BRANCH);
  const ledger = db
    .prepare(
      `SELECT id, amount_ngn, open_ngn, note, created_at_iso FROM refund_company_retention_entries
       WHERE entry_type = 'credit' AND source_kind = 'REFUND_COMPANY_CUT' AND source_id = ?`
    )
    .get(REFUND_ID);

  const out = {
    ...preview,
    posted: true,
    creditResult: posted,
    ledger,
    openAfterNgn: afterSummary.totalOpenNgn,
    availableAfterNgn: afterSummary.availableNgn,
    openCreditsAfter: afterSummary.credits.length,
  };

  const outPath = path.join(
    process.cwd(),
    'exports',
    `aminu-9737-retention-credit-post-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log(`\n[wrote] ${outPath}`);
} finally {
  try {
    db.close?.();
  } catch {
    /* ignore */
  }
}
