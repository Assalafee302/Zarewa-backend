/**
 * Executive daily / weekly report packs for MD oversight.
 */
import { buildMdOperationsPack } from './mdOperationsPack.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';
import {
  enrichSalesReceiptRowsWithCashFromLedger,
  listExpenses,
  listLedgerEntries,
  listPaymentRequests,
  listProductionJobs,
  listPurchaseOrders,
  listQuotations,
  listRefunds,
  listSalesReceipts,
  listTreasuryMovements,
} from './readModel.js';
import { receiptsRegisterReportRows } from '../shared/lib/standardReportsSales.js';
import { expensesPackReport } from '../shared/lib/standardReportsFinance.js';
import { purchasesOrderedRows } from '../shared/lib/standardReportsPurchases.js';

function isoDateOnly(s) {
  return String(s || '').trim().slice(0, 10);
}

function addDays(iso, delta) {
  const d = new Date(`${isoDateOnly(iso)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function inRange(iso, start, end) {
  const d = isoDateOnly(iso);
  if (!d) return false;
  return d >= start && d <= end;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ date?: string; branchScope?: string }} opts
 */
export function buildExecutiveDailyPack(db, opts = {}) {
  const date =
    isoDateOnly(opts.date) ||
    addDays(new Date().toISOString().slice(0, 10), -1);
  const branchScope = opts.branchScope || 'ALL';

  const attention = listMdAttentionInbox(db, branchScope);
  const quotations = listQuotations(db, branchScope);
  const newQuotes = quotations.filter((q) => inRange(q.dateISO || q.date_iso, date, date));
  const flaggedToday = quotations.filter((q) => inRange(q.managerFlaggedAtISO, date, date));

  const rawReceipts = listSalesReceipts(db, branchScope);
  const ledger = listLedgerEntries(db, branchScope);
  const enriched = enrichSalesReceiptRowsWithCashFromLedger(rawReceipts, ledger);
  const tm = listTreasuryMovements(db, branchScope);
  const receiptRows = receiptsRegisterReportRows(enriched, ledger, tm, date, date);

  const refunds = listRefunds(db, branchScope).filter((r) => inRange(r.requestedAtISO, date, date));
  const paymentRequests = listPaymentRequests(db, branchScope).filter((p) =>
    inRange(p.requestDate || p.request_date, date, date)
  );
  const jobsCompleted = listProductionJobs(db, branchScope).filter((j) =>
    inRange(j.completedAtISO, date, date)
  );

  const monthKey = date.slice(0, 7);
  const monthSnapshot = buildMdOperationsPack(db, {
    monthKey,
    branchId: branchScope === 'ALL' ? undefined : branchScope,
    viewAll: branchScope === 'ALL',
  });

  return {
    ok: true,
    packKind: 'daily',
    date,
    branchScope,
    generatedAtIso: new Date().toISOString(),
    attention: {
      totalOpen: attention.summary?.total ?? 0,
      byKind: attention.summary?.byKind ?? {},
      topItems: (attention.items || []).slice(0, 15),
    },
    sales: {
      newQuotationsCount: newQuotes.length,
      newQuotations: newQuotes.slice(0, 20).map((q) => ({
        id: q.id || q.quotationID,
        customerName: q.customerName || q.customer_name,
        totalNgn: q.totalNgn || q.total_ngn,
        dateISO: q.dateISO || q.date_iso,
      })),
      receiptsCount: receiptRows.length,
      receiptsTotalNgn: receiptRows.reduce((s, r) => s + (Number(r.amountNgn) || 0), 0),
      receipts: receiptRows.slice(0, 40),
      flaggedCount: flaggedToday.length,
    },
    operations: {
      refundsRequestedCount: refunds.length,
      paymentRequestsCount: paymentRequests.length,
      productionJobsCompletedCount: jobsCompleted.length,
    },
    monthExceptionCounts: monthSnapshot.ok ? monthSnapshot.counts : null,
    notes: [
      'Daily pack covers calendar day in branch workspace scope.',
      'Open attention items are current queue — not limited to items opened on this date.',
    ],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ endDate?: string; branchScope?: string }} opts
 */
export function buildExecutiveWeeklyPack(db, opts = {}) {
  const endDate = isoDateOnly(opts.endDate) || new Date().toISOString().slice(0, 10);
  const startDate = addDays(endDate, -6);
  const branchScope = opts.branchScope || 'ALL';

  const quotations = listQuotations(db, branchScope);
  const quotesInWeek = quotations.filter((q) => inRange(q.dateISO || q.date_iso, startDate, endDate));

  const rawReceipts = listSalesReceipts(db, branchScope);
  const ledger = listLedgerEntries(db, branchScope);
  const enriched = enrichSalesReceiptRowsWithCashFromLedger(rawReceipts, ledger);
  const tm = listTreasuryMovements(db, branchScope);
  const receiptRows = receiptsRegisterReportRows(enriched, ledger, tm, startDate, endDate);

  const expenses = listExpenses(db, branchScope);
  const expenseRows = expensesPackReport(expenses, startDate, endDate);

  const pos = purchasesOrderedRows(listPurchaseOrders(db, branchScope), startDate, endDate);

  const attention = listMdAttentionInbox(db, branchScope);
  const refunds = listRefunds(db, branchScope).filter((r) => inRange(r.requestedAtISO, startDate, endDate));
  const jobs = listProductionJobs(db, branchScope).filter((j) => inRange(j.completedAtISO, startDate, endDate));

  const monthKey = endDate.slice(0, 7);
  const monthSnapshot = buildMdOperationsPack(db, {
    monthKey,
    branchId: branchScope === 'ALL' ? undefined : branchScope,
    viewAll: branchScope === 'ALL',
  });

  return {
    ok: true,
    packKind: 'weekly',
    startDate,
    endDate,
    branchScope,
    generatedAtIso: new Date().toISOString(),
    attention: {
      totalOpen: attention.summary?.total ?? 0,
      byKind: attention.summary?.byKind ?? {},
    },
    sales: {
      quotationsCount: quotesInWeek.length,
      quotationsTotalNgn: quotesInWeek.reduce((s, q) => s + (Number(q.totalNgn || q.total_ngn) || 0), 0),
      receiptsCount: receiptRows.length,
      receiptsTotalNgn: receiptRows.reduce((s, r) => s + (Number(r.amountNgn) || 0), 0),
    },
    finance: {
      expensePackRowCount: expenseRows.length,
      refundsInWeekCount: refunds.length,
    },
    procurement: {
      purchaseOrdersInWeekCount: Array.isArray(pos) ? pos.length : 0,
    },
    production: {
      jobsCompletedCount: jobs.length,
    },
    monthExceptionCounts: monthSnapshot.ok ? monthSnapshot.counts : null,
    notes: [
      `Weekly pack: ${startDate} through ${endDate} (inclusive).`,
      'Use Reports → Executive packs to print or export.',
    ],
  };
}
