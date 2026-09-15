/**
 * Outage / network-retry duplicate audit for the sales chain:
 * quotation → receipts (confirmation backlog) → cutting lists → production jobs.
 *
 * Read-only. Flags twin receipts and multi-document chains so finance can
 * confirm the real voucher and production can refuse doubles.
 */
import { normalizeReceiptReferenceToken } from '../receiptPostingGuards.js';
import { branchWhere } from '../readModel.js';
import { tableHasColumn } from '../schemaCache.js';
import { isReceiptCleared, isReceiptReversed } from '../../shared/lib/receiptClearance.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * @param {unknown} v
 * @returns {string}
 */
export function auditDay(v) {
  return String(v || '').trim().slice(0, 10);
}

/**
 * @param {{ fromDate?: string, toDate?: string, days?: number }} opts
 */
export function resolveAuditDateWindow(opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let fromDate = auditDay(opts.fromDate);
  let toDate = auditDay(opts.toDate) || today;
  if (!fromDate) {
    const days = Number(opts.days) > 0 ? Math.min(Number(opts.days), 90) : 14;
    const d = new Date(`${toDate}T12:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    fromDate = d.toISOString().slice(0, 10);
  }
  if (fromDate > toDate) {
    const swap = fromDate;
    fromDate = toDate;
    toDate = swap;
  }
  return { fromDate, toDate };
}

/**
 * Pair receipts on the same quotation that share amount and/or overlapping bank/voucher ref.
 * @param {Array<{ id: string, amountNgn: number, bankReference?: string, dateIso?: string, status?: string }>} receipts
 */
export function findTwinReceiptGroupsOnQuote(receipts) {
  const list = (Array.isArray(receipts) ? receipts : []).filter((r) => !isReceiptReversed(r));
  /** @type {Map<string, { code: string, receiptIds: string[], amountNgn: number, bankReference?: string, message: string }>} */
  const groups = new Map();

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const amountA = Math.round(Number(a.amountNgn) || 0);
      const amountB = Math.round(Number(b.amountNgn) || 0);
      const refA = normalizeReceiptReferenceToken(a.bankReference);
      const refB = normalizeReceiptReferenceToken(b.bankReference);
      const sameAmount = amountA > 0 && amountA === amountB;
      const sameRef =
        Boolean(refA) && Boolean(refB) && (refA.includes(refB) || refB.includes(refA));
      if (!sameAmount && !sameRef) continue;

      const code = sameAmount && sameRef ? 'TWIN_AMOUNT_AND_REFERENCE' : sameRef ? 'TWIN_REFERENCE' : 'TWIN_AMOUNT';
      const key = [code, Math.min(amountA, amountB), refA || refB || '', [a.id, b.id].sort().join('|')].join(':');
      if (groups.has(key)) continue;
      groups.set(key, {
        code,
        receiptIds: [a.id, b.id].sort(),
        amountNgn: sameAmount ? amountA : Math.max(amountA, amountB),
        bankReference: String(a.bankReference || b.bankReference || '').trim() || undefined,
        message:
          code === 'TWIN_AMOUNT_AND_REFERENCE'
            ? `Same amount and matching bank/voucher reference (${a.id} ↔ ${b.id}).`
            : code === 'TWIN_REFERENCE'
              ? `Matching bank/voucher reference (${a.id} ↔ ${b.id}).`
              : `Same amount ₦${amountA.toLocaleString('en-NG')} (${a.id} ↔ ${b.id}).`,
      });
    }
  }
  return [...groups.values()];
}

/**
 * @param {string[]} flags
 */
export function severityForAuditFlags(flags) {
  const set = new Set(flags || []);
  if (set.has('multi_production_job') || set.has('multi_cutting_list')) return 'critical';
  if (set.has('twin_receipt_pending_confirm') || set.has('twin_receipt')) return 'high';
  if (set.has('multi_receipt') || set.has('cross_quote_same_day_receipt')) return 'medium';
  return 'low';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchScope?: string, fromDate?: string, toDate?: string, days?: number, limit?: number }} [opts]
 */
export function buildOutageDuplicateAuditReport(db, opts = {}) {
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const { fromDate, toDate } = resolveAuditDateWindow(opts);
  const limit = Math.min(
    Math.max(Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  const srBranch = branchWhere(db, 'sales_receipts', branchScope);
  const clBranch = branchWhere(db, 'cutting_lists', branchScope);
  const pjBranch = branchWhere(db, 'production_jobs', branchScope);
  const hasFinanceSaved = tableHasColumn(db, 'sales_receipts', 'finance_reconciliation_saved_at_iso');
  const hasBankReceived = tableHasColumn(db, 'sales_receipts', 'bank_received_amount_ngn');
  const financeSavedSelect = hasFinanceSaved
    ? 'sr.finance_reconciliation_saved_at_iso'
    : 'NULL AS finance_reconciliation_saved_at_iso';
  const bankReceivedSelect = hasBankReceived
    ? 'sr.bank_received_amount_ngn'
    : 'NULL AS bank_received_amount_ngn';

  const receiptRows = db
    .prepare(
      `SELECT sr.id, sr.customer_id, sr.customer_name, sr.quotation_ref, sr.date_iso, sr.amount_ngn,
              sr.status, sr.method, sr.handled_by, sr.ledger_entry_id,
              ${financeSavedSelect}, ${bankReceivedSelect},
              le.bank_reference AS ledger_bank_reference
       FROM sales_receipts sr
       LEFT JOIN ledger_entries le ON le.id = COALESCE(NULLIF(TRIM(sr.ledger_entry_id), ''), sr.id)
       WHERE TRIM(IFNULL(sr.quotation_ref, '')) != ''
         AND substr(IFNULL(sr.date_iso, ''), 1, 10) >= ?
         AND substr(IFNULL(sr.date_iso, ''), 1, 10) <= ?
         ${srBranch.sql.replace(/\bbranch_id\b/g, 'sr.branch_id')}
       ORDER BY sr.quotation_ref, sr.date_iso, sr.id`
    )
    .all(fromDate, toDate, ...srBranch.args)
    .map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name || '',
      quotationRef: String(row.quotation_ref || '').trim(),
      dateIso: row.date_iso || '',
      amountNgn: Math.round(Number(row.amount_ngn) || 0),
      status: row.status || '',
      method: row.method || '',
      handledBy: row.handled_by || '',
      ledgerEntryId: row.ledger_entry_id || row.id,
      bankReference: row.ledger_bank_reference || '',
      finance_reconciliation_saved_at_iso: row.finance_reconciliation_saved_at_iso,
      bank_received_amount_ngn: row.bank_received_amount_ngn,
    }))
    .filter((r) => !isReceiptReversed(r));

  /** @type {Map<string, typeof receiptRows>} */
  const receiptsByQuote = new Map();
  for (const r of receiptRows) {
    if (!receiptsByQuote.has(r.quotationRef)) receiptsByQuote.set(r.quotationRef, []);
    receiptsByQuote.get(r.quotationRef).push(r);
  }

  const twinReceiptGroups = [];
  for (const [quotationRef, rows] of receiptsByQuote) {
    if (rows.length < 2) continue;
    const twins = findTwinReceiptGroupsOnQuote(rows);
    if (!twins.length && rows.length < 2) continue;
    const pendingIds = new Set(
      rows.filter((r) => !isReceiptCleared(r)).map((r) => r.id)
    );
    for (const twin of twins) {
      const pendingConfirm = twin.receiptIds.some((id) => pendingIds.has(id));
      twinReceiptGroups.push({
        quotationRef,
        customerId: rows[0]?.customerId || '',
        customerName: rows[0]?.customerName || '',
        pendingConfirm,
        receipts: twin.receiptIds.map((id) => rows.find((r) => r.id === id)).filter(Boolean),
        ...twin,
      });
    }
    if (!twins.length && rows.length > 1) {
      twinReceiptGroups.push({
        quotationRef,
        customerId: rows[0]?.customerId || '',
        customerName: rows[0]?.customerName || '',
        code: 'MULTI_RECEIPT',
        pendingConfirm: rows.some((r) => !isReceiptCleared(r)),
        receiptIds: rows.map((r) => r.id),
        amountNgn: rows[0]?.amountNgn || 0,
        message: `${rows.length} non-reversed receipts on this quotation in the window.`,
        receipts: rows,
      });
    }
  }

  const multiCuttingLists = db
    .prepare(
      `SELECT cl.quotation_ref AS quotationRef,
              MAX(cl.customer_id) AS customerId,
              MAX(cl.customer_name) AS customerName,
              COUNT(*) AS cuttingListCount,
              GROUP_CONCAT(cl.id) AS cuttingListIds,
              GROUP_CONCAT(IFNULL(cl.status, '')) AS statuses
       FROM cutting_lists cl
       WHERE TRIM(IFNULL(cl.quotation_ref, '')) != ''
         AND LOWER(TRIM(IFNULL(cl.status, ''))) != 'draft'
         AND substr(IFNULL(cl.date_iso, ''), 1, 10) >= ?
         AND substr(IFNULL(cl.date_iso, ''), 1, 10) <= ?
         ${clBranch.sql.replace(/\bbranch_id\b/g, 'cl.branch_id')}
       GROUP BY cl.quotation_ref
       HAVING COUNT(*) > 1
       ORDER BY cuttingListCount DESC, quotationRef ASC
       LIMIT ?`
    )
    .all(fromDate, toDate, ...clBranch.args, limit)
    .map((row) => ({
      quotationRef: row.quotationRef,
      customerId: row.customerId || '',
      customerName: row.customerName || '',
      cuttingListCount: Number(row.cuttingListCount) || 0,
      cuttingListIds: String(row.cuttingListIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      statuses: String(row.statuses || '')
        .split(',')
        .map((s) => s.trim()),
    }));

  const multiProductionJobs = db
    .prepare(
      `SELECT pj.cutting_list_id AS cuttingListId,
              MAX(pj.quotation_ref) AS quotationRef,
              MAX(pj.customer_id) AS customerId,
              MAX(pj.customer_name) AS customerName,
              COUNT(*) AS jobCount,
              GROUP_CONCAT(pj.job_id) AS jobIds,
              GROUP_CONCAT(IFNULL(pj.status, '')) AS statuses
       FROM production_jobs pj
       WHERE TRIM(IFNULL(pj.cutting_list_id, '')) != ''
         AND substr(COALESCE(pj.created_at_iso, pj.start_date_iso, ''), 1, 10) >= ?
         AND substr(COALESCE(pj.created_at_iso, pj.start_date_iso, ''), 1, 10) <= ?
         ${pjBranch.sql.replace(/\bbranch_id\b/g, 'pj.branch_id')}
       GROUP BY pj.cutting_list_id
       HAVING COUNT(*) > 1
       ORDER BY jobCount DESC, cuttingListId ASC
       LIMIT ?`
    )
    .all(fromDate, toDate, ...pjBranch.args, limit)
    .map((row) => ({
      cuttingListId: row.cuttingListId,
      quotationRef: row.quotationRef || '',
      customerId: row.customerId || '',
      customerName: row.customerName || '',
      jobCount: Number(row.jobCount) || 0,
      jobIds: String(row.jobIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      statuses: String(row.statuses || '')
        .split(',')
        .map((s) => s.trim()),
    }));

  const multiJobsByQuote = db
    .prepare(
      `SELECT pj.quotation_ref AS quotationRef,
              MAX(pj.customer_id) AS customerId,
              MAX(pj.customer_name) AS customerName,
              COUNT(*) AS jobCount,
              COUNT(DISTINCT NULLIF(TRIM(pj.cutting_list_id), '')) AS cuttingListCount,
              GROUP_CONCAT(pj.job_id) AS jobIds
       FROM production_jobs pj
       WHERE TRIM(IFNULL(pj.quotation_ref, '')) != ''
         AND substr(COALESCE(pj.created_at_iso, pj.start_date_iso, ''), 1, 10) >= ?
         AND substr(COALESCE(pj.created_at_iso, pj.start_date_iso, ''), 1, 10) <= ?
         ${pjBranch.sql.replace(/\bbranch_id\b/g, 'pj.branch_id')}
       GROUP BY pj.quotation_ref
       HAVING COUNT(*) > 1
       ORDER BY jobCount DESC, quotationRef ASC
       LIMIT ?`
    )
    .all(fromDate, toDate, ...pjBranch.args, limit)
    .map((row) => ({
      quotationRef: row.quotationRef,
      customerId: row.customerId || '',
      customerName: row.customerName || '',
      jobCount: Number(row.jobCount) || 0,
      cuttingListCount: Number(row.cuttingListCount) || 0,
      jobIds: String(row.jobIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }));

  const crossQuoteReceiptTwins = db
    .prepare(
      `SELECT sr.customer_id AS customerId,
              MAX(sr.customer_name) AS customerName,
              sr.amount_ngn AS amountNgn,
              substr(IFNULL(sr.date_iso, ''), 1, 10) AS dateIso,
              COUNT(*) AS receiptCount,
              COUNT(DISTINCT sr.quotation_ref) AS quotationCount,
              GROUP_CONCAT(DISTINCT sr.quotation_ref) AS quotationRefs,
              GROUP_CONCAT(sr.id) AS receiptIds
       FROM sales_receipts sr
       WHERE TRIM(IFNULL(sr.quotation_ref, '')) != ''
         AND LOWER(TRIM(IFNULL(sr.status, ''))) != 'reversed'
         AND substr(IFNULL(sr.date_iso, ''), 1, 10) >= ?
         AND substr(IFNULL(sr.date_iso, ''), 1, 10) <= ?
         ${srBranch.sql.replace(/\bbranch_id\b/g, 'sr.branch_id')}
       GROUP BY sr.customer_id, sr.amount_ngn, substr(IFNULL(sr.date_iso, ''), 1, 10)
       HAVING COUNT(*) > 1 AND COUNT(DISTINCT sr.quotation_ref) > 1
       ORDER BY receiptCount DESC, dateIso DESC
       LIMIT ?`
    )
    .all(fromDate, toDate, ...srBranch.args, limit)
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName || '',
      amountNgn: Math.round(Number(row.amountNgn) || 0),
      dateIso: row.dateIso || '',
      receiptCount: Number(row.receiptCount) || 0,
      quotationCount: Number(row.quotationCount) || 0,
      quotationRefs: String(row.quotationRefs || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      receiptIds: String(row.receiptIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }));

  /** @type {Map<string, { quotationRef: string, customerId: string, customerName: string, flags: string[], severity: string, receiptCount: number, twinGroupCount: number, pendingReceiptCount: number, cuttingListCount: number, productionJobCount: number, receiptIds: string[], cuttingListIds: string[], jobIds: string[], twinCodes: string[] }>} */
  const byQuote = new Map();

  function ensureQuote(quotationRef, seed = {}) {
    if (!byQuote.has(quotationRef)) {
      byQuote.set(quotationRef, {
        quotationRef,
        customerId: seed.customerId || '',
        customerName: seed.customerName || '',
        flags: [],
        severity: 'low',
        receiptCount: 0,
        twinGroupCount: 0,
        pendingReceiptCount: 0,
        cuttingListCount: 0,
        productionJobCount: 0,
        receiptIds: [],
        cuttingListIds: [],
        jobIds: [],
        twinCodes: [],
      });
    }
    const row = byQuote.get(quotationRef);
    if (!row.customerId && seed.customerId) row.customerId = seed.customerId;
    if (!row.customerName && seed.customerName) row.customerName = seed.customerName;
    return row;
  }

  function addFlag(row, flag) {
    if (!row.flags.includes(flag)) row.flags.push(flag);
  }

  for (const [quotationRef, rows] of receiptsByQuote) {
    if (rows.length < 2) continue;
    const row = ensureQuote(quotationRef, rows[0]);
    row.receiptCount = rows.length;
    row.receiptIds = rows.map((r) => r.id);
    row.pendingReceiptCount = rows.filter((r) => !isReceiptCleared(r)).length;
    addFlag(row, 'multi_receipt');
  }

  for (const g of twinReceiptGroups) {
    if (g.code === 'MULTI_RECEIPT') continue;
    const row = ensureQuote(g.quotationRef, g);
    row.twinGroupCount += 1;
    if (!row.twinCodes.includes(g.code)) row.twinCodes.push(g.code);
    addFlag(row, 'twin_receipt');
    if (g.pendingConfirm) addFlag(row, 'twin_receipt_pending_confirm');
  }

  for (const cl of multiCuttingLists) {
    const row = ensureQuote(cl.quotationRef, cl);
    row.cuttingListCount = cl.cuttingListCount;
    row.cuttingListIds = cl.cuttingListIds;
    addFlag(row, 'multi_cutting_list');
  }

  for (const job of multiProductionJobs) {
    if (!job.quotationRef) continue;
    const row = ensureQuote(job.quotationRef, job);
    row.productionJobCount = Math.max(row.productionJobCount, job.jobCount);
    for (const id of job.jobIds) {
      if (!row.jobIds.includes(id)) row.jobIds.push(id);
    }
    addFlag(row, 'multi_production_job');
  }

  for (const job of multiJobsByQuote) {
    const row = ensureQuote(job.quotationRef, job);
    row.productionJobCount = Math.max(row.productionJobCount, job.jobCount);
    for (const id of job.jobIds) {
      if (!row.jobIds.includes(id)) row.jobIds.push(id);
    }
    addFlag(row, 'multi_production_job');
  }

  for (const cross of crossQuoteReceiptTwins) {
    for (const quotationRef of cross.quotationRefs) {
      const row = ensureQuote(quotationRef, cross);
      addFlag(row, 'cross_quote_same_day_receipt');
    }
  }

  // Enrich CL / job counts for suspects that only had receipt flags.
  const suspectIds = [...byQuote.keys()];
  if (suspectIds.length) {
    const placeholders = suspectIds.map(() => '?').join(',');
    const clCounts = db
      .prepare(
        `SELECT quotation_ref AS quotationRef, COUNT(*) AS c,
                GROUP_CONCAT(id) AS ids
         FROM cutting_lists
         WHERE quotation_ref IN (${placeholders})
           AND LOWER(TRIM(IFNULL(status, ''))) != 'draft'
           ${clBranch.sql}
         GROUP BY quotation_ref`
      )
      .all(...suspectIds, ...clBranch.args);
    for (const r of clCounts) {
      const row = byQuote.get(r.quotationRef);
      if (!row) continue;
      row.cuttingListCount = Number(r.c) || 0;
      row.cuttingListIds = String(r.ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const jobCounts = db
      .prepare(
        `SELECT quotation_ref AS quotationRef, COUNT(*) AS c,
                GROUP_CONCAT(job_id) AS ids
         FROM production_jobs
         WHERE quotation_ref IN (${placeholders})
           ${pjBranch.sql}
         GROUP BY quotation_ref`
      )
      .all(...suspectIds, ...pjBranch.args);
    for (const r of jobCounts) {
      const row = byQuote.get(r.quotationRef);
      if (!row) continue;
      row.productionJobCount = Number(r.c) || 0;
      row.jobIds = String(r.ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const quotations = [...byQuote.values()]
    .map((row) => ({
      ...row,
      severity: severityForAuditFlags(row.flags),
      guidance:
        row.flags.includes('twin_receipt_pending_confirm')
          ? 'Do not confirm both receipts. Match the paper voucher to one LE id, then hold/reverse the twin.'
          : row.flags.includes('multi_cutting_list')
            ? 'Keep the printed/registered cutting list; cancel or hold the extra before production.'
            : row.flags.includes('multi_production_job')
              ? 'Stop further production on extras. Verify coil allocations against the kept job only.'
              : 'Review linked documents before finance clearance or shop-floor release.',
    }))
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || a.quotationRef.localeCompare(b.quotationRef);
    })
    .slice(0, limit);

  const pendingConfirmationTwins = twinReceiptGroups
    .filter((g) => g.pendingConfirm && g.code !== 'MULTI_RECEIPT')
    .slice(0, limit);

  return {
    ok: true,
    generatedAtIso: new Date().toISOString(),
    fromDate,
    toDate,
    branchScope,
    summary: {
      quotationSuspectCount: quotations.length,
      twinReceiptGroupCount: twinReceiptGroups.filter((g) => g.code !== 'MULTI_RECEIPT').length,
      multiReceiptQuoteCount: twinReceiptGroups.filter((g) => g.code === 'MULTI_RECEIPT' || g.receipts?.length > 1)
        .length,
      multiCuttingListCount: multiCuttingLists.length,
      multiProductionJobCount: Math.max(multiProductionJobs.length, multiJobsByQuote.length),
      pendingConfirmationTwinCount: pendingConfirmationTwins.length,
      crossQuoteSameDayTwinCount: crossQuoteReceiptTwins.length,
      criticalCount: quotations.filter((q) => q.severity === 'critical').length,
      highCount: quotations.filter((q) => q.severity === 'high').length,
    },
    quotations,
    twinReceiptGroups: twinReceiptGroups.slice(0, limit),
    pendingConfirmationTwins,
    multiCuttingLists,
    multiProductionJobs,
    multiJobsByQuote,
    crossQuoteReceiptTwins,
  };
}
