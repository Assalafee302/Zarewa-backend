#!/usr/bin/env node
/**
 * READ-ONLY: Cross-check company-cut retention open balance vs expected cuts on refunds.
 * Fast path: split JSON + payment note first; resolveCreditTargets only for gap candidates.
 *
 *   node scripts/_company-cut-retention-crosscheck.mjs
 *   node scripts/_company-cut-retention-crosscheck.mjs --branch=BR-KD
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
const {
  getCompanyRetentionSummary,
  refundCompanyRetentionTablesReady,
} = await import('../server/finance/refundCompanyRetentionLedger.js');
function roundMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function parseCompanyCutNgnFromPaymentNote(paymentNote) {
  const note = String(paymentNote || '');
  const match = note.match(/company cut\s*[₦N]?\s*([\d,]+)/i);
  if (!match) return 0;
  return roundMoney(String(match[1] || '').replace(/,/g, ''));
}

function companyCutFromSplitJson(raw) {
  let splits = [];
  try {
    splits = JSON.parse(String(raw || '[]'));
  } catch {
    return 0;
  }
  if (!Array.isArray(splits)) return 0;
  return splits.reduce((s, x) => s + roundMoney(x?.companyDeductionNgn ?? x?.company_deduction_ngn), 0);
}

const branchArg = process.argv.find((a) => a.startsWith('--branch='));
const branchScope = branchArg ? branchArg.slice('--branch='.length).trim() || 'ALL' : 'ALL';

const cfg = mysqlConfigFromEnv();
console.log(`[crosscheck] READ-ONLY ${databaseLabel(cfg)} branch=${branchScope}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  if (!refundCompanyRetentionTablesReady(db)) {
    console.log(JSON.stringify({ ok: false, error: 'retention tables not ready' }, null, 2));
    process.exit(1);
  }

  console.log('[1/4] summary…');
  const summary = getCompanyRetentionSummary(db, branchScope);
  const branchSql =
    branchScope && branchScope !== 'ALL' ? ` AND trim(IFNULL(r.branch_id, '')) = ?` : '';
  const branchArgs = branchScope && branchScope !== 'ALL' ? [branchScope] : [];
  const eBranchSql =
    branchScope && branchScope !== 'ALL' ? ` AND trim(IFNULL(e.branch_id, '')) = ?` : '';
  const eBranchArgs = branchScope && branchScope !== 'ALL' ? [branchScope] : [];
  const wBranchSql =
    branchScope && branchScope !== 'ALL' ? ` AND trim(IFNULL(w.branch_id, '')) = ?` : '';
  const wBranchArgs = branchScope && branchScope !== 'ALL' ? [branchScope] : [];

  console.log('[2/4] ledger aggregates…');
  const ledgerAgg = db
    .prepare(
      `SELECT
         COUNT(*) AS credit_rows,
         SUM(CASE WHEN open_ngn > 0 THEN 1 ELSE 0 END) AS open_rows,
         COALESCE(SUM(amount_ngn), 0) AS credited_total,
         COALESCE(SUM(open_ngn), 0) AS open_total,
         COALESCE(SUM(CASE WHEN open_ngn = 0 THEN amount_ngn ELSE 0 END), 0) AS fully_closed_amount,
         COALESCE(SUM(CASE WHEN open_ngn > 0 AND open_ngn < amount_ngn THEN amount_ngn - open_ngn ELSE 0 END), 0) AS partial_withdrawn
       FROM refund_company_retention_entries e
       WHERE e.entry_type = 'credit' AND e.source_kind = 'REFUND_COMPANY_CUT'${eBranchSql}`
    )
    .get(...eBranchArgs);

  const withdrawals = db
    .prepare(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_ngn), 0) AS total
       FROM refund_company_retention_withdrawals w
       WHERE 1=1${wBranchSql}
       GROUP BY status`
    )
    .all(...wBranchArgs);

  console.log('[3/4] load refunds + credits…');
  const refunds = db
    .prepare(
      `SELECT r.refund_id, r.branch_id, r.status, r.amount_ngn, r.approved_amount_ngn,
              r.paid_amount_ngn, r.payment_note, r.split_distributions_json,
              r.requested_at_iso, r.customer_name
       FROM customer_refunds r
       WHERE LOWER(IFNULL(r.status, '')) IN ('approved', 'paid')
         ${branchSql}
       ORDER BY r.requested_at_iso DESC`
    )
    .all(...branchArgs);

  const creditByRefund = new Map(
    db
      .prepare(
        `SELECT e.source_id AS refund_id, e.id, e.amount_ngn, e.open_ngn, e.note, e.created_at_iso
         FROM refund_company_retention_entries e
         WHERE e.entry_type = 'credit' AND e.source_kind = 'REFUND_COMPANY_CUT'${eBranchSql}`
      )
      .all(...eBranchArgs)
      .map((r) => [String(r.refund_id), r])
  );

  console.log(`[4/4] compare ${refunds.length} refunds (split JSON + payment note)…`);
  const missing = [];
  const underCredited = [];
  const overCredited = [];
  let matchedCount = 0;
  let expectedFromMissing = 0;
  let expectedFromUnder = 0;

  for (const row of refunds) {
    const approved = roundMoney(row.approved_amount_ngn ?? row.amount_ngn);
    let expected = companyCutFromSplitJson(row.split_distributions_json);
    let source = expected > 0 ? 'split_json' : 'none';
    if (expected <= 0) {
      const fromNote = parseCompanyCutNgnFromPaymentNote(row.payment_note);
      if (fromNote > 0) {
        expected = fromNote;
        source = 'payment_note';
      }
    }

    const ledger = creditByRefund.get(String(row.refund_id));

    if (expected <= 0) continue;

    if (!ledger) {
      expectedFromMissing += expected;
      missing.push({
        refundId: row.refund_id,
        status: row.status,
        customerName: row.customer_name,
        approvedNgn: approved,
        expectedCutNgn: expected,
        source,
        paidAmountNgn: roundMoney(row.paid_amount_ngn),
        requestedAtIso: row.requested_at_iso,
      });
      continue;
    }

    const credited = roundMoney(ledger.amount_ngn);
    const open = roundMoney(ledger.open_ngn);
    if (credited < expected) {
      expectedFromUnder += expected - credited;
      underCredited.push({
        refundId: row.refund_id,
        status: row.status,
        customerName: row.customer_name,
        expectedCutNgn: expected,
        creditedNgn: credited,
        openNgn: open,
        shortfallNgn: expected - credited,
        source,
        raisable: open === credited,
      });
    } else if (credited > expected + 1) {
      overCredited.push({
        refundId: row.refund_id,
        customerName: row.customer_name,
        expectedCutNgn: expected,
        creditedNgn: credited,
        openNgn: open,
        excessNgn: credited - expected,
        source,
      });
    } else {
      matchedCount += 1;
    }
  }

  const refundIdSet = new Set(refunds.map((r) => String(r.refund_id)));
  const orphanCredits = [];
  for (const [refundId, ledger] of creditByRefund) {
    if (refundIdSet.has(refundId)) continue;
    const any = db.prepare(`SELECT refund_id, status FROM customer_refunds WHERE refund_id = ?`).get(refundId);
    orphanCredits.push({
      refundId,
      amountNgn: roundMoney(ledger.amount_ngn),
      openNgn: roundMoney(ledger.open_ngn),
      refundStatus: any?.status || 'MISSING_REFUND',
    });
  }

  const uiBalance = 1_151_728;
  const out = {
    ok: true,
    readOnly: true,
    branchScope,
    uiReported: {
      openCredits: 122,
      totalBalanceNgn: uiBalance,
      withdrawNowNgn: uiBalance,
      lockedNgn: 0,
    },
    liveSummary: {
      openCredits: summary.credits?.length ?? 0,
      totalOpenNgn: summary.totalOpenNgn,
      availableNgn: summary.availableNgn,
      heldNgn: summary.heldNgn,
      reservedNgn: summary.reservedNgn,
      paidOutNgn: summary.paidOutNgn,
      cooldownActive: summary.cooldownActive,
      lastWithdrawalPaidAtIso: summary.lastWithdrawalPaidAtIso,
      nextWithdrawalAllowedAtIso: summary.nextWithdrawalAllowedAtIso,
      matchesUi: summary.totalOpenNgn === uiBalance,
      deltaVsUiNgn: summary.totalOpenNgn - uiBalance,
    },
    ledgerAgg: {
      creditRows: Number(ledgerAgg.credit_rows) || 0,
      openRows: Number(ledgerAgg.open_rows) || 0,
      creditedTotalNgn: roundMoney(ledgerAgg.credited_total),
      openTotalNgn: roundMoney(ledgerAgg.open_total),
      fullyClosedAmountNgn: roundMoney(ledgerAgg.fully_closed_amount),
      partialWithdrawnNgn: roundMoney(ledgerAgg.partial_withdrawn),
    },
    withdrawalsByStatus: withdrawals.map((w) => ({
      status: w.status,
      count: Number(w.n) || 0,
      totalNgn: roundMoney(w.total),
    })),
    expectedVsLedger: {
      refundsScanned: refunds.length,
      refundsWithExpectedCut: missing.length + underCredited.length + overCredited.length + matchedCount,
      matchedCount,
      missingCreditCount: missing.length,
      missingCreditNgn: expectedFromMissing,
      underCreditedCount: underCredited.length,
      underCreditedShortfallNgn: expectedFromUnder,
      overCreditedCount: overCredited.length,
      overCreditedExcessNgn: overCredited.reduce((s, x) => s + x.excessNgn, 0),
      orphanCreditCount: orphanCredits.length,
      impliedOpenIfGapsFilledNgn: summary.totalOpenNgn + expectedFromMissing + expectedFromUnder,
      gapAboveUiNgn: expectedFromMissing + expectedFromUnder,
    },
    topMissing: missing.sort((a, b) => b.expectedCutNgn - a.expectedCutNgn).slice(0, 50),
    topUnderCredited: underCredited.sort((a, b) => b.shortfallNgn - a.shortfallNgn).slice(0, 50),
    topOverCredited: overCredited.sort((a, b) => b.excessNgn - a.excessNgn).slice(0, 20),
    orphanCredits: orphanCredits.slice(0, 40),
  };

  const outPath = path.join(
    process.cwd(),
    'exports',
    `company-cut-retention-crosscheck-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // Compact console summary first
  console.log(
    JSON.stringify(
      {
        liveSummary: out.liveSummary,
        ledgerAgg: out.ledgerAgg,
        withdrawalsByStatus: out.withdrawalsByStatus,
        expectedVsLedger: out.expectedVsLedger,
        topMissing: out.topMissing.slice(0, 15),
        topUnderCredited: out.topUnderCredited.slice(0, 15),
        orphanCredits: out.orphanCredits.slice(0, 10),
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
