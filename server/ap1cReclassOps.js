/**
 * AP1c-5 — optional one-off reclass Dr 1200 / Cr 2500 for legacy pre-production receipts.
 */
import { classifyReceiptGlPolicyBasis } from '../shared/lib/ap1cSimulator.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { tableExists } from './ap2ReceivedBasisOps.js';
import { postBalancedJournalTx } from './glOps.js';
import { branchWhere } from './readModel.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

export function mapJobsForAp1cReclass(jobs) {
  return (jobs || []).map((j) => ({
    jobID: j.jobID || j.id,
    status: j.status,
    actualMeters: j.actualMeters ?? j.actual_metres,
    quotationRef: j.quotationRef ?? j.quotation_ref,
  }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
function loadReclassCandidates(db, branchScope) {
  if (!tableExists(db, 'sales_receipts') || !tableExists(db, 'gl_journal_entries')) {
    return [];
  }

  const jobsByQuote = new Map();
  if (tableExists(db, 'production_jobs')) {
    for (const j of db
      .prepare(
        `SELECT job_id AS jobID, status, actual_metres AS actualMeters, quotation_ref AS quotationRef FROM production_jobs`
      )
      .all()) {
      const ref = String(j.quotationRef || '').trim();
      if (!ref) continue;
      if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
      jobsByQuote.get(ref).push(j);
    }
  }

  const br = branchWhere(db, 'sales_receipts', branchScope);
  const receiptRows = db
    .prepare(
      `SELECT sr.id, sr.ledger_entry_id, sr.quotation_ref, sr.amount_ngn, sr.date_iso, sr.branch_id,
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

  /** @type {Map<string, object>} */
  const byReceipt = new Map();
  for (const r of receiptRows) {
    const rid = String(r.id || '');
    if (!byReceipt.has(rid)) {
      byReceipt.set(rid, {
        receiptId: rid,
        ledgerEntryId: r.ledger_entry_id,
        journalId: r.journal_id,
        quotationRef: r.quotation_ref,
        amountNgn: roundMoney(r.amount_ngn),
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

  const candidates = [];
  for (const rec of byReceipt.values()) {
    const qref = String(rec.quotationRef || '').trim();
    const jobs = mapJobsForAp1cReclass(jobsByQuote.get(qref) || []);
    const classified = classifyReceiptGlPolicyBasis({
      receipt: { quotationRef: qref, amountNgn: rec.amountNgn, dateISO: rec.dateISO },
      journalLines: rec.journalLines,
      productionJobs: jobs,
    });
    if (!classified.ok || !classified.isLegacyPreProd1200) continue;

    const amount = roundMoney(classified.actualCreditNgn || classified.amountNgn);
    if (amount <= 0) continue;

    const sourceId = String(rec.ledgerEntryId || rec.receiptId || '').trim();
    const already = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'AP1C_PREPROD_RECLASS' AND source_id = ?`)
      .get(sourceId);

    candidates.push({
      receiptId: rec.receiptId,
      ledgerEntryId: rec.ledgerEntryId,
      quotationRef: qref,
      branchId: rec.branchId,
      dateISO: rec.dateISO,
      amountNgn: amount,
      reclassSourceId: sourceId,
      alreadyReclassified: Boolean(already),
    });
  }

  return candidates.sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO)));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; limit?: number }} [opts]
 */
export function buildAp1cReclassPreview(db, opts = {}) {
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const flags = readFinanceFeatureFlags();
  const candidates = loadReclassCandidates(db, branchScope);
  const pending = candidates.filter((c) => !c.alreadyReclassified);
  const done = candidates.filter((c) => c.alreadyReclassified);

  return {
    ok: true,
    label: 'AP1c-5 pre-production receipt reclass preview',
    disclaimer: 'Optional Dr 1200 / Cr 2500 reclass for legacy pre-production receipts. Never auto-runs.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    flags: { reclassPreProductionReceipts: flags.reclassPreProductionReceipts },
    canPost: flags.reclassPreProductionReceipts,
    summary: {
      candidateCount: candidates.length,
      pendingCount: pending.length,
      reclassifiedCount: done.length,
      totalPendingNgn: pending.reduce((s, c) => s + c.amountNgn, 0),
    },
    pending: pending.slice(0, opts.limit || 200),
    reclassified: done.slice(0, 50),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; createdByUserId?: string | null; receiptIds?: string[] }} [opts]
 */
export function postAp1cReclassBatch(db, opts = {}) {
  const flags = readFinanceFeatureFlags();
  if (!flags.reclassPreProductionReceipts) {
    return { ok: false, error: 'RECLASS_PRE_PRODUCTION_RECEIPTS=0 — enable after HoA sign-off.' };
  }

  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';

  const preview = buildAp1cReclassPreview(db, { branchId: branchScope, limit: 500 });
  let pending = preview.pending || [];
  if (opts.receiptIds?.length) {
    const set = new Set(opts.receiptIds.map(String));
    pending = pending.filter((c) => set.has(c.receiptId));
  }

  if (!pending.length) {
    return { ok: true, posted: 0, skipped: preview.reclassified?.length || 0, message: 'No pending reclass lines.' };
  }

  let posted = 0;
  let duplicate = 0;
  const errors = [];

  const postOne = () => {
    for (const c of pending) {
      const sourceId = String(c.reclassSourceId || '').trim();
      if (!sourceId) continue;
      const entryDate = String(c.dateISO || new Date().toISOString()).slice(0, 10);
      try {
        const r = postBalancedJournalTx(db, {
          entryDateISO: entryDate,
          memo: `AP1c reclass pre-prod receipt ${c.quotationRef}`,
          sourceKind: 'AP1C_PREPROD_RECLASS',
          sourceId,
          branchId: c.branchId || null,
          createdByUserId: opts.createdByUserId ?? null,
          lines: [
            { accountCode: '1200', debitNgn: c.amountNgn, memo: c.quotationRef },
            { accountCode: '2500', creditNgn: c.amountNgn, memo: c.quotationRef },
          ],
        });
        if (r.duplicate) duplicate += 1;
        else if (r.ok) posted += 1;
        else errors.push(r.error || sourceId);
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }
  };

  if (typeof db.transaction === 'function') {
    db.transaction(postOne)();
  } else {
    postOne();
  }

  if (errors.length) return { ok: false, error: errors[0], posted, duplicate, errors };
  return {
    ok: true,
    posted,
    duplicate,
    message: `Posted ${posted} reclass journal(s)${duplicate ? `; ${duplicate} duplicate(s)` : ''}.`,
  };
}
