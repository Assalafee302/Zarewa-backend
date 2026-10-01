/**
 * Month-end sales pack loader.
 * Reads the period directly. Does not use desk list caps and does not heal refunds on read.
 */
import { branchWhere } from '../readModel.js';
import { hasColumn, tableExists } from '../ap2ReceivedBasisOps.js';
import { evaluateRefundPayoutGlPolicy } from '../ap1cReversalRefundOps.js';
import { effectiveOutstandingNgn } from '../../shared/lib/paymentOutstandingTolerance.js';
import { buildSalesMonthEndPack, resolveSalesMonthEndPeriod } from '../../shared/lib/salesMonthEndPack.js';

function branchFilter(db, table, scope, alias = '') {
  const b = branchWhere(db, table, scope);
  const sql = alias ? b.sql.replace(/\bbranch_id\b/g, `${alias}.branch_id`) : b.sql;
  return { sql, args: b.args };
}

function mustAll(db, sql, args) {
  return db.prepare(sql).all(...args);
}

function mustGet(db, sql, args) {
  return db.prepare(sql).get(...args) || null;
}

function optionalGet(db, sql, args, warnings, label) {
  try {
    return db.prepare(sql).get(...args) || null;
  } catch (err) {
    console.error('[sales-month-end-pack]', label, err);
    warnings.push({
      code: 'section_unavailable',
      recordId: label,
      detail: `${label} could not be loaded. That total is left blank rather than shown as zero.`,
      amountNgn: 0,
    });
    return null;
  }
}

function optionalAll(db, sql, args, warnings, label) {
  try {
    return db.prepare(sql).all(...args);
  } catch (err) {
    console.error('[sales-month-end-pack]', label, err);
    warnings.push({
      code: 'section_unavailable',
      recordId: label,
      detail: `${label} could not be loaded. That total is left blank rather than shown as zero.`,
      amountNgn: 0,
    });
    return null;
  }
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function receiptCatalogForCreditSources(db, creditApplications) {
  const quotes = [
    ...new Set((creditApplications || []).map((app) => String(app.sourceQuotationRef || '').trim()).filter(Boolean)),
  ];
  if (!quotes.length || !tableExists(db, 'sales_receipts')) return [];
  const catalog = [];
  const chunkSize = 80;
  for (let i = 0; i < quotes.length; i += chunkSize) {
    const chunk = quotes.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, quotation_ref, status FROM sales_receipts WHERE quotation_ref IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) {
      catalog.push({ id: row.id, quotationRef: row.quotation_ref, status: row.status });
    }
  }
  return catalog;
}

function salesTreatmentForRefund(db, row, productionJobs) {
  try {
    const policy = evaluateRefundPayoutGlPolicy(db, {
      quotationRef: row.quotation_ref,
      customerId: row.customer_id,
      refundId: row.refund_id,
      reasonCategories: parseJsonArray(row.reason_category),
      calculationLines: parseJsonArray(row.calculation_lines_json),
      productionJobs,
    });
    if (policy.glTreatment === 'revenue_4000') return 'concession';
    if (policy.needsRevenueReview) return 'needs_review';
    return 'customer_money';
  } catch (err) {
    console.error('[sales-month-end-pack] refund classification', row?.refund_id, err);
    return 'customer_money';
  }
}

function mapJob(row) {
  return {
    jobID: row.job_id,
    quotationRef: row.quotation_ref,
    customerName: row.customer_name,
    status: row.status,
    actualMeters: row.actual_meters,
    actualRoofM: row.actual_roof_m,
    actualCladdingM: row.actual_cladding_m,
    actualFlatsheetM: row.actual_flatsheet_m,
    completedAtISO: row.completed_at_iso,
    endDateISO: row.end_date_iso,
  };
}

function jobSelect(db) {
  const cols = ['job_id', 'quotation_ref', 'customer_name', 'status', 'actual_meters', 'completed_at_iso', 'end_date_iso'];
  for (const col of ['actual_roof_m', 'actual_cladding_m', 'actual_flatsheet_m']) {
    if (hasColumn(db, 'production_jobs', col)) cols.push(col);
  }
  return cols.join(', ');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ month?: string, startDate?: string, endDate?: string, branchScope?: string }} opts
 */
export function buildSalesMonthEndPackFromDb(db, opts = {}) {
  const period = resolveSalesMonthEndPeriod(opts);
  if (!period.ok) return period;
  const branchScope = opts.branchScope || 'ALL';
  const { startDate, endDate } = period;
  const loadWarnings = [];
  const tmBranch = branchFilter(db, 'treasury_movements', branchScope, 'tm');
  const dateOk = `SUBSTR(tm.posted_at_iso, 1, 10) >= ? AND SUBSTR(tm.posted_at_iso, 1, 10) <= ?`;

  const treasuryMovements = mustAll(
    db,
    `SELECT tm.id, tm.posted_at_iso, tm.type, tm.amount_ngn, tm.reference, tm.counterparty_name,
            tm.source_kind, tm.source_id, tm.note, ta.name AS account_name, ta.acc_no AS account_no
     FROM treasury_movements tm
     LEFT JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
     WHERE ${dateOk}${tmBranch.sql}
     ORDER BY tm.posted_at_iso ASC, tm.id ASC`,
    [startDate, endDate, ...tmBranch.args]
  ).map((r) => ({
    id: r.id,
    postedAtISO: r.posted_at_iso,
    type: r.type,
    amountNgn: r.amount_ngn,
    reference: r.reference,
    counterpartyName: r.counterparty_name,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    note: r.note,
    accountName: r.account_name,
    accountNo: r.account_no,
  }));

  const malformedTreasury = mustAll(
    db,
    `SELECT tm.id, tm.posted_at_iso, tm.type, tm.amount_ngn, tm.source_id
     FROM treasury_movements tm
     WHERE (tm.posted_at_iso IS NULL OR tm.posted_at_iso NOT LIKE '____-__-__%')${tmBranch.sql}`,
    tmBranch.args
  ).map((r) => ({
    id: r.id,
    postedAtISO: r.posted_at_iso,
    type: r.type,
    amountNgn: r.amount_ngn,
    sourceId: r.source_id,
  }));

  const receiptBranch = branchFilter(db, 'sales_receipts', branchScope, 'sr');
  const bankConfirmedCol = hasColumn(db, 'sales_receipts', 'bank_confirmed_at_iso')
    ? 'sr.bank_confirmed_at_iso'
    : 'NULL';
  const confirmCol = hasColumn(db, 'sales_receipts', 'finance_reconciliation_saved_at_iso')
    ? 'sr.finance_reconciliation_saved_at_iso'
    : bankConfirmedCol;
  const receipts = mustAll(
    db,
    `SELECT sr.id, sr.date_iso, sr.amount_ngn, sr.customer_name, sr.quotation_ref, sr.status,
            ${bankConfirmedCol} AS bank_confirmed_at_iso, ${confirmCol} AS confirmed_at_iso
     FROM sales_receipts sr
     WHERE SUBSTR(sr.date_iso, 1, 10) >= ? AND SUBSTR(sr.date_iso, 1, 10) <= ?${receiptBranch.sql}`,
    [startDate, endDate, ...receiptBranch.args]
  );

  const linked = mustAll(
    db,
    `SELECT tm.id, tm.posted_at_iso, tm.amount_ngn, tm.source_id, sr.date_iso, sr.customer_name
     FROM treasury_movements tm
     INNER JOIN sales_receipts sr ON sr.id = tm.source_id
     WHERE tm.type IN ('RECEIPT_IN', 'RECEIPT_REVERSAL_OUT') AND tm.source_kind = 'LEDGER_RECEIPT'
       AND (
         (SUBSTR(sr.date_iso, 1, 10) >= ? AND SUBSTR(sr.date_iso, 1, 10) <= ?)
         OR (SUBSTR(tm.posted_at_iso, 1, 10) >= ? AND SUBSTR(tm.posted_at_iso, 1, 10) <= ?)
       )${receiptBranch.sql}`,
    [startDate, endDate, startDate, endDate, ...receiptBranch.args]
  );
  const linkedTotalByReceipt = new Map();
  for (const row of linked) {
    const id = String(row.source_id || '');
    if (String(row.date_iso || '').slice(0, 10) < startDate || String(row.date_iso || '').slice(0, 10) > endDate) continue;
    linkedTotalByReceipt.set(id, (linkedTotalByReceipt.get(id) || 0) + (Number(row.amount_ngn) || 0));
  }

  const unmatchedReceiptIns = mustAll(
    db,
    `SELECT tm.id, tm.posted_at_iso, tm.amount_ngn, tm.source_id
     FROM treasury_movements tm
     LEFT JOIN sales_receipts sr ON sr.id = tm.source_id
     WHERE tm.type = 'RECEIPT_IN' AND tm.source_kind = 'LEDGER_RECEIPT' AND sr.id IS NULL
       AND SUBSTR(tm.posted_at_iso, 1, 10) >= ? AND SUBSTR(tm.posted_at_iso, 1, 10) <= ?${tmBranch.sql}`,
    [startDate, endDate, ...tmBranch.args]
  ).map((r) => ({
    id: r.id,
    postedAtISO: r.posted_at_iso,
    amountNgn: r.amount_ngn,
    sourceId: r.source_id,
  }));

  const lateConfirmations = hasColumn(db, 'sales_receipts', 'bank_confirmed_at_iso')
    ? mustAll(
        db,
        `SELECT sr.id, sr.date_iso, sr.bank_confirmed_at_iso, sr.amount_ngn
         FROM sales_receipts sr
         WHERE SUBSTR(sr.bank_confirmed_at_iso, 1, 10) >= ? AND SUBSTR(sr.bank_confirmed_at_iso, 1, 10) <= ?
           AND SUBSTR(sr.date_iso, 1, 10) < ?${receiptBranch.sql}`,
        [startDate, endDate, startDate, ...receiptBranch.args]
      ).map((r) => ({
        id: r.id,
        dateISO: r.date_iso,
        bankConfirmedAtISO: r.bank_confirmed_at_iso,
        amountNgn: r.amount_ngn,
      }))
    : [];

  const appBranch = branchFilter(db, 'refund_credit_applications', branchScope, 'a');
  const creditApplications = tableExists(db, 'refund_credit_applications')
    ? mustAll(
        db,
        `SELECT a.*, ${hasColumn(db, 'sales_receipts', 'branch_id') ? 'sr.branch_id' : 'NULL'} AS source_receipt_branch_id, ${confirmCol} AS confirmed_at_iso
         FROM refund_credit_applications a
         LEFT JOIN sales_receipts sr ON sr.id = a.source_receipt_id
         WHERE 1=1${appBranch.sql}`,
        appBranch.args
      ).map((r) => ({
        applicationId: r.application_id,
        createdAtISO: r.created_at_iso,
        reversedAtISO: r.reversed_at_iso,
        status: r.status,
        amountNgn: r.amount_ngn,
        refundId: r.refund_id,
        sourceQuotationRef: r.source_quotation_ref,
        targetQuotationRef: r.target_quotation_ref,
        sourceReceiptId: r.source_receipt_id,
        customerName: '',
        branchId: r.branch_id,
        sourceReceiptBranchId: r.source_receipt_branch_id,
        confirmedAtISO: r.confirmed_at_iso,
      }))
    : [];

  const refundBranch = branchFilter(db, 'customer_refunds', branchScope, 'cr');
  const refundRows = mustAll(
    db,
    `SELECT cr.refund_id, cr.customer_id, cr.customer_name, cr.quotation_ref, cr.status,
            cr.amount_ngn, cr.approved_amount_ngn, cr.paid_amount_ngn, cr.credit_applied_ngn,
            cr.reason_category, cr.calculation_lines_json
     FROM customer_refunds cr
     WHERE 1=1${refundBranch.sql}`,
    refundBranch.args
  );

  const jobBranch = branchFilter(db, 'production_jobs', branchScope, 'pj');
  const productionJobs = mustAll(
    db,
    `SELECT ${jobSelect(db)} FROM production_jobs pj WHERE 1=1${jobBranch.sql}`,
    jobBranch.args
  ).map(mapJob);

  const quoteBranch = branchFilter(db, 'quotations', branchScope, 'q');
  const waivedCol = hasColumn(db, 'quotations', 'payment_balance_waived_ngn')
    ? 'q.payment_balance_waived_ngn'
    : '0';
  const quotations = mustAll(
    db,
    `SELECT q.id, q.customer_name, q.date_iso, q.total_ngn, q.paid_ngn, q.status, ${waivedCol} AS waived_ngn
     FROM quotations q
     WHERE 1=1${quoteBranch.sql}`,
    quoteBranch.args
  ).map((q) => ({
    id: q.id,
    customer: q.customer_name,
    dateISO: q.date_iso,
    totalNgn: q.total_ngn,
    paidNgn: q.paid_ngn,
    status: q.status,
    paymentBalanceWaivedNgn: q.waived_ngn,
  }));

  const quoteCustomer = new Map(quotations.map((q) => [q.id, q.customer]));
  for (const app of creditApplications) {
    if (!app.customerName) app.customerName = quoteCustomer.get(app.sourceQuotationRef) || quoteCustomer.get(app.targetQuotationRef) || '';
  }

  const classifyIds = new Set();
  for (const movement of treasuryMovements) {
    const type = String(movement.type || '');
    if (type !== 'REFUND_PAYOUT' && type !== 'REFUND_PAYOUT_REVERSAL_IN') continue;
    const refundId = String(movement.sourceId || '').split(':')[0];
    if (refundId) classifyIds.add(refundId);
  }
  for (const app of creditApplications) {
    const created = String(app.createdAtISO || '').slice(0, 10);
    const reversed = String(app.reversedAtISO || '').slice(0, 10);
    const inPeriod = (created >= startDate && created <= endDate) || (reversed >= startDate && reversed <= endDate);
    if (inPeriod && app.refundId) classifyIds.add(String(app.refundId));
  }

  const refunds = refundRows.map((row) => ({
    refundId: row.refund_id,
    customer: row.customer_name,
    quotationRef: row.quotation_ref,
    status: row.status,
    amountNgn: row.amount_ngn,
    approvedAmountNgn: row.approved_amount_ngn,
    paidAmountNgn: row.paid_amount_ngn,
    creditAppliedNgn: row.credit_applied_ngn,
    salesTreatment: classifyIds.has(row.refund_id)
      ? salesTreatmentForRefund(db, row, productionJobs)
      : 'customer_money',
  }));

  const ledgerBranch = branchFilter(db, 'ledger_entries', branchScope, 'le');
  const advanceRow = mustGet(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN le.type = 'ADVANCE_IN' THEN le.amount_ngn ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN le.type IN ('ADVANCE_APPLIED', 'REFUND_ADVANCE', 'ADVANCE_REVERSAL') THEN le.amount_ngn ELSE 0 END), 0)
         AS unapplied_ngn
     FROM ledger_entries le
     WHERE le.type IN ('ADVANCE_IN', 'ADVANCE_APPLIED', 'REFUND_ADVANCE', 'ADVANCE_REVERSAL')${ledgerBranch.sql}`,
    ledgerBranch.args
  );

  let walletOpenNgn = 0;
  if (tableExists(db, 'partner_wallet_entries')) {
    const wBranch = branchFilter(db, 'partner_wallet_entries', branchScope, 'w');
    const row = optionalGet(
      db,
      `SELECT COALESCE(SUM(w.open_ngn), 0) AS open_ngn
       FROM partner_wallet_entries w
       WHERE w.entry_type = 'credit' AND w.open_ngn > 0${wBranch.sql}`,
      wBranch.args,
      loadWarnings,
      'Partner wallet'
    );
    walletOpenNgn = row ? Number(row.open_ngn) || 0 : null;
  }

  let companyCutOpenNgn = 0;
  if (tableExists(db, 'refund_company_retention_entries')) {
    const cBranch = branchFilter(db, 'refund_company_retention_entries', branchScope, 'c');
    const row = optionalGet(
      db,
      `SELECT COALESCE(SUM(c.open_ngn), 0) AS open_ngn
       FROM refund_company_retention_entries c
       WHERE c.entry_type = 'credit' AND c.open_ngn > 0${cBranch.sql}`,
      cBranch.args,
      loadWarnings,
      'Company cut'
    );
    companyCutOpenNgn = row ? Number(row.open_ngn) || 0 : null;
  }

  let suppliersWeOweNgn = null;
  if (tableExists(db, 'accounts_payable')) {
    const apBranch = branchFilter(db, 'accounts_payable', branchScope, 'ap');
    const apRows = optionalAll(
      db,
      `SELECT ap.amount_ngn, ap.paid_ngn FROM accounts_payable ap WHERE 1=1${apBranch.sql}`,
      apBranch.args,
      loadWarnings,
      'Suppliers we owe'
    );
    if (apRows) {
      suppliersWeOweNgn = apRows.reduce(
        (s, r) => s + effectiveOutstandingNgn(Number(r.amount_ngn) || 0, Number(r.paid_ngn) || 0),
        0
      );
    }
  }

  const glAccounts = [];
  if (tableExists(db, 'gl_accounts') && tableExists(db, 'gl_journal_lines') && tableExists(db, 'gl_journal_entries')) {
    const gBranch = branchFilter(db, 'gl_journal_entries', branchScope, 'j');
    const glJoinBranch = gBranch.sql ? ` AND ${gBranch.sql.replace(/^\s*AND\s+/i, '')}` : '';
    const rows = optionalAll(
      db,
      `SELECT a.code, a.name,
              COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN l.debit_ngn ELSE 0 END), 0) AS debit_ngn,
              COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN l.credit_ngn ELSE 0 END), 0) AS credit_ngn
       FROM gl_accounts a
       LEFT JOIN gl_journal_lines l ON l.account_id = a.id
       LEFT JOIN gl_journal_entries j ON j.id = l.journal_id${glJoinBranch}
       WHERE a.code IN ('1200', '2500')
       GROUP BY a.code, a.name`,
      gBranch.args,
      loadWarnings,
      'Account balances'
    );
    for (const row of rows || []) {
      glAccounts.push({
        code: row.code,
        name: row.name,
        debitNgn: row.debit_ngn,
        creditNgn: row.credit_ngn,
      });
    }
  }

  const pack = buildSalesMonthEndPack({
    asOfISO: new Date().toISOString(),
    branchScope,
    month: period.month,
    startDate,
    endDate,
    treasuryMovements,
    malformedTreasury,
    receipts: receipts.map((r) => ({
      id: r.id,
      dateISO: r.date_iso,
      amountNgn: r.amount_ngn,
      customer: r.customer_name,
      quotationRef: r.quotation_ref,
      status: r.status,
      bankConfirmedAtISO: r.bank_confirmed_at_iso,
      linkedTreasuryNgn: linkedTotalByReceipt.get(String(r.id)) || 0,
    })),
    receiptTreasuryLinks: linked.map((r) => ({
      movementId: r.id,
      postedAtISO: r.posted_at_iso,
      amountNgn: r.amount_ngn,
      receiptId: r.source_id,
      receiptDateISO: r.date_iso,
      customer: r.customer_name,
    })),
    unmatchedReceiptIns,
    lateConfirmations,
    creditApplications,
    receiptCatalog: receiptCatalogForCreditSources(db, creditApplications),
    refunds,
    quotations,
    productionJobs,
    unappliedAdvancesNgn: Number(advanceRow?.unapplied_ngn) || 0,
    walletOpenNgn,
    companyCutOpenNgn,
    suppliersWeOweNgn,
    glAccounts,
  });
  for (const warning of loadWarnings) pack.exceptions.push(warning);
  pack.loadWarnings = loadWarnings;
  return pack;
}
