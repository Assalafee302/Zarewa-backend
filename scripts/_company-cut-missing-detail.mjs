#!/usr/bin/env node
/** READ-ONLY: Detail the missing company-cut retention credits found by crosscheck. */
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
const { resolveCreditTargets } = await import('../server/finance/partnerWalletCredit.js');

function roundMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const exportFile = process.argv[2]
  || path.join(process.cwd(), 'exports', 'company-cut-retention-crosscheck-2026-10-10T14-51-10.json');
const cross = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
const missingIds = (cross.topMissing || []).map((x) => x.refundId);
// also pull full missing list if present in file — topMissing may be capped
const allMissingPath = exportFile;
const full = JSON.parse(fs.readFileSync(allMissingPath, 'utf8'));
const ids = [...new Set([...(full.topMissing || []).map((x) => x.refundId), ...missingIds])];

const cfg = mysqlConfigFromEnv();
console.log(`[detail] READ-ONLY ${databaseLabel(cfg)} n=${ids.length}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const details = [];
  for (const id of ids) {
    const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
    if (!row) {
      details.push({ refundId: id, error: 'not found' });
      continue;
    }
    let splits = [];
    try {
      splits = JSON.parse(String(row.split_distributions_json || '[]'));
    } catch {
      splits = [];
    }
    const approved = roundMoney(row.approved_amount_ngn ?? row.amount_ngn);
    const targets = resolveCreditTargets(db, row, approved, { skipUnclearedFloat: true });
    const cutFromTargets = targets.reduce((s, t) => s + roundMoney(t.companyDeductionNgn), 0);
    const cutFromSplits = splits.reduce(
      (s, x) => s + roundMoney(x?.companyDeductionNgn ?? x?.company_deduction_ngn),
      0
    );
    const ledger = db
      .prepare(
        `SELECT id, amount_ngn, open_ngn, note FROM refund_company_retention_entries
         WHERE entry_type='credit' AND source_kind='REFUND_COMPANY_CUT' AND source_id=?`
      )
      .get(id);
    const walletCredits = db
      .prepare(
        `SELECT id, amount_ngn, open_ngn, party_kind, note
         FROM partner_wallet_entries
         WHERE entry_type='credit' AND source_kind='REFUND' AND source_id=?`
      )
      .all(id)
      .map((w) => ({
        id: w.id,
        amountNgn: roundMoney(w.amount_ngn),
        openNgn: roundMoney(w.open_ngn),
        partyKind: w.party_kind,
        note: w.note,
      }));

    const staffSplits = splits.filter((s) =>
      String(s.recipientKind || s.recipient_kind || '')
        .toLowerCase()
        .includes('staff')
    );

    details.push({
      refundId: id,
      status: row.status,
      customerName: row.customer_name,
      approvedNgn: approved,
      paidAmountNgn: roundMoney(row.paid_amount_ngn),
      paymentNote: String(row.payment_note || '').slice(0, 280),
      cutFromSplits,
      cutFromTargets,
      staffSplitCount: staffSplits.length,
      staffSplits: staffSplits.map((s) => ({
        kind: s.recipientKind || s.recipient_kind,
        amountNgn: roundMoney(s.amountNgn ?? s.amount_ngn),
        companyDeductionNgn: roundMoney(s.companyDeductionNgn ?? s.company_deduction_ngn),
        netPayoutNgn: roundMoney(s.netPayoutNgn ?? s.net_payout_ngn),
        waived: Boolean(s.companyCutWaived || s.company_cut_waived || s.waiveCompanyCut),
      })),
      targets: targets.map((t) => ({
        partyKind: t.partyKind,
        amountNgn: roundMoney(t.amountNgn),
        companyDeductionNgn: roundMoney(t.companyDeductionNgn),
        note: String(t.note || '').slice(0, 120),
      })),
      ledger: ledger
        ? { id: ledger.id, amountNgn: roundMoney(ledger.amount_ngn), openNgn: roundMoney(ledger.open_ngn) }
        : null,
      walletCredits,
      /** Heuristic: if paid_amount == approved and cut expected, cut may never have been settled into retention */
      paidEqualsApproved: roundMoney(row.paid_amount_ngn) === approved,
      paidEqualsApprovedMinusCut:
        cutFromTargets > 0 &&
        roundMoney(row.paid_amount_ngn) === Math.max(0, approved - cutFromTargets),
    });
  }

  const shouldCredit = details.filter((d) => !d.ledger && d.cutFromTargets > 0);
  const maybeFalsePositive = details.filter((d) => !d.ledger && d.cutFromTargets <= 0);
  const sumShould = shouldCredit.reduce((s, d) => s + d.cutFromTargets, 0);

  const out = {
    ok: true,
    missingChecked: details.length,
    shouldCreditCount: shouldCredit.length,
    shouldCreditNgn: sumShould,
    impliedOpenIfBackfilled: 1_151_728 + sumShould,
    maybeFalsePositiveCount: maybeFalsePositive.length,
    shouldCredit: shouldCredit.map((d) => ({
      refundId: d.refundId,
      customerName: d.customerName,
      status: d.status,
      cutNgn: d.cutFromTargets,
      paidEqualsApproved: d.paidEqualsApproved,
      paidEqualsApprovedMinusCut: d.paidEqualsApprovedMinusCut,
      paymentNote: d.paymentNote,
      staffSplits: d.staffSplits,
    })),
    details,
  };

  const outPath = path.join(
    process.cwd(),
    'exports',
    `company-cut-missing-detail-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      {
        shouldCreditCount: out.shouldCreditCount,
        shouldCreditNgn: out.shouldCreditNgn,
        impliedOpenIfBackfilled: out.impliedOpenIfBackfilled,
        shouldCredit: out.shouldCredit,
        exportPath: outPath,
      },
      null,
      2
    )
  );
} finally {
  try {
    db.close?.();
  } catch {
    /* ignore */
  }
}
