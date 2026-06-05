/**
 * AP2c — AP / inventory / GL alignment diagnostics (management tie-out).
 */
import { trialBalanceRows } from './glOps.js';
import { buildSupplierAdvanceReport } from './ap2SupplierAdvanceOps.js';
import { buildInventoryValuationReport } from './ap2InventoryValuationOps.js';
import {
  listPurchaseOrdersForAp2Scope,
  parsePeriodKey,
  roundMoney,
  tableExists,
} from './ap2ReceivedBasisOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';
import { describeSupplierAdvanceGlCapability } from './ap2SupplierAdvanceGl.js';

function glActivityForAccount(db, code, startISO, endISO) {
  if (!tableExists(db, 'gl_journal_entries')) return null;
  const tb = trialBalanceRows(db, startISO, endISO);
  if (!tb.ok) return { found: false, debitNgn: 0, creditNgn: 0, netNgn: 0 };
  const row = (tb.rows || tb.detail || []).find((r) => String(r.accountCode) === code);
  if (!row) return { found: false, debitNgn: 0, creditNgn: 0, netNgn: 0 };
  const debit = roundMoney(row.debitNgn);
  const credit = roundMoney(row.creditNgn);
  return { found: true, debitNgn: debit, creditNgn: credit, netNgn: roundMoney(row.netNgn ?? debit - credit) };
}

function grnInventoryGlTotal(db, startISO, endISO) {
  if (!tableExists(db, 'gl_journal_entries')) return null;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit_ngn), 0) AS d
       FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_id
       JOIN gl_accounts ga ON ga.id = jl.account_id
       WHERE ga.code = '1300'
         AND je.entry_date_iso >= ? AND je.entry_date_iso <= ?
         AND UPPER(COALESCE(je.source_kind,'')) IN ('GRN_INVENTORY','INVENTORY_RECEIPT','COIL_GRN')`
    )
    .get(startISO, endISO);
  return roundMoney(row?.d);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; period?: string | null }} [opts]
 */
export function buildApInventoryGlAlignmentReport(db, opts = {}) {
  const flags = readFinanceFeatureFlags();
  if (!flags.apGlAlignmentDiagnosticsEnabled) {
    return {
      ok: true,
      status: 'disabled',
      label: 'AP / inventory / GL alignment',
      message: 'AP_GL_ALIGNMENT_DIAGNOSTICS_ENABLED=0',
    };
  }

  const period = opts.period ? parsePeriodKey(opts.period) : parsePeriodKey(new Date().toISOString().slice(0, 7));
  const startISO = period?.startISO || '2020-01-01';
  const endISO = period?.endISO || new Date().toISOString().slice(0, 10);
  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';

  const invReport = buildInventoryValuationReport(db, { ...opts, period: period?.key });
  const advReport = buildSupplierAdvanceReport(db, opts);
  const supplierAdvanceGl = describeSupplierAdvanceGlCapability(db);

  const receivedNotPaidNgn = advReport.summary?.totalReceivedNotPaidNgn ?? 0;
  const supplierAdvanceNgn = advReport.summary?.totalSupplierAdvanceNgn ?? 0;
  const accountingInventoryNgn = invReport.accountingValueNgn ?? 0;

  const gl1300 = glActivityForAccount(db, '1300', startISO, endISO);
  const gl2100 = glActivityForAccount(db, '2100', startISO, endISO);
  const gl1400 = glActivityForAccount(db, '1400', startISO, endISO);
  const grnGlDebit = grnInventoryGlTotal(db, startISO, endISO);

  const checks = [];
  let warningCount = 0;

  if (!gl1300?.found) {
    checks.push({
      id: 'inventory_gl_missing',
      level: 'warning',
      title: 'GL inventory account 1300',
      message: 'Chart of accounts 1300 not found or no activity — cannot tie GRN inventory to GL.',
    });
    warningCount += 1;
  } else {
    const delta = accountingInventoryNgn - (grnGlDebit ?? gl1300.netNgn);
    const material = Math.abs(delta) > accountingInventoryNgn * 0.15 && accountingInventoryNgn > 0;
    checks.push({
      id: 'inventory_vs_gl_1300',
      level: material ? 'warning' : 'info',
      title: 'GRN inventory vs GL 1300',
      message: `Coil accounting value ${accountingInventoryNgn.toLocaleString()} vs GL 1300 period net/debits (management tie-out).`,
      accountingInventoryNgn,
      gl1300NetNgn: gl1300.netNgn,
      grnGlDebitNgn: grnGlDebit,
      differenceNgn: delta,
    });
    if (material) warningCount += 1;
  }

  if (!gl2100?.found) {
    checks.push({
      id: 'grni_gl_missing',
      level: 'warning',
      title: 'GRNI / liability GL 2100',
      message: 'Account 2100 not available — AP/GRNI tie-out incomplete.',
    });
    warningCount += 1;
  } else {
    const delta = receivedNotPaidNgn - roundMoney(gl2100.creditNgn - gl2100.debitNgn);
    checks.push({
      id: 'ap_vs_grni_2100',
      level: Math.abs(delta) > 50000 ? 'warning' : 'info',
      title: 'Received not paid vs GRNI 2100',
      message: 'Compare operational received-not-paid to GRNI liability movement (approximate).',
      receivedNotPaidNgn,
      gl2100CreditNgn: gl2100.creditNgn,
      differenceNgn: delta,
    });
    if (Math.abs(delta) > 50000) warningCount += 1;
  }

  if (supplierAdvanceNgn > 0) {
    if (!supplierAdvanceGl.accountConfigured || !supplierAdvanceGl.postingEnabled) {
      checks.push({
        id: 'advance_no_gl',
        level: 'warning',
        title: 'Supplier advance not in GL',
        message: `${supplierAdvanceNgn.toLocaleString()} operational advance with no 1400 posting (expected until enabled).`,
        supplierAdvanceNgn,
      });
      warningCount += 1;
    } else if (gl1400?.found) {
      const delta = supplierAdvanceNgn - gl1400.netNgn;
      checks.push({
        id: 'advance_vs_gl_1400',
        level: Math.abs(delta) > 10000 ? 'warning' : 'info',
        title: 'Supplier advance vs GL 1400',
        message: 'Operational advance compared to GL 1400 balance.',
        supplierAdvanceNgn,
        gl1400NetNgn: gl1400.netNgn,
        differenceNgn: delta,
      });
      if (Math.abs(delta) > 10000) warningCount += 1;
    }
  }

  if ((invReport.missingCostCount || 0) > 0) {
    checks.push({
      id: 'missing_cost_cogs',
      level: 'critical',
      title: 'Missing cost affects COGS',
      message: `${invReport.missingCostCount} coil(s) lack landed/unit cost — material COGS and profit at risk.`,
      missingCostCount: invReport.missingCostCount,
    });
    warningCount += 1;
  }

  if (advReport.summary?.paidNotReceivedCount > 0 && !supplierAdvanceGl.postingEnabled) {
    checks.push({
      id: 'paid_not_received_no_gl',
      level: 'warning',
      title: 'Paid not received without advance GL',
      message: `${advReport.summary.paidNotReceivedCount} PO(s) paid with low/no GRN — review prepayment.`,
      count: advReport.summary.paidNotReceivedCount,
    });
    warningCount += 1;
  }

  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'AP / inventory / GL alignment',
    disclaimer: 'Management tie-out only — not statutory audit.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
    generatedAtISO: new Date().toISOString(),
    warningCount,
    checks,
    supplierAdvanceGl,
    summary: {
      accountingInventoryNgn,
      receivedNotPaidNgn,
      supplierAdvanceNgn,
      missingCostCount: invReport.missingCostCount ?? 0,
    },
    notes: [
      'GL mapping may be incomplete for legacy supplier payments.',
      'Enable SUPPLIER_ADVANCE_ACCOUNTING_ENABLED only after Head of Accounts review.',
    ],
  };
}

export function buildGlAlignmentTrialSummary(db, branchScope = 'ALL') {
  const r = buildApInventoryGlAlignmentReport(db, {
    branchId: branchScope === 'ALL' ? null : branchScope,
  });
  if (r.status === 'disabled') return { available: false };
  return {
    available: true,
    warningCount: r.warningCount,
    missingCostCount: r.summary?.missingCostCount ?? 0,
  };
}
