/**
 * AP1c-0 — read-only dry-run impact of Policy v1 receipt/production GL (no journal writes).
 * @param {import('better-sqlite3').Database} db
 */
import { isEffectivelyFullyPaid } from '../shared/lib/paymentOutstandingTolerance.js';
import { quotationHasCompletedProduction } from '../shared/lib/customerLedgerCore.js';
import {
  classifyReceiptGlPolicyBasis,
  simulateProductionRecognition,
  sumLegacyBridgeFromReceiptClasses,
} from '../shared/lib/ap1cSimulator.js';
import { branchWhere, listProductionJobs } from './readModel.js';

const DEFAULT_SAMPLE_CAP = 10;
const MAX_SAMPLE_CAP = 10;

function tableExists(db, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
      )
      .get(n);
    if (row) return true;
  } catch {
    /* SQLite tests */
  }
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n));
  } catch {
    return false;
  }
}

/** Mask quotation ref for API samples (no customer PII). */
export function maskQuotationRefForSample(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function parseQuotedMeters(linesJson) {
  let lines = linesJson;
  if (typeof lines === 'string') {
    try {
      lines = JSON.parse(lines || '{}');
    } catch {
      lines = {};
    }
  }
  if (!lines || typeof lines !== 'object') return 0;
  const products = lines.products;
  if (!Array.isArray(products)) return 0;
  let m = 0;
  for (const p of products) {
    m += Number(String(p?.qty ?? '').replace(/,/g, '')) || 0;
  }
  return m;
}

function computeEarnedNgn(qrow, job) {
  const totalNgn = Math.round(Number(qrow?.total_ngn) || 0);
  const quotedMeters = parseQuotedMeters(qrow?.lines_json);
  const actualMeters = Number(job?.actual_meters) || 0;
  if (totalNgn <= 0 || actualMeters <= 0) return 0;
  const denom = quotedMeters > 0 ? quotedMeters : actualMeters;
  const raw = totalNgn * (actualMeters / denom);
  return Math.min(totalNgn, Math.max(0, Math.round(raw)));
}

function mapJobs(rows) {
  return (rows || []).map((j) => ({
    status: j.status,
    quotationRef: j.quotation_ref ?? j.quotationRef,
    actualMeters: j.actual_meters ?? j.actualMeters,
    completedAtISO: j.completed_at_iso ?? j.completedAtISO,
    endDateISO: j.end_date_iso ?? j.endDateISO,
  }));
}

function periodKeyFromIso(iso) {
  const d = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  return d.slice(0, 7);
}

function lockedPeriodKeys(db) {
  if (!tableExists(db, 'accounting_period_locks')) return new Set();
  const rows = db.prepare(`SELECT period_key FROM accounting_period_locks`).all();
  return new Set(rows.map((r) => String(r.period_key || '').trim()).filter(Boolean));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   branchId?: string | null,
 *   period?: string | null,
 *   limitSamples?: number,
 * }} [opts]
 */
export function buildAp1cDryRunReport(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const periodFilter = String(opts.period || '').trim();
  const sampleCap = Math.min(
    MAX_SAMPLE_CAP,
    Math.max(1, Math.round(Number(opts.limitSamples) || DEFAULT_SAMPLE_CAP))
  );

  const summary = {
    receiptsBeforeProductionCredited1200Count: 0,
    receiptsBeforeProductionCredited1200Ngn: 0,
    expected2500InsteadOf1200Ngn: 0,
    quotationsPaidButNoProductionCount: 0,
    mixedLegacyAndPolicyReceiptCount: 0,
    expectedRelease2500Ngn: 0,
    currentAdvanceOnlyReleaseNgn: 0,
    releaseGapNgn: 0,
    potentialArOverstatementNgn: 0,
    potentialDepositUnderstatementNgn: 0,
    productionDuplicateRiskCount: 0,
    periodLockCollisionCount: 0,
  };

  const byBranchMap = new Map();
  const samples = {
    receiptsBeforeProductionCredited1200: [],
    paidNoProduction: [],
    mixedLegacyNew: [],
    releaseMismatch: [],
  };

  const bumpBranch = (branchId, field, n = 1) => {
    const bid = String(branchId || 'UNKNOWN').trim() || 'UNKNOWN';
    if (!byBranchMap.has(bid)) {
      byBranchMap.set(bid, {
        branchId: bid,
        receiptsBeforeProductionCredited1200Count: 0,
        receiptsBeforeProductionCredited1200Ngn: 0,
        releaseGapNgn: 0,
        potentialArOverstatementNgn: 0,
      });
    }
    const row = byBranchMap.get(bid);
    row[field] = (row[field] || 0) + n;
  };

  const pushSample = (bucket, row) => {
    if (samples[bucket].length >= sampleCap) return;
    samples[bucket].push(row);
  };

  if (!tableExists(db, 'quotations')) {
    return {
      ok: true,
      status: 'dry_run_only',
      policy: 'Accounting Policy v1 AP1c',
      branchScope,
      generatedAtISO: new Date().toISOString(),
      summary,
      byBranch: [],
      samples,
      notes: dryRunNotes(),
      warning: 'quotations_table_missing',
    };
  }

  const productionJobs = listProductionJobs(db, branchScope);
  const jobsByQuote = new Map();
  for (const j of productionJobs) {
    const ref = String(j.quotationRef || j.quotation_ref || '').trim();
    if (!ref) continue;
    if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
    jobsByQuote.get(ref).push(j);
  }

  const lockedPeriods = lockedPeriodKeys(db);
  const receiptClassesByQuote = new Map();

  if (
    tableExists(db, 'sales_receipts') &&
    tableExists(db, 'gl_journal_entries') &&
    tableExists(db, 'gl_journal_lines') &&
    tableExists(db, 'gl_accounts')
  ) {
    const br = branchWhere(db, 'sales_receipts', branchScope);
    const receiptRows = db
      .prepare(
        `SELECT sr.id, sr.quotation_ref, sr.amount_ngn, sr.date_iso, sr.branch_id,
                j.id AS journal_id, ga.code AS account_code, jl.credit_ngn, jl.debit_ngn
         FROM sales_receipts sr
         INNER JOIN gl_journal_entries j
           ON j.source_kind = 'CUSTOMER_RECEIPT_GL' AND j.source_id = sr.ledger_entry_id
         INNER JOIN gl_journal_lines jl ON jl.journal_id = j.id
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id
         WHERE sr.quotation_ref IS NOT NULL AND TRIM(sr.quotation_ref) != ''
           AND (sr.status IS NULL OR TRIM(LOWER(sr.status)) NOT IN ('reversed'))
           AND ga.code IN ('1200','2500') ${br.sql}`
      )
      .all(...br.args);

    const byReceipt = new Map();
    for (const r of receiptRows) {
      const rid = String(r.id || '');
      if (!byReceipt.has(rid)) {
        byReceipt.set(rid, {
          id: rid,
          quotationRef: r.quotation_ref,
          amountNgn: r.amount_ngn,
          dateISO: r.date_iso,
          branchId: r.branch_id,
          journalLines: [],
        });
      }
      byReceipt.get(rid).journalLines.push({
        accountCode: r.account_code,
        creditNgn: r.credit_ngn,
        debitNgn: r.debit_ngn,
      });
    }

    for (const rec of byReceipt.values()) {
      const qref = String(rec.quotationRef || '').trim();
      const jobs = mapJobs(jobsByQuote.get(qref) || []);
      const classified = classifyReceiptGlPolicyBasis({
        receipt: {
          quotationRef: qref,
          amountNgn: rec.amountNgn,
          dateISO: rec.dateISO,
        },
        journalLines: rec.journalLines,
        productionJobs: jobs,
      });
      if (!classified.ok) continue;

      if (!receiptClassesByQuote.has(qref)) receiptClassesByQuote.set(qref, []);
      receiptClassesByQuote.get(qref).push(classified);

      if (periodFilter) {
        const pk = periodKeyFromIso(rec.dateISO);
        if (pk && pk !== periodFilter) continue;
      }

      if (classified.isLegacyPreProd1200) {
        const ngn = classified.actualCreditNgn || classified.amountNgn;
        summary.receiptsBeforeProductionCredited1200Count += 1;
        summary.receiptsBeforeProductionCredited1200Ngn += ngn;
        summary.expected2500InsteadOf1200Ngn += classified.expected2500InsteadOf1200Ngn || ngn;
        bumpBranch(rec.branchId, 'receiptsBeforeProductionCredited1200Count', 1);
        bumpBranch(rec.branchId, 'receiptsBeforeProductionCredited1200Ngn', ngn);
        pushSample('receiptsBeforeProductionCredited1200', {
          quotationRefMasked: maskQuotationRefForSample(qref),
          amountNgn: ngn,
          branchId: rec.branchId || null,
          productionPhaseAtReceipt: classified.productionPhaseAtReceipt,
          policyCreditAccount: classified.policyCreditAccount,
        });
        const pk = periodKeyFromIso(rec.dateISO);
        if (pk && lockedPeriods.has(pk)) summary.periodLockCollisionCount += 1;
      }
    }
  }

  const qb = branchWhere(db, 'quotations', branchScope);
  const quotes = db
    .prepare(`SELECT id, total_ngn, paid_ngn, lines_json, branch_id FROM quotations WHERE 1=1${qb.sql}`)
    .all(...qb.args);

  for (const q of quotes) {
    const ref = String(q.id || '').trim();
    const jobs = mapJobs(jobsByQuote.get(ref) || []);
    const hasProd = quotationHasCompletedProduction(ref, jobs);
    const total = Math.round(Number(q.total_ngn) || 0);
    const paid = Math.round(Number(q.paid_ngn) || 0);
    const branchId = q.branch_id;

    if (!hasProd && isEffectivelyFullyPaid(paid, total) && total > 0) {
      summary.quotationsPaidButNoProductionCount += 1;
      pushSample('paidNoProduction', {
        quotationRefMasked: maskQuotationRefForSample(ref),
        paidNgn: paid,
        totalNgn: total,
        branchId: branchId || null,
      });
    }

    const classes = receiptClassesByQuote.get(ref) || [];
    const agg = sumLegacyBridgeFromReceiptClasses(classes);
    if (agg.mixedLegacyAndPolicyReceipt) {
      summary.mixedLegacyAndPolicyReceiptCount += 1;
      pushSample('mixedLegacyNew', {
        quotationRefMasked: maskQuotationRefForSample(ref),
        legacyBridgeNgn: agg.legacyBridgeNgn,
        branchId: branchId || null,
      });
    }

    if (!hasProd) continue;

    const completedJob = (jobsByQuote.get(ref) || []).find(
      (j) => String(j.status || '').trim() === 'Completed' && (Number(j.actualMeters) || 0) > 0
    );
    if (!completedJob) continue;

    const earned = computeEarnedNgn(q, completedJob);
    if (earned <= 0) continue;

    const advRow = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM ledger_entries
         WHERE quotation_ref = ? AND type = 'ADVANCE_APPLIED'`
      )
      .get(ref);
    const advanceApplied = Math.max(0, Math.round(Number(advRow?.s) || 0));

    let policyDeposits = agg.policyDepositsNgn;
    if (policyDeposits <= 0 && paid > 0 && agg.legacyBridgeNgn > 0) {
      policyDeposits = Math.max(0, paid - agg.legacyBridgeNgn);
    } else if (policyDeposits <= 0 && paid > 0 && classes.length === 0) {
      policyDeposits = paid;
    }

    const sim = simulateProductionRecognition({
      quotationRef: ref,
      earnedNgn: earned,
      advanceAppliedNgn: advanceApplied,
      policyDepositsNgn: policyDeposits,
      legacyBridgeNgn: agg.legacyBridgeNgn,
      productionJobs: jobs,
    });
    if (!sim.ok) continue;

    summary.expectedRelease2500Ngn += sim.expectedRelease2500Ngn;
    summary.currentAdvanceOnlyReleaseNgn += sim.currentRelease2500Ngn;
    summary.releaseGapNgn += sim.releaseGapNgn;
    summary.potentialArOverstatementNgn += sim.potentialArOverstatementNgn;
    summary.potentialDepositUnderstatementNgn += sim.potentialDepositUnderstatementNgn;
    if (sim.productionDuplicateRisk) summary.productionDuplicateRiskCount += 1;

    bumpBranch(branchId, 'releaseGapNgn', sim.releaseGapNgn);
    bumpBranch(branchId, 'potentialArOverstatementNgn', sim.potentialArOverstatementNgn);

    if (sim.releaseGapNgn > 0 || sim.potentialArOverstatementNgn > 0) {
      pushSample('releaseMismatch', {
        quotationRefMasked: maskQuotationRefForSample(ref),
        earnedNgn: earned,
        releaseGapNgn: sim.releaseGapNgn,
        potentialArOverstatementNgn: sim.potentialArOverstatementNgn,
        legacyBridgeNgn: agg.legacyBridgeNgn,
        branchId: branchId || null,
      });
    }

    const prodPk = periodKeyFromIso(completedJob.completedAtISO || completedJob.completed_at_iso);
    if (prodPk && lockedPeriods.has(prodPk)) summary.periodLockCollisionCount += 1;
  }

  return {
    ok: true,
    status: 'dry_run_only',
    policy: 'Accounting Policy v1 AP1c',
    branchScope,
    generatedAtISO: new Date().toISOString(),
    summary,
    byBranch: [...byBranchMap.values()],
    samples,
    notes: dryRunNotes(),
  };
}

function dryRunNotes() {
  return [
    'Dry-run only. No journals were posted.',
    'Legacy journals are not reclassified.',
    'Head of Accounts should review before AP1c posting flags are enabled.',
  ];
}

/** Compact summary for trial-exceptions when diagnostics flag is on. */
export function buildAp1cDryRunTrialSummary(db, branchScope = 'ALL') {
  const full = buildAp1cDryRunReport(db, { branchId: branchScope === 'ALL' ? null : branchScope });
  const s = full.summary || {};
  return {
    available: true,
    status: 'dry_run_only',
    receiptsBeforeProductionCredited1200Count: s.receiptsBeforeProductionCredited1200Count ?? 0,
    releaseGapNgn: s.releaseGapNgn ?? 0,
    potentialArOverstatementNgn: s.potentialArOverstatementNgn ?? 0,
  };
}
