#!/usr/bin/env node
/**
 * READ-ONLY: Verify company-cut retention balance without resolveCreditTargets.
 * Uses split JSON, payment notes, and ledger only.
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

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import(
  '../server/mysqlDatabase.js'
);
const { getCompanyRetentionSummary } = await import(
  '../server/finance/refundCompanyRetentionLedger.js'
);

function roundMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseCutFromNote(note) {
  const m = String(note || '').match(/company cut\s*[₦N]?\s*([\d,]+)/i);
  return m ? roundMoney(String(m[1]).replace(/,/g, '')) : 0;
}

function parseSplits(raw) {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function cutFromSplits(splits) {
  return splits.reduce((s, x) => s + roundMoney(x?.companyDeductionNgn ?? x?.company_deduction_ngn), 0);
}

const cfg = mysqlConfigFromEnv();
console.log(`[verify] READ-ONLY ${databaseLabel(cfg)} BR-KD`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });

try {
  const summary = getCompanyRetentionSummary(db, 'BR-KD');

  const refunds = db
    .prepare(
      `SELECT refund_id, status, amount_ngn, approved_amount_ngn, paid_amount_ngn,
              payment_note, split_distributions_json, customer_name, requested_at_iso, reason_category
       FROM customer_refunds
       WHERE trim(IFNULL(branch_id,'')) = 'BR-KD'
         AND LOWER(IFNULL(status,'')) IN ('approved','paid','partially paid')`
    )
    .all();

  const credits = db
    .prepare(
      `SELECT source_id AS refund_id, id, amount_ngn, open_ngn, note, created_at_iso
       FROM refund_company_retention_entries
       WHERE entry_type='credit' AND source_kind='REFUND_COMPANY_CUT'
         AND trim(IFNULL(branch_id,'')) = 'BR-KD'`
    )
    .all();
  const creditByRefund = new Map(credits.map((c) => [String(c.refund_id), c]));

  const releasedOrVoided = credits.filter((c) => {
    const note = String(c.note || '').toLowerCase();
    return (
      roundMoney(c.open_ngn) === 0 &&
      (note.includes('voided') ||
        note.includes('released') ||
        note.includes('return') ||
        note.includes('customer'))
    );
  });

  const missing = [];
  const under = [];
  const matchedWithCut = [];
  let expectedOpenAdd = 0;

  for (const row of refunds) {
    const splits = parseSplits(row.split_distributions_json);
    let expected = cutFromSplits(splits);
    let source = expected > 0 ? 'split_json' : 'none';
    if (expected <= 0) {
      const n = parseCutFromNote(row.payment_note);
      if (n > 0) {
        expected = n;
        source = 'payment_note';
      }
    }
    if (expected <= 0) continue;

    const kinds = [...new Set(splits.map((s) => String(s.recipientKind || s.recipient_kind || '').toLowerCase()))];
    const ledger = creditByRefund.get(String(row.refund_id));
    if (!ledger) {
      expectedOpenAdd += expected;
      missing.push({
        refundId: row.refund_id,
        status: row.status,
        customerName: row.customer_name,
        expectedCutNgn: expected,
        source,
        recipientKinds: kinds,
        approvedNgn: roundMoney(row.approved_amount_ngn ?? row.amount_ngn),
        paidNgn: roundMoney(row.paid_amount_ngn),
        paymentNote: String(row.payment_note || '').slice(0, 160),
        requestedAtIso: row.requested_at_iso,
        splitPreview: splits.slice(0, 4).map((s) => ({
          kind: s.recipientKind || s.recipient_kind,
          amount: roundMoney(s.amountNgn ?? s.amount_ngn),
          cut: roundMoney(s.companyDeductionNgn ?? s.company_deduction_ngn),
          net: roundMoney(s.netPayoutNgn ?? s.net_payout_ngn),
          waived: Boolean(s.companyCutWaived || s.waiveCompanyCut),
        })),
      });
      continue;
    }
    const credited = roundMoney(ledger.amount_ngn);
    const open = roundMoney(ledger.open_ngn);
    if (credited < expected && open === credited) {
      under.push({
        refundId: row.refund_id,
        expectedCutNgn: expected,
        creditedNgn: credited,
        shortfallNgn: expected - credited,
        openNgn: open,
      });
      expectedOpenAdd += expected - credited;
    } else {
      matchedWithCut.push(row.refund_id);
    }
  }

  // Credits closed to zero while refund still approved/paid — possible releases
  const closedWhileActive = [];
  for (const c of credits) {
    const open = roundMoney(c.open_ngn);
    const amt = roundMoney(c.amount_ngn);
    if (open > 0) continue;
    const refund = refunds.find((r) => String(r.refund_id) === String(c.refund_id));
    if (!refund) continue;
    const st = String(refund.status || '').toLowerCase();
    if (st === 'approved' || st === 'paid' || st === 'partially paid') {
      closedWhileActive.push({
        refundId: c.refund_id,
        status: refund.status,
        amountNgn: amt,
        openNgn: open,
        note: String(c.note || '').slice(0, 200),
        customerName: refund.customer_name,
      });
    }
  }

  const withdrawals = db
    .prepare(
      `SELECT id, status, amount_ngn, requested_at_iso, paid_at_iso, cancelled_at_iso, note
       FROM refund_company_retention_withdrawals
       WHERE trim(IFNULL(branch_id,'')) = 'BR-KD'
       ORDER BY requested_at_iso DESC`
    )
    .all()
    .map((w) => ({
      id: w.id,
      status: w.status,
      amountNgn: roundMoney(w.amount_ngn),
      requestedAtIso: w.requested_at_iso,
      paidAtIso: w.paid_at_iso,
      cancelledAtIso: w.cancelled_at_iso,
      note: w.note,
    }));

  const out = {
    ok: true,
    ui: { openCredits: 122, totalBalanceNgn: 1_151_728 },
    live: {
      openCredits: summary.credits.length,
      totalOpenNgn: summary.totalOpenNgn,
      availableNgn: summary.availableNgn,
      heldNgn: summary.heldNgn,
      paidOutNgn: summary.paidOutNgn,
    },
    ledger: {
      creditRows: credits.length,
      openRows: credits.filter((c) => roundMoney(c.open_ngn) > 0).length,
      creditedTotalNgn: credits.reduce((s, c) => s + roundMoney(c.amount_ngn), 0),
      openTotalNgn: credits.reduce((s, c) => s + roundMoney(c.open_ngn), 0),
    },
    withdrawals,
    gaps: {
      missingCount: missing.length,
      missingNgn: missing.reduce((s, x) => s + x.expectedCutNgn, 0),
      underCount: under.length,
      underNgn: under.reduce((s, x) => s + x.shortfallNgn, 0),
      matchedWithCutCount: matchedWithCut.length,
      impliedOpenIfGapsFilledNgn: summary.totalOpenNgn + expectedOpenAdd,
      closedWhileActiveCount: closedWhileActive.length,
      closedWhileActiveNgn: closedWhileActive.reduce((s, x) => s + x.amountNgn, 0),
    },
    missing,
    under,
    closedWhileActive,
    releasedOrVoidedNotes: releasedOrVoided.map((c) => ({
      refundId: c.refund_id,
      amountNgn: roundMoney(c.amount_ngn),
      note: String(c.note || '').slice(0, 220),
    })),
  };

  const outPath = path.join(
    process.cwd(),
    'exports',
    `company-cut-retention-verify-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, missing: out.missing, exportPath: outPath }, null, 2));
} finally {
  try {
    db.close?.();
  } catch {
    /* ignore */
  }
}
