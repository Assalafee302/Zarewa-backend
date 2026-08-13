/**
 * Executive Command Centre — composes existing BI, exec summary, and management inbox.
 *
 * Metric scope (see docs/EXEC_COMMAND_CENTRE.md):
 * - Period-aware: sales, collections, expenses, branch scorecard via resolveBiPeriodBounds.
 * - BI lookback: SKU weeks-cover, cash horizons (labelled estimated).
 * - Point-in-time: receivables, customer debt.
 * - Company-wide counts: payroll MD sign-off, bank reconciliation (when not branch-filterable).
 */
import { BI_ENGINE_REV } from '../shared/lib/businessIntelligence.js';
import {
  firstProductionDateISO,
  receivableDueOnQuotationFromEntries,
} from '../shared/lib/customerLedgerCore.js';
import { getBranch } from './branches.js';
import { canUseAllBranchesRollup, userHasPermission } from './auth.js';
import {
  loadBusinessIntelligencePack,
  loadBusinessIntelligenceSourceSlices,
} from './businessIntelligenceOps.js';
import {
  annotateExecWorkTrayApprovalTiers,
  sortExecWorkTrayByApprovalTier,
  summarizeExecWorkTrayApprovalTiers,
} from '../shared/lib/execApprovalTier.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';
import { buildMdCockpitPulses, buildChampionCustomerSnippet } from './mdCockpitOps.js';
import { buildMdOperationsPack } from './mdOperationsPack.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { listOfficeThreads, officeTablesReady } from './officeOps.js';
import { listStockRegisterInbox } from './stockRegisterOps.js';
import { listUnifiedWorkItems, workRegistryTablesReady } from './workItems.js';
import { buildMaterialCostingPanel } from './execCostingOps.js';
import {
  actorCanManageReservePolicy,
  buildReservePolicyReadiness,
} from './execReservePolicyOps.js';
import { buildStaffActivitySummary } from './execStaffActivityOps.js';
import { buildExecTargetsPanel } from './execTargetsOps.js';
import {
  listRegisterSettlements,
  listRegisterSettlementsAwaitingPayment,
} from './accountingRegisterSettlementOps.js';
import {
  buildPayablesOutflowsSummary,
  buildWorkingCapitalSnapshot,
} from './execWorkingCapitalOps.js';
import {
  branchWhere,
  execOrgSummary,
  listLedgerEntries,
  listProductionJobs,
  listQuotations,
  listTreasuryAccounts,
} from './readModel.js';

const SKU_LOOKBACK_DEMAND_LABEL =
  'Weeks-cover uses BI production-demand lookback (~4 months), not the dashboard period filter alone.';

const PRODUCTIVE_EXPENSE_CATEGORIES = new Set([
  'Purchases',
  'Accessories',
  'Carriage inward',
  'Production cost',
  'Closing stock',
  'Outside corrugation',
]);

function isoDateOnly(s) {
  return String(s || '').trim().slice(0, 10);
}

function addDaysISO(iso, delta) {
  const d = new Date(`${isoDateOnly(iso)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDateOnly(new Date());
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** @param {number} year full year @param {number} monthIndex0 0-based month */
function lastDayOfMonth(year, monthIndex0) {
  const y = Number(year);
  const m = Number(monthIndex0);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 0 || m > 11) {
    return isoDateOnly(new Date());
  }
  const d = new Date(Date.UTC(y, m + 1, 0));
  if (Number.isNaN(d.getTime())) return `${y}-${String(m + 1).padStart(2, '0')}-28`;
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{ periodKey?: string; startISO?: string; endISO?: string }} opts
 */
export function resolveExecDashboardPeriod(opts = {}) {
  const key = String(opts.periodKey || 'month').trim().toLowerCase();
  const today = isoDateOnly(new Date());
  let startISO = isoDateOnly(opts.startISO);
  let endISO = isoDateOnly(opts.endISO) || today;

  if (key === 'custom' && startISO && endISO) {
    return { key: 'custom', startISO, endISO, biPeriodKey: 'custom', kpiPeriodAware: true };
  }
  if (key === 'today') {
    return { key: 'today', startISO: today, endISO: today, biPeriodKey: 'custom', kpiPeriodAware: true };
  }
  if (key === 'week') {
    return {
      key: 'week',
      startISO: addDaysISO(today, -6),
      endISO: today,
      biPeriodKey: 'custom',
      kpiPeriodAware: true,
    };
  }
  if (key === 'last_month') {
    const d = new Date();
    let y = d.getFullYear();
    let m = d.getMonth() - 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    startISO = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    endISO = lastDayOfMonth(y, m);
    return {
      key: 'last_month',
      startISO,
      endISO,
      biPeriodKey: 'custom',
      asOfISO: endISO,
      kpiPeriodAware: true,
    };
  }
  startISO = `${today.slice(0, 7)}-01`;
  return {
    key: 'month',
    startISO,
    endISO: today,
    biPeriodKey: 'month',
    asOfISO: today,
    kpiPeriodAware: true,
  };
}

const BI_LOOKBACK_SCOPE_NOTE =
  'Sales, collections, and expenses follow your selected period. SKU weeks-cover and cash-pressure horizons use BI demand lookback (estimated).';

/**
 * @param {{ key?: string; biPeriodKey?: string; kpiPeriodAware?: boolean }} period
 * @param {{ skuUsesBiLookback?: boolean; cashUsesBiLookback?: boolean }} [opts]
 */
export function buildExecDataScopeNotes(period, opts = {}) {
  /** @type {{ id: string; level: string; message: string }[]} */
  const notes = [];
  if (opts.skuUsesBiLookback !== false || opts.cashUsesBiLookback !== false) {
    notes.push({ id: 'bi-lookback-partial', level: 'info', message: BI_LOOKBACK_SCOPE_NOTE });
  }
  const key = String(period?.key || 'month').trim().toLowerCase();
  if (opts.cashUsesBiLookback !== false && key !== 'month') {
    notes.push({
      id: 'cash-horizon-lookback',
      level: 'info',
      message:
        'Cash-pressure horizons use a recent treasury activity average (estimated). They do not change with the period filter.',
    });
  }
  return notes;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
export function buildScopedExecutiveCounts(db, branchScope) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const isAll = scope === 'ALL';

  const countRow = (sql, args, scopeBasis) => ({
    count: Number(db.prepare(sql).get(...args)?.c) || 0,
    scopeBasis,
  });

  const bRef = branchWhere(db, 'customer_refunds', scope);
  const pendingRefunds = countRow(
    `SELECT COUNT(*) AS c FROM customer_refunds
     WHERE TRIM(LOWER(IFNULL(status,''))) IN ('pending','submitted','awaiting approval')${bRef.sql}`,
    bRef.args,
    isAll ? 'company' : 'branch'
  );

  let pendingPaymentRequests = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    const bExp = branchWhere(db, 'expenses', scope);
    pendingPaymentRequests = countRow(
      `SELECT COUNT(*) AS c FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE TRIM(IFNULL(pr.approval_status,'')) IN ('Pending','Submitted','Awaiting approval','')${bExp.sql.replace(/branch_id/g, 'e.branch_id')}`,
      bExp.args,
      isAll ? 'company' : 'branch'
    );
  } catch {
    pendingPaymentRequests = countRow(
      `SELECT COUNT(*) AS c FROM payment_requests WHERE TRIM(IFNULL(approval_status,'')) IN ('Pending','Submitted','Awaiting approval','')`,
      [],
      'company'
    );
  }

  let payrollDraftsAwaitingMd = { count: 0, scopeBasis: 'company' };
  try {
    payrollDraftsAwaitingMd = countRow(
      `SELECT COUNT(*) AS c FROM hr_payroll_runs
       WHERE LOWER(TRIM(IFNULL(status,''))) = 'draft'
         AND (md_approved_at_iso IS NULL OR TRIM(IFNULL(md_approved_at_iso,'')) = '')`,
      [],
      'company'
    );
  } catch {
    /* optional HR */
  }

  let materialIncidentsPendingApproval = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_incidents'`).get()) {
      const bMex = branchWhere(db, 'material_incidents', scope);
      materialIncidentsPendingApproval = countRow(
        `SELECT COUNT(*) AS c FROM material_incidents WHERE status = 'submitted'${bMex.sql}`,
        bMex.args,
        isAll ? 'company' : 'branch'
      );
    }
  } catch {
    /* optional */
  }

  let priceExceptionsPendingMd = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    const bQuo = branchWhere(db, 'quotations', scope);
    priceExceptionsPendingMd = countRow(
      `SELECT COUNT(*) AS c FROM quotations
       WHERE price_exception_md_review_required = 1
         AND (md_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(md_price_exception_approved_at_iso,'')) = '')
         AND (price_exception_md_confirmed_at_iso IS NULL OR TRIM(IFNULL(price_exception_md_confirmed_at_iso,'')) = '')${bQuo.sql}`,
      bQuo.args,
      isAll ? 'company' : 'branch'
    );
  } catch {
    /* optional columns */
  }

  let pendingProductionJobs = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    const bJob = branchWhere(db, 'production_jobs', scope);
    pendingProductionJobs = countRow(
      `SELECT COUNT(*) AS c FROM production_jobs
       WHERE status IN ('Planned', 'Running')${bJob.sql}`,
      bJob.args,
      isAll ? 'company' : 'branch'
    );
  } catch {
    /* optional */
  }

  let stockRegisterPendingMd = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    const branchIds =
      scope === 'ALL'
        ? db
            .prepare(`SELECT id FROM branches WHERE active = 1 ORDER BY id`)
            .all()
            .map((r) => r.id)
        : [scope];
    let n = 0;
    for (const bid of branchIds) {
      const inbox = listStockRegisterInbox(db, bid, 'md');
      n += (inbox.items || []).length;
    }
    stockRegisterPendingMd = {
      count: n,
      scopeBasis: isAll ? 'company' : 'branch',
    };
  } catch {
    /* optional */
  }

  let pendingRegisterSettlements = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    pendingRegisterSettlements = {
      count: (listRegisterSettlements(db, {
        status: 'Pending',
        branchId: isAll ? null : scope,
      }).items || []).length,
      scopeBasis: isAll ? 'company' : 'branch',
    };
  } catch {
    /* optional */
  }

  let approvedRegisterSettlementsAwaitingPay = { count: 0, scopeBasis: isAll ? 'company' : 'branch' };
  try {
    approvedRegisterSettlementsAwaitingPay = {
      count: listRegisterSettlementsAwaitingPayment(db, scope).length,
      scopeBasis: isAll ? 'company' : 'branch',
    };
  } catch {
    /* optional */
  }

  const org = execOrgSummary(db);
  return {
    pendingRefunds,
    pendingPaymentRequests,
    payrollDraftsAwaitingMd,
    materialIncidentsPendingApproval,
    priceExceptionsPendingMd,
    pendingProductionJobs,
    stockRegisterPendingMd,
    pendingRegisterSettlements,
    approvedRegisterSettlementsAwaitingPay,
    bankReconciliationLinesInReview: {
      count: org.bankReconciliationLinesInReview ?? 0,
      scopeBasis: 'company',
    },
    branchScope: scope,
  };
}

/**
 * @param {{ days0_30?: number; days31_60?: number; days61_90?: number; days90_plus?: number }} aging
 * @param {number} debtNgn
 */
export function classifyCustomerDebtRisk(aging, debtNgn) {
  const total = Math.round(Number(debtNgn) || 0);
  const over90 = Math.round(Number(aging?.days90_plus) || 0);
  const over60 = Math.round(Number(aging?.days61_90) || 0) + over90;
  const over30 = Math.round(Number(aging?.days31_60) || 0) + over60;
  if (total <= 0) return 'Fresh';
  if (over90 >= 1_000_000 || over90 / total >= 0.4) return 'Critical';
  if (over60 >= 500_000 || over60 / total >= 0.5) return 'High Risk';
  if (over30 > 0) return 'Watch';
  return 'Fresh';
}

/** @param {{ days0_30?: number; days31_60?: number; days61_90?: number; days90_plus?: number }} aging */
export function agingSeverityScore(aging) {
  return (
    (Number(aging?.days90_plus) || 0) * 4 +
    (Number(aging?.days61_90) || 0) * 3 +
    (Number(aging?.days31_60) || 0) * 2 +
    (Number(aging?.days0_30) || 0)
  );
}

/**
 * Branch-level outstanding receivables from preloaded slices (no extra DB reads).
 * @param {object[]} quotations
 * @param {object[]} ledger
 * @param {object[]} jobs
 */
export function buildBranchDebtTotalsMap(quotations, ledger, jobs) {
  /** @type {Map<string, number>} */
  const branchDebtMap = new Map();
  for (const q of quotations) {
    const due = receivableDueOnQuotationFromEntries(ledger, q, jobs);
    if (due <= 0) continue;
    const bid = String(q.branchId || q.branch_id || 'UNASSIGNED').trim();
    branchDebtMap.set(bid, (branchDebtMap.get(bid) || 0) + due);
  }
  return branchDebtMap;
}

/**
 * Outstanding customer debt as at a date (point-in-time; not period-filtered).
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {string} [asOfISO]
 * @param {{ quotations?: object[]; ledgerEntries?: object[]; productionJobs?: object[] }} [preloaded]
 */
export function topCustomersByDebt(db, branchScope, asOfISO, preloaded = null) {
  const asOf = isoDateOnly(asOfISO || new Date());
  const quotations = preloaded?.quotations ?? listQuotations(db, branchScope);
  const ledger = preloaded?.ledgerEntries ?? listLedgerEntries(db, branchScope);
  const jobs = preloaded?.productionJobs ?? listProductionJobs(db, branchScope);
  const asOfDate = new Date(`${asOf}T00:00:00`);
  /** @type {Map<string, object>} */
  const byCustomer = new Map();

  for (const q of quotations) {
    const due = receivableDueOnQuotationFromEntries(ledger, q, jobs);
    if (due <= 0) continue;
    const cid = String(q.customerID || q.customer_id || '').trim();
    if (!cid) continue;
    const curr = byCustomer.get(cid) || {
      customerID: cid,
      customerName: String(q.customer || q.customer_name || cid).trim(),
      debtNgn: 0,
      quotationCount: 0,
      aging: { days0_30: 0, days31_60: 0, days61_90: 0, days90_plus: 0 },
    };
    const ref = String(q.id || '').trim();
    const basis =
      firstProductionDateISO(ref, jobs) || isoDateOnly(q.dueDateISO || q.dateISO);
    const basisDate = basis ? new Date(`${basis}T00:00:00`) : null;
    let band = 'days0_30';
    if (basisDate && !Number.isNaN(basisDate.getTime()) && !Number.isNaN(asOfDate.getTime())) {
      const diffDays = Math.floor((asOfDate.getTime() - basisDate.getTime()) / 86400000);
      if (diffDays > 90) band = 'days90_plus';
      else if (diffDays > 60) band = 'days61_90';
      else if (diffDays > 30) band = 'days31_60';
    }
    const amt = Math.round(due);
    curr.debtNgn += amt;
    curr.quotationCount += 1;
    curr.aging[band] += amt;
    byCustomer.set(cid, curr);
  }

  const rows = [...byCustomer.values()].map((r) => {
    const debtRiskLabel = classifyCustomerDebtRisk(r.aging, r.debtNgn);
    const severityScore = agingSeverityScore(r.aging);
    const primaryAgingBand =
      r.aging.days90_plus > 0
        ? '90+'
        : r.aging.days61_90 > 0
          ? '61-90'
          : r.aging.days31_60 > 0
            ? '31-60'
            : '0-30';
    return {
      customerID: r.customerID,
      customerName: r.customerName,
      debtNgn: r.debtNgn,
      quotationCount: r.quotationCount,
      aging: r.aging,
      asOfISO: asOf,
      basisLabel: `Current outstanding as at ${asOf}`,
      debtRiskLabel,
      primaryAgingBand,
      severityScore,
      route: `/customers/${encodeURIComponent(r.customerID)}`,
      ledgerRoute: '/accounts',
      reportsRoute: '/reports',
    };
  });

  rows.sort((a, b) => b.severityScore - a.severityScore || b.debtNgn - a.debtNgn);
  return rows.slice(0, 15);
}

function branchName(db, branchId) {
  if (!branchId) return '—';
  const b = getBranch(db, branchId);
  return b?.name || branchId;
}

function daysSinceLabel(iso) {
  const s = String(iso || '').trim();
  if (!s) return '—';
  const t = Date.parse(s.length <= 10 ? `${s}T12:00:00` : s);
  if (Number.isNaN(t)) return '—';
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function priorityBand(score) {
  if (score >= 85) return 'high';
  if (score >= 65) return 'medium';
  return 'low';
}

function canAccessAttentionInbox(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  return (
    userHasPermission(user, 'audit.view') ||
    userHasPermission(user, 'refunds.approve') ||
    userHasPermission(user, 'sales.manage') ||
    userHasPermission(user, 'quotations.manage')
  );
}

function actorCanActOnApprovals(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  return (
    userHasPermission(user, 'refunds.approve') ||
    userHasPermission(user, 'finance.approve') ||
    userHasPermission(user, 'hr.payroll.md_approve') ||
    userHasPermission(user, 'inter_branch_loan.md_approve') ||
    userHasPermission(user, 'material_incidents.approve') ||
    userHasPermission(user, 'md.price_exception.approve')
  );
}

function canActOnWorkItemKind(user, kind) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const k = String(kind || '').toLowerCase();
  if (k === 'refunds') return userHasPermission(user, 'refunds.approve') || userHasPermission(user, 'finance.approve');
  if (k === 'register_settlement') {
    return userHasPermission(user, 'refunds.approve') || userHasPermission(user, 'finance.approve');
  }
  if (k === 'payments') return userHasPermission(user, 'finance.approve');
  if (k === 'material') return userHasPermission(user, 'material_incidents.approve');
  if (k === 'edit_approvals') return userHasPermission(user, 'audit.view') || userHasPermission(user, 'quotations.manage');
  if (k === 'payroll') return userHasPermission(user, 'hr.payroll.md_approve');
  if (k === 'inter_branch_loan') return userHasPermission(user, 'inter_branch_loan.md_approve');
  if (k === 'staff_purchase_credit') {
    const rk = String(user?.roleKey || '').toLowerCase();
    return rk === 'md' || rk === 'admin' || userHasPermission(user, '*');
  }
  if (k === 'stock_register') {
    const rk = String(user?.roleKey || '').toLowerCase();
    return (
      rk === 'md' ||
      rk === 'admin' ||
      rk === 'ceo' ||
      rk === 'chairman' ||
      userHasPermission(user, 'sales.manage') ||
      userHasPermission(user, 'quotations.manage')
    );
  }
  if (k === 'price_exception') return userHasPermission(user, 'md.price_exception.approve');
  if (k === 'conversions') return userHasPermission(user, 'refunds.approve') || userHasPermission(user, 'production.manage');
  if (k === 'office_memo' || k === 'work_item') return userHasPermission(user, 'office.use');
  return actorCanActOnApprovals(user);
}

function workItemRoute(kind, row = {}) {
  const k = String(kind || '').toLowerCase();
  if (k === 'refunds') return '/manager';
  if (k === 'register_settlement') return '/exec?tab=decide';
  if (k === 'payments') return '/manager';
  if (k === 'material') return '/operations/material-exceptions';
  if (k === 'edit_approvals') return '/manager';
  if (k === 'payroll') return '/exec?tab=decide';
  if (k === 'inter_branch_loan') return '/exec?tab=decide';
  if (k === 'stock_register') return '/exec?tab=decide';
  if (k === 'staff_purchase_credit') return '/exec?tab=decide';
  if (k === 'price_exception') return '/exec';
  if (k === 'conversions') return '/exec';
  if (k === 'office_memo' || k === 'work_item') return '/office';
  if (k === 'clearance' || k === 'flagged' || k === 'production') {
    const ref = row.quotationRef || row.quotation_ref || row.title;
    return ref ? `/sales?quotation=${encodeURIComponent(ref)}` : '/manager';
  }
  return '/manager';
}

function mapAttentionToWorkTray(db, attention, user, readOnly) {
  const items = [];
  for (const it of attention.items || []) {
    const kind = it.kind || 'other';
    const branchId = it.branchId || it.row?.branch_id || '';
    const requestedBy =
      it.row?.requested_by ||
      it.row?.requested_by_user_id ||
      it.row?.handled_by ||
      it.subtitle ||
      '—';
    items.push({
      id: it.id,
      kind,
      priority: priorityBand(Number(it.priority) || 50),
      title: it.title || kind,
      branchId: branchId || '',
      branchName: branchName(db, branchId),
      amountNgn: it.amountNgn != null ? Math.round(Number(it.amountNgn) || 0) : null,
      requestedBy: String(requestedBy).slice(0, 80),
      ageLabel: daysSinceLabel(it.atIso),
      status: 'Approval Pending',
      route: workItemRoute(kind, it),
      quotationRef: String(it.quotationRef || it.row?.id || it.row?.quotation_ref || '').trim() || undefined,
      reviewContext: {
        quotationRef: String(it.quotationRef || it.row?.id || it.row?.quotation_ref || '').trim(),
        jobId: String(it.jobId || it.row?.job_id || '').trim(),
        refundId: String(it.refundId || it.row?.refund_id || it.row?.refundId || '').trim(),
        settlementId: String(it.settlementId || it.row?.settlementId || it.row?.settlement_id || '').trim(),
        requestId: String(it.requestId || it.row?.request_id || '').trim(),
        cuttingListId: String(it.cuttingListId || it.row?.id || '').trim(),
        materialIncidentId: String(it.row?.id || '').trim(),
        editApprovalId: String(it.row?.id || '').trim(),
        accountId: String(it.accountId || it.row?.id || '').trim(),
        payrollRunId: String(it.row?.id || it.row?.run_id || '').trim(),
        loanId: String(it.loanId || it.row?.loan_id || '').trim(),
        periodKey: String(it.row?.periodKey || it.row?.period_key || '').trim(),
        branchIdForRegister: String(it.branchId || it.row?.branch_id || branchId || '').trim(),
        reasons: Array.isArray(it.reasons) ? it.reasons : [],
        subtitle: String(it.subtitle || '').trim(),
        row: it.row || {},
      },
      summaryOnly: false,
      canAct: !readOnly && canActOnWorkItemKind(user, kind),
    });
  }
  return items;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
function listExecutiveExtras(db, branchScope) {
  /** @type {object[]} */
  const extras = [];
  try {
    const payrollRows = db
      .prepare(
        `SELECT id, period_yyyymm, status, created_at_iso
         FROM hr_payroll_runs
         WHERE LOWER(TRIM(IFNULL(status,''))) = 'draft'
           AND (md_approved_at_iso IS NULL OR TRIM(IFNULL(md_approved_at_iso,'')) = '')
         ORDER BY created_at_iso DESC LIMIT 20`
      )
      .all();
    for (const r of payrollRows) {
      extras.push({
        id: `payroll:${r.id}`,
        kind: 'payroll',
        priority: 'high',
        title: `Payroll ${r.period_yyyymm || r.id}`,
        branchId: '',
        branchName: 'Company-wide',
        amountNgn: null,
        requestedBy: 'HR',
        ageLabel: daysSinceLabel(r.created_at_iso),
        status: 'MD sign-off required',
        route: '/exec?tab=decide',
        reviewContext: {
          payrollRunId: r.id,
          reasons: ['Payroll MD sign-off required before lock'],
          subtitle: r.period_yyyymm || '',
          row: r,
        },
      });
    }
  } catch {
    /* HR tables optional */
  }

  try {
    const loans = db
      .prepare(
        `SELECT loan_id, lender_branch_id, borrower_branch_id, principal_ngn, status, created_at_iso
         FROM inter_branch_loans
         WHERE LOWER(TRIM(IFNULL(status,''))) = 'pending_md'
         ORDER BY created_at_iso DESC LIMIT 20`
      )
      .all();
    for (const r of loans) {
      extras.push({
        id: `ibl:${r.loan_id}`,
        kind: 'inter_branch_loan',
        priority: 'high',
        title: `Inter-branch loan ${r.loan_id}`,
        branchId: r.borrower_branch_id || r.lender_branch_id || '',
        branchName: `${branchName(db, r.lender_branch_id)} → ${branchName(db, r.borrower_branch_id)}`,
        amountNgn: Math.round(Number(r.principal_ngn) || 0),
        requestedBy: 'Treasury',
        ageLabel: daysSinceLabel(r.created_at_iso),
        status: String(r.status || 'Pending'),
        route: '/exec?tab=decide',
        reviewContext: {
          loanId: r.loan_id,
          reasons: ['Inter-branch loan requires MD approval'],
          subtitle: `${branchName(db, r.lender_branch_id)} → ${branchName(db, r.borrower_branch_id)}`,
          row: r,
        },
      });
    }
  } catch {
    /* optional */
  }

  try {
    const bQuo = branchWhere(db, 'quotations', branchScope);
    const priceRows = db
      .prepare(
        `SELECT id, customer_name, total_ngn, date_iso, branch_id
         FROM quotations
         WHERE price_exception_md_review_required = 1
           AND (md_price_exception_approved_at_iso IS NULL OR TRIM(IFNULL(md_price_exception_approved_at_iso,'')) = '')
           AND (price_exception_md_confirmed_at_iso IS NULL OR TRIM(IFNULL(price_exception_md_confirmed_at_iso,'')) = '')
           ${bQuo.sql}
         ORDER BY date_iso DESC LIMIT 20`
      )
      .all(...bQuo.args);
    for (const r of priceRows) {
      extras.push({
        id: `price:${r.id}`,
        kind: 'price_exception',
        priority: 'high',
        title: `Below-floor quote ${r.id}`,
        branchId: r.branch_id || '',
        branchName: branchName(db, r.branch_id),
        amountNgn: Math.round(Number(r.total_ngn) || 0),
        requestedBy: 'Sales / branch',
        ageLabel: daysSinceLabel(r.date_iso),
        status: 'MD approval required',
        route: `/exec`,
        quotationRef: r.id,
        reviewContext: {
          quotationRef: r.id,
          reasons: ['Below-floor pricing — MD approval required'],
          subtitle: r.customer_name || '',
          row: r,
        },
      });
    }
  } catch {
    /* optional */
  }

  try {
    const branchIds =
      branchScope === 'ALL'
        ? db
            .prepare(`SELECT id FROM branches WHERE active = 1 ORDER BY id`)
            .all()
            .map((r) => r.id)
        : [branchScope];
    for (const bid of branchIds) {
      const inbox = listStockRegisterInbox(db, bid, 'md');
      for (const row of inbox.items || []) {
        const periodKey = row.periodKey || row.period_key || '—';
        extras.push({
          id: `stockreg:${bid}:${periodKey}`,
          kind: 'stock_register',
          priority: 'medium',
          title: `Stock register ${periodKey}`,
          branchId: bid,
          branchName: branchName(db, bid),
          amountNgn: null,
          requestedBy: 'Procurement',
          ageLabel: '—',
          status: 'MD approval on register',
          route: '/exec?tab=decide',
          reviewContext: {
            branchIdForRegister: bid,
            periodKey,
            reasons: ['Month-end stock register awaiting MD approval'],
            subtitle: branchName(db, bid),
            row: { ...row, branch_id: bid, periodKey },
          },
        });
      }
    }
  } catch {
    /* optional */
  }

  return extras;
}

/**
 * One summary row per queue kind (CEO / users without full management inbox).
 * @param {object} scopedCounts
 */
export function buildQueueSummaryTray(scopedCounts) {
  /** @type {object[]} */
  const items = [];
  const pushSummary = (metric, kind, titlePrefix, route) => {
    const n = Number(metric?.count ?? metric) || 0;
    if (n <= 0) return;
    const scopeBasis = metric?.scopeBasis || 'company';
    items.push({
      id: `${kind}:summary`,
      kind,
      priority: n > 3 ? 'high' : 'medium',
      title: `${titlePrefix} — ${n} item${n === 1 ? '' : 's'}`,
      branchName: scopeBasis === 'branch' ? 'This branch' : 'Company-wide',
      branchId: '',
      amountNgn: null,
      requestedBy: '—',
      ageLabel: '—',
      status: 'Summary',
      route,
      summaryOnly: true,
      scopeBasis,
      canAct: false,
    });
  };
  pushSummary(scopedCounts.pendingRefunds, 'refunds', 'Refund approvals pending', '/manager');
  pushSummary(
    scopedCounts.pendingRegisterSettlements,
    'register_settlement',
    'Register withdrawals pending',
    '/accounting'
  );
  pushSummary(
    scopedCounts.approvedRegisterSettlementsAwaitingPay,
    'register_settlement_payout',
    'Register withdrawals awaiting payout',
    '/accounts?tab=desk'
  );
  pushSummary(scopedCounts.pendingPaymentRequests, 'payments', 'Payment requests pending', '/manager');
  pushSummary(
    scopedCounts.payrollDraftsAwaitingMd,
    'payroll',
    'Payroll awaiting MD sign-off',
    '/hr/executive'
  );
  return items;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {object} user
 */
function listExecutiveOfficeTrayItems(db, branchScope, user) {
  if (!officeTablesReady(db) || !userHasPermission(user, 'office.use')) return [];
  const scope = {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? 'BR-KD' : branchScope,
  };
  return listOfficeThreads(db, scope, user, {})
    .filter((t) => {
      const st = String(t.status || '').toLowerCase();
      if (st === 'converted' || st === 'closed') return false;
      if (st !== 'open') return false;
      const ok =
        String(t.officeKey || '').toLowerCase() === 'executive' ||
        String(t.kind || '').toLowerCase().includes('memo') ||
        String(t.documentClass || '').toLowerCase().includes('memo');
      return ok;
    })
    .slice(0, 8);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {object} user
 */
function listExecutiveUnifiedTrayItems(db, branchScope, user) {
  if (!workRegistryTablesReady(db)) return [];
  const scope = {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? 'BR-KD' : branchScope,
  };
  return listUnifiedWorkItems(db, scope, user, { limit: 60 }).filter((it) => {
    const st = String(it.status || '').toLowerCase();
    if (['completed', 'done', 'cancelled', 'approved', 'rejected'].includes(st)) return false;
    const docKind = String(it.documentType || it.type || it.sourceKind || '').toLowerCase();
    // Payable withdrawals awaiting MD/finance approval (not payout stage).
    if (docKind === 'register_settlement' && /^(pending|pending_review|submitted|open)$/i.test(st)) return true;
    const ro = String(it.responsibleOfficeKey || it.officeKey || '').toLowerCase();
    if (ro === 'executive' || ro === 'finance') return true;
    const amt = Number(it.amountNgn) || Number(it.data?.amountNgn) || 0;
    if (amt >= 200_000 && /pending|submitted|awaiting|open/.test(st)) return true;
    return false;
  }).slice(0, 10);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {object} user
 * @param {boolean} readOnly
 * @param {object[]} baseItems
 */
function appendExecutiveWorkTraySources(db, branchScope, user, readOnly, baseItems) {
  const seen = new Set(baseItems.map((i) => i.id));
  const add = (row) => {
    if (!row?.id || seen.has(row.id)) return;
    seen.add(row.id);
    baseItems.push(row);
  };

  for (const t of listExecutiveOfficeTrayItems(db, branchScope, user)) {
    add({
      id: `office:${t.id}`,
      kind: 'office_memo',
      priority: 'medium',
      title: t.subject || `Office memo ${t.id}`,
      branchId: t.branchId || '',
      branchName: branchName(db, t.branchId),
      amountNgn: null,
      requestedBy: 'Office',
      ageLabel: daysSinceLabel(t.updatedAtIso),
      status: String(t.status || 'open'),
      route: '/office',
      reviewContext: { threadId: t.id, subject: t.subject || '' },
      summaryOnly: false,
      canAct: !readOnly && userHasPermission(user, 'office.use'),
    });
  }

  for (const it of listExecutiveUnifiedTrayItems(db, branchScope, user)) {
    const docKind = String(it.documentType || it.type || 'work_item').toLowerCase();
    const kind = docKind === 'memo' ? 'office_memo' : docKind === 'refund_request' ? 'refunds' : docKind;
    const settlementId =
      docKind === 'register_settlement' ? String(it.sourceId || '').trim() : '';
    add({
      id: `work:${it.id}`,
      kind: kind === 'memo' ? 'office_memo' : kind,
      priority: priorityBand(70),
      title: it.title || settlementId || it.id,
      branchId: it.branchId || '',
      branchName: branchName(db, it.branchId),
      amountNgn: it.amountNgn != null ? Math.round(Number(it.amountNgn) || 0) : null,
      requestedBy: it.senderOfficeLabel || it.officeLabel || '—',
      ageLabel: daysSinceLabel(it.updatedAtIso || it.createdAtIso),
      status: String(it.status || 'Pending'),
      route: it.routePath || it.route || '/office',
      settlementId: settlementId || undefined,
      reviewContext: {
        settlementId,
        row: settlementId ? { settlementId, ...(it.data || {}) } : it.data || {},
        reasons: settlementId ? ['Pending register withdrawal approval'] : [],
        subtitle: String(it.summary || '').trim(),
      },
      summaryOnly: false,
      canAct: !readOnly && canActOnWorkItemKind(user, kind),
    });
  }

  return baseItems;
}

function periodMetricsForSku(matPerf, fam, gauge, colour) {
  const combos = matPerf?.[fam]?.topCombinations || [];
  const match = combos.find(
    (c) => String(c.gauge || '').trim() === String(gauge || '').trim() && String(c.colour || '').trim() === String(colour || '').trim()
  );
  return {
    selectedPeriodMetres: match?.metres != null ? Math.round(Number(match.metres) || 0) : null,
    selectedPeriodRevenueNgn: match?.revenueNgn != null ? Math.round(Number(match.revenueNgn) || 0) : null,
    selectedPeriodQty: null,
  };
}

function normalizeSkuDisplayRow(row, matPerf, period) {
  const fam = row.family || 'aluminium';
  const periodM = periodMetricsForSku(matPerf, fam, row.gauge, row.colour);
  const label =
    row.label ||
    skuActionLabel(row.action) ||
    (row.weeksCover != null && row.weeksCover < 2 ? 'Critical' : 'Watch');
  return {
    ...row,
    ...periodM,
    lookbackDemandBasisLabel: SKU_LOOKBACK_DEMAND_LABEL,
    weeksCover: row.weeksCover ?? null,
    recommendation: label,
    estimated: true,
    periodLabel: period?.startISO && period?.endISO ? `${period.startISO} – ${period.endISO}` : null,
  };
}

function skuActionLabel(action) {
  if (action === 'buy') return 'Buy Soon';
  if (action === 'liquidate') return 'Liquidate';
  if (action === 'watch') return 'Watch';
  return 'OK';
}

function buildInventoryPanels(biPack, period = {}) {
  const inv = biPack.inventory || {};
  const sku = inv.skuIntelligence || {};
  const matPerf = biPack.sales?.materialPerformance || {};
  const families = inv.families || [];
  const lowStockHighDemand = [];
  const slowMovingStock = [];
  const recommendations = [];

  for (const fam of ['aluminium', 'aluzinc']) {
    const block = sku[fam];
    if (!block) continue;
    for (const row of block.buyNext || []) {
      lowStockHighDemand.push(
        normalizeSkuDisplayRow(
          {
            family: fam,
            gauge: row.gauge,
            colour: row.colour,
            weeksCover: row.weeksCover,
            kgOnHand: row.kgOnHand,
            kgDemandPeriod: row.kgDemandPeriod,
            label: skuActionLabel(row.action),
            action: row.action,
            reason: row.reason,
            route: '/exec?tab=intelligence',
          },
          matPerf,
          period
        )
      );
      recommendations.push({
        family: fam,
        type: 'buy',
        message: `${row.gauge} ${row.colour} ${fam} — ${row.reason}`,
        route: '/exec?tab=intelligence',
      });
    }
    for (const row of block.reduceStock || []) {
      slowMovingStock.push(
        normalizeSkuDisplayRow(
          {
            family: fam,
            gauge: row.gauge,
            colour: row.colour,
            weeksCover: row.weeksCover,
            valuationNgn: row.valuationNgn,
            label: 'Liquidate',
            action: 'liquidate',
            reason: row.reason,
            route: '/exec?tab=intelligence',
          },
          matPerf,
          period
        )
      );
    }
    for (const row of block.needsAttention || []) {
      if (row.action === 'watch') {
        recommendations.push({
          family: fam,
          type: 'watch',
          message: `${row.gauge} ${row.colour} — ${row.reason}`,
          route: '/exec?tab=intelligence',
        });
      }
    }
  }

  const stoneMix = (biPack.sales?.mixRows || []).find((r) => r.family === 'stone');
  const stonecoated = {
    available: Boolean(stoneMix),
    metres: stoneMix?.metres ?? 0,
    revenueNgn: stoneMix?.revenueNgn ?? 0,
    sharePctMetres: stoneMix?.sharePctMetres ?? 0,
    note: 'Stonecoated uses production flatsheet usage; full coil-style SKU cover is not applied.',
  };

  return {
    families,
    skuPeriodNote:
      'Selected-period metres/revenue come from production mix in your filter. Weeks-cover uses BI lookback demand.',
    lookbackDemandBasisLabel: SKU_LOOKBACK_DEMAND_LABEL,
    skuIntelligence: {
      aluminium: {
        ...(sku.aluminium || { buyNext: [], reduceStock: [], needsAttention: [] }),
        topCombinations: matPerf.aluminium?.topCombinations || [],
      },
      aluzinc: {
        ...(sku.aluzinc || { buyNext: [], reduceStock: [], needsAttention: [] }),
        topCombinations: matPerf.aluzinc?.topCombinations || [],
      },
      stonecoated,
    },
    lowStockHighDemand,
    slowMovingStock,
    recommendations,
    valuationNote: 'Coil inventory valuation is estimated from landed cost and kg on hand.',
  };
}

function familyDisplayName(fam) {
  if (fam === 'aluzinc') return 'Aluzinc';
  if (fam === 'aluminium') return 'Aluminium';
  return String(fam || 'Material');
}

/**
 * Management-style decision alerts from existing BI and operational slices.
 * @param {import('better-sqlite3').Database} db
 * @param {object} biPack
 * @param {object} execSummary
 * @param {object} inventoryPanels
 * @param {object[]} enrichedBranches
 * @param {object} sales
 */
export function buildExecutiveDecisionAlerts(
  db,
  biPack,
  execSummary,
  inventoryPanels = {},
  enrichedBranches = [],
  sales = {}
) {
  const panels = inventoryPanels || {};
  const pack = biPack || {};
  /** @type {object[]} */
  const alerts = [];
  const seen = new Set();

  const push = (row) => {
    if (!row?.id || seen.has(row.id)) return;
    seen.add(row.id);
    alerts.push(row);
  };

  for (const row of (panels.lowStockHighDemand || []).slice(0, 4)) {
    const famLabel = familyDisplayName(row.family);
    const cover = row.weeksCover != null ? `${row.weeksCover} weeks` : 'low';
    push({
      id: `sku-buy-${row.family}-${row.gauge}-${row.colour}`,
      level: row.weeksCover != null && row.weeksCover < 2 ? 'critical' : 'warning',
      title: 'Stock cover risk',
      message: `${row.gauge} ${row.colour} ${famLabel} has strong demand but only ${cover} of cover remaining.`,
      source: 'sku_intelligence',
      sourceSection: 'Product & Stock',
      route: '/exec?tab=intelligence',
      metric: row.weeksCover != null ? `${row.weeksCover} wk` : '',
    });
  }

  for (const row of (panels.slowMovingStock || []).slice(0, 3)) {
    const val = row.valuationNgn != null ? formatNgnCompact(row.valuationNgn) : 'significant';
    push({
      id: `sku-slow-${row.family}-${row.gauge}-${row.colour}`,
      level: 'opportunity',
      title: 'Slow-moving coil stock',
      message: `${row.gauge} ${row.colour} ${familyDisplayName(row.family)} has ${row.weeksCover ?? 'high'} weeks cover (${val} estimated) — cash may be tied in slow movers.`,
      source: 'sku_intelligence',
      sourceSection: 'Product & Stock',
      route: '/exec?tab=intelligence',
    });
  }

  for (const b of enrichedBranches) {
    const name = b.branchName || b.branchId;
    const produced = Number(b.producedRevenueNgn) || 0;
    const collected = Number(b.netCollectedNgn) || 0;
    const rate =
      b.producedCollectionRatePct != null
        ? b.producedCollectionRatePct
        : produced > 0
          ? Math.round((collected / produced) * 1000) / 10
          : null;
    if (produced > 500_000 && rate != null && rate < 55) {
      push({
        id: `branch-coll-${b.branchId}`,
        level: rate < 40 ? 'critical' : 'warning',
        title: 'Collections lag sales',
        message: `${name} has strong produced sales (${formatNgnCompact(produced)}) but a ${rate}% produced collection rate — receivable pressure may be building.`,
        source: 'branch_scorecard',
        sourceSection: 'Branch Performance',
        route: '/exec?tab=intelligence',
      });
    }
    if ((b.coilValuationNgn || 0) > 2_000_000 && (b.liquidateSkuCount || 0) >= 2) {
      push({
        id: `branch-stock-${b.branchId}`,
        level: 'warning',
        title: 'Stock cash tie-up',
        message: `${name} holds high-value slow-moving stock (${formatNgnCompact(b.coilValuationNgn)} estimated, ${b.liquidateSkuCount} liquidate signals) that may be tying down cash.`,
        source: 'branch_scorecard',
        sourceSection: 'Branch Performance',
        route: '/exec?tab=intelligence',
      });
    }
  }

  const expenseAnalysis = pack.expenseAnalysis || {};
  if (expenseAnalysis.periodChangePct != null && expenseAnalysis.periodChangePct > 20) {
    const topCat = expenseAnalysis.topCategories?.[0];
    const catName = topCat?.category || 'Operating expenses';
    const pct = expenseAnalysis.periodChangePct;
    push({
      id: 'expense-period-spike',
      level: pct > 35 ? 'critical' : 'warning',
      title: 'Expense movement',
      message:
        topCat && /transport|carriage|freight/i.test(catName)
          ? `${catName} increased sharply (${pct > 0 ? '+' : ''}${pct}%) compared with the prior period.`
          : `Operating expenses rose ${pct}% versus the prior period${topCat ? ` — ${catName} is the largest category` : ''}.`,
      source: 'expenses',
      sourceSection: 'Finance & Expenses',
      route: '/exec?tab=intelligence',
      metric: `${pct > 0 ? '+' : ''}${pct}%`,
    });
  }

  const aging = sales.receivablesAging || {};
  const over60 = (Number(aging['61_90']) || 0) + (Number(aging.over_90) || 0);
  const totalRecv = Number(sales.outstandingReceivablesNgn) || 0;
  if (totalRecv > 0 && over60 > totalRecv * 0.35) {
    push({
      id: 'receivables-aging-60',
      level: over60 > totalRecv * 0.5 ? 'critical' : 'warning',
      title: 'Aged receivables',
      message: `Customer debt above 60 days is ${formatNgnCompact(over60)} (${Math.round((over60 / totalRecv) * 100)}% of outstanding) — prioritise collection follow-up.`,
      source: 'receivables',
      sourceSection: 'Collections',
      route: '/reports',
      metric: formatNgnCompact(over60),
    });
  }

  if ((execSummary.payrollDraftsAwaitingMd || 0) > 0) {
    const n = execSummary.payrollDraftsAwaitingMd;
    push({
      id: 'payroll-md',
      level: 'warning',
      title: 'Payroll sign-off',
      message: `${n} payroll draft${n === 1 ? '' : 's'} await MD sign-off before lock.`,
      source: 'hr',
      sourceSection: 'Executive Work Tray',
      route: '/hr/executive',
    });
  }

  if ((execSummary.pendingRefunds || 0) > 0) {
    const n = execSummary.pendingRefunds;
    push({
      id: 'refunds-pending',
      level: n > 5 ? 'warning' : 'info',
      title: 'Refund queue',
      message: `${n} customer refund${n === 1 ? '' : 's'} pending executive review.`,
      source: 'finance',
      sourceSection: 'Executive Work Tray',
      route: '/manager',
    });
  }

  const cash90 = (pack.predictive?.horizons || []).find((h) => h.days === 90);
  if (cash90?.stress === 'deficit') {
    push({
      id: 'cash-90-deficit',
      level: 'critical',
      title: 'Cash pressure (90d)',
      message: `Projected cash balance in 90 days is ${formatNgnCompact(cash90.projectedBalanceNgn)} (estimated) — review payables and collections.`,
      source: 'cash_pressure',
      sourceSection: 'Cash & Working Capital',
      route: '/exec?tab=intelligence',
      estimated: true,
    });
  }

  return alerts.slice(0, 28);
}

function formatNgnCompact(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1_000_000) return `₦${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `₦${Math.round(v / 1_000)}k`;
  return `₦${v.toLocaleString('en-NG')}`;
}

function mapExpenseProductiveOverhead(topCategories) {
  let productiveNgn = 0;
  let overheadNgn = 0;
  for (const row of topCategories || []) {
    const cat = String(row.category || '');
    const amt = Number(row.amountNgn) || 0;
    if (PRODUCTIVE_EXPENSE_CATEGORIES.has(cat)) productiveNgn += amt;
    else overheadNgn += amt;
  }
  return {
    productiveNgn: Math.round(productiveNgn),
    overheadNgn: Math.round(overheadNgn),
    mappingNote: 'Productive vs overhead uses canonical expense category groupings (estimated).',
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
function countPendingProductionByBranch(db, branchScope) {
  const bJob = branchWhere(db, 'production_jobs', branchScope);
  try {
    const rows = db
      .prepare(
        `SELECT branch_id, COUNT(*) AS c FROM production_jobs
         WHERE status IN ('Planned', 'Running')
         ${bJob.sql}
         GROUP BY branch_id`
      )
      .all(...bJob.args);
    return new Map(rows.map((r) => [String(r.branch_id || '').trim(), Number(r.c) || 0]));
  } catch {
    return new Map();
  }
}

/**
 * @param {object[]} workTrayItems
 */
function countExecutiveItemsByBranch(workTrayItems) {
  const m = new Map();
  for (const it of workTrayItems) {
    if (it.summaryOnly) continue;
    const bid = String(it.branchId || '').trim();
    if (!bid) continue;
    m.set(bid, (m.get(bid) || 0) + 1);
  }
  return m;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} byBranchRows
 * @param {Map<string, number>} branchDebtMap
 * @param {object[]} expenseByBranch
 * @param {Map<string, number>} pendingJobsByBranch
 * @param {Map<string, number>} execItemsByBranchName
 */
export function buildEnrichedBranchScorecard(
  db,
  byBranchRows,
  branchDebtMap,
  expenseByBranch = [],
  pendingJobsByBranch = new Map(),
  execItemsByBranchName = new Map()
) {
  const expenseMap = new Map(expenseByBranch.map((r) => [r.branchId, Number(r.amountNgn) || 0]));
  const maxProduced = Math.max(1, ...byBranchRows.map((b) => Number(b.producedRevenueNgn) || 0));

  return byBranchRows.map((b) => {
    const produced = Number(b.producedRevenueNgn) || 0;
    const collected = Number(b.netCollectedNgn) || 0;
    const expensesNgn = Math.round(expenseMap.get(b.branchId) || 0);
    const customerDebtNgn = Math.round(branchDebtMap.get(b.branchId) || 0);
    const producedCollectionRatePct =
      produced > 0 ? Math.round((collected / produced) * 1000) / 10 : null;
    const expenseToSalesPct =
      produced > 0 ? Math.round((expensesNgn / produced) * 1000) / 10 : null;
    const pendingProductionJobs = pendingJobsByBranch.get(b.branchId) || 0;
    const bn = branchName(db, b.branchId);
    const pendingExecutiveItems = execItemsByBranchName.get(b.branchId) || 0;
    const riskFlags =
      (b.liquidateSkuCount || 0) +
      (producedCollectionRatePct != null && producedCollectionRatePct < 50 ? 1 : 0) +
      (expenseToSalesPct != null && expenseToSalesPct > 45 ? 1 : 0);

    const salesScore = (produced / maxProduced) * 40;
    const collScore =
      producedCollectionRatePct != null ? (producedCollectionRatePct / 100) * 30 : 0;
    const expensePenalty =
      expenseToSalesPct != null ? Math.min(20, (expenseToSalesPct / 100) * 20) : 0;
    const debtPenalty = customerDebtNgn > 0 ? Math.min(10, (customerDebtNgn / 5_000_000) * 10) : 0;
    const internalScore = Math.round(
      Math.max(0, Math.min(100, salesScore + collScore - expensePenalty - debtPenalty))
    );

    return {
      ...b,
      branchName: bn,
      customerDebtNgn,
      expensesNgn,
      expenseToSalesPct,
      producedCollectionRatePct,
      collectionRatePct: producedCollectionRatePct,
      collectionRateLabel: 'Produced collection rate',
      collectionRateBasis: 'produced_vs_collected',
      pendingProductionJobs,
      pendingExecutiveItems,
      riskFlagCount: riskFlags,
      internalScore,
      internalScoreNote:
        'Transparent index: 40% produced sales rank, 30% produced collection rate, minus expense-to-sales and receivables weight (not statutory accounts).',
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} enriched
 */
export function buildBranchScorecardHighlights(db, enriched) {
  if (!enriched?.length) {
    return {
      bestCollectionsBranch: null,
      highestReceivablesRisk: null,
      highestExpensePressure: null,
      highestStockRisk: null,
      bestOverallBranch: null,
      bestPerformingBranch: null,
      highestDebtorBranch: null,
      lowestCollectionRateBranch: null,
      highestStockRiskBranch: null,
    };
  }
  const byColl = [...enriched]
    .filter((b) => b.producedCollectionRatePct != null)
    .sort((a, b) => b.producedCollectionRatePct - a.producedCollectionRatePct);
  const byDebt = [...enriched].sort((a, b) => b.customerDebtNgn - a.customerDebtNgn);
  const byExpense = [...enriched]
    .filter((b) => b.expenseToSalesPct != null)
    .sort((a, b) => b.expenseToSalesPct - a.expenseToSalesPct);
  const byStock = [...enriched].sort(
    (a, b) =>
      (b.coilValuationNgn || 0) +
      (b.liquidateSkuCount || 0) * 100_000 -
      ((a.coilValuationNgn || 0) + (a.liquidateSkuCount || 0) * 100_000)
  );
  const byOverall = [...enriched].sort((a, b) => b.internalScore - a.internalScore);
  const bySales = [...enriched].sort((a, b) => b.producedRevenueNgn - a.producedRevenueNgn);
  const lowestCol = [...enriched]
    .filter((b) => b.producedCollectionRatePct != null)
    .sort((a, b) => a.producedCollectionRatePct - b.producedCollectionRatePct);

  const pick = (row) => (row ? row.branchName || branchName(db, row.branchId) : null);

  return {
    bestCollectionsBranch: pick(byColl[0]),
    highestReceivablesRisk: pick(byDebt[0]),
    highestExpensePressure: pick(byExpense[0]),
    highestStockRisk: pick(byStock[0]),
    bestOverallBranch: pick(byOverall[0]),
    bestPerformingBranch: pick(bySales[0]),
    highestDebtorBranch: pick(byDebt[0]),
    lowestCollectionRateBranch: pick(lowestCol[0]),
    highestStockRiskBranch: pick(byStock[0]),
    internalScoreLabel: 'Internal branch index (estimated components)',
  };
}

function buildReportsLinks(actor) {
  const reports = [
    {
      title: 'MD Operations Pack',
      description: 'Monthly exception counts — large payments, unfiled work, inter-branch.',
      route: '/reports',
    },
    {
      title: 'Executive summary',
      description: 'Daily / weekly executive packs with attention snapshot.',
      route: '/reports',
    },
    {
      title: 'Branch performance',
      description: 'Business intelligence branch breakdown and collections.',
      route: '/exec?tab=intelligence',
    },
    {
      title: 'Stock intelligence',
      description: 'Coil SKU cover, buy/liquidate signals (estimated).',
      route: '/exec?tab=intelligence',
    },
    {
      title: 'Expense analysis',
      description: 'Category and branch expense vs produced sales.',
      route: '/exec?tab=intelligence',
    },
    {
      title: 'Working capital snapshot',
      description: 'Cash, receivables, inventory, and pending outflows.',
      route: '/exec?tab=finance',
    },
    {
      title: 'Customer debt',
      description: 'Receivables aging and top debtor customers.',
      route: '/reports',
    },
  ];
  if (actor.canViewAudit) {
    reports.push({
      title: 'Audit & risk',
      description: 'Audit log export and compliance trail.',
      route: '/settings',
    });
  }
  return reports;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {{ branchScope: string; periodKey?: string; startISO?: string; endISO?: string }} opts
 */
export function buildExecutiveDashboard(db, user, opts = {}) {
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';
  const period = resolveExecDashboardPeriod({
    periodKey: opts.periodKey,
    startISO: opts.startISO,
    endISO: opts.endISO,
  });

  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  const canAct = actorCanActOnApprovals(user);
  const readOnlyExecutiveView = roleKey === 'ceo' && !canAct;
  const canViewAudit = userHasPermission(user, 'audit.view') || userHasPermission(user, '*');

  const sourceSlices = loadBusinessIntelligenceSourceSlices(db, branchScope);
  let biPack;
  try {
    biPack = loadBusinessIntelligencePack(db, branchScope, {
      periodKey: period.biPeriodKey === 'custom' ? 'month' : period.biPeriodKey,
      asOfISO: period.asOfISO || period.endISO,
      periodStartISO: period.startISO,
      periodEndISO: period.endISO,
      sourceSlices,
    });
  } catch (e) {
    biPack = { ok: false, error: String(e?.message || e) };
  }

  const execSummary = execOrgSummary(db);
  const scopedCounts = buildScopedExecutiveCounts(db, branchScope);
  const monthKey = period.endISO.slice(0, 7);
  const mdPack = buildMdOperationsPack(db, {
    monthKey,
    branchId: branchScope === 'ALL' ? undefined : branchScope,
    viewAll: branchScope === 'ALL',
  });

  const sales = biPack.ok ? biPack.sales || {} : {};
  const expenseAnalysis = biPack.ok ? biPack.expenseAnalysis || {} : {};
  const predictive = biPack.ok ? biPack.predictive || {} : {};
  const branchBreakdown = biPack.ok ? biPack.branchBreakdown || {} : {};

  const treasuryAccounts = listTreasuryAccounts(db, branchScope);
  const treasuryCashNgn = treasuryAccounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const inventoryValueNgn =
    (branchBreakdown.byBranch || []).reduce((s, b) => s + (Number(b.coilValuationNgn) || 0), 0) ||
    (biPack.inventory?.families || []).reduce((s, f) => s + (Number(f.valuationNgn) || 0), 0);

  const inventoryPanels = biPack.ok
    ? buildInventoryPanels(biPack, period)
    : buildInventoryPanels({ inventory: {}, sales: {} }, period);

  const extras = listExecutiveExtras(db, branchScope);
  const useQueueSummary = !canAccessAttentionInbox(user);
  let workTrayItems = [];
  if (canAccessAttentionInbox(user)) {
    try {
      const attention = listMdAttentionInbox(db, branchScope);
      workTrayItems = mapAttentionToWorkTray(db, attention, user, readOnlyExecutiveView);
    } catch {
      workTrayItems = buildQueueSummaryTray(scopedCounts);
    }
  } else {
    workTrayItems = buildQueueSummaryTray(scopedCounts);
  }
  if (!useQueueSummary) {
    workTrayItems = appendExecutiveWorkTraySources(db, branchScope, user, readOnlyExecutiveView, workTrayItems);
  }
  const summaryKinds = new Set(
    workTrayItems.filter((w) => w.summaryOnly).map((w) => String(w.kind || '').toLowerCase())
  );
  for (const ex of extras) {
    if (useQueueSummary && summaryKinds.has(String(ex.kind || '').toLowerCase())) continue;
    if (!workTrayItems.some((w) => w.id === ex.id)) {
      workTrayItems.push({
        ...ex,
        summaryOnly: false,
        canAct: !readOnlyExecutiveView && canActOnWorkItemKind(user, ex.kind),
      });
    }
  }

  const governanceLimits = getOrgGovernanceLimits(db  );
  workTrayItems = sortExecWorkTrayByApprovalTier(
    annotateExecWorkTrayApprovalTiers(workTrayItems, governanceLimits)
  );

  const debtPreloaded = {
    quotations: sourceSlices.quotations,
    ledgerEntries: sourceSlices.ledgerEntries,
    productionJobs: sourceSlices.productionJobs,
  };
  const topCustomersByDebtRows = topCustomersByDebt(db, branchScope, period.endISO, debtPreloaded);
  const topCustomersByPayments = sales.topCustomers || [];

  const branchDebtMap = buildBranchDebtTotalsMap(
    debtPreloaded.quotations,
    debtPreloaded.ledgerEntries,
    debtPreloaded.productionJobs
  );

  const pendingJobsByBranch = countPendingProductionByBranch(db, branchScope);
  const execItemsByBranch = countExecutiveItemsByBranch(workTrayItems);
  const byBranchRows = branchBreakdown.byBranch || [];
  const enrichedBranches = buildEnrichedBranchScorecard(
    db,
    byBranchRows,
    branchDebtMap,
    expenseAnalysis.byBranch || [],
    pendingJobsByBranch,
    execItemsByBranch
  );
  const comparisonAvailable = enrichedBranches.length > 1;
  const highlights = comparisonAvailable
    ? buildBranchScorecardHighlights(db, enrichedBranches)
    : {
        bestCollectionsBranch: null,
        highestReceivablesRisk: null,
        highestExpensePressure: null,
        highestStockRisk: null,
        bestOverallBranch: null,
        bestPerformingBranch: null,
        highestDebtorBranch: null,
        lowestCollectionRateBranch: null,
        highestStockRiskBranch: null,
      };

  const decisionAlerts = biPack.ok
    ? buildExecutiveDecisionAlerts(
        db,
        biPack,
        execSummary,
        inventoryPanels,
        enrichedBranches,
        sales
      )
    : [];
  const criticalAlerts = decisionAlerts.filter((a) => a.level === 'critical').length;

  const expenseSplit = mapExpenseProductiveOverhead(expenseAnalysis.topCategories);
  const dataScopeNotes = buildExecDataScopeNotes(period, {
    skuUsesBiLookback: true,
    cashUsesBiLookback: true,
  });

  const actor = {
    role: roleKey,
    canActOnApprovals: canAct,
    readOnlyExecutiveView,
    canViewAudit,
    canUseAllBranches: canUseAllBranchesRollup(user),
    canManageReservePolicy: actorCanManageReservePolicy(user),
  };

  const purchaseOrders = sourceSlices.purchaseOrders || [];

  const workingCapital = buildWorkingCapitalSnapshot(db, branchScope, {
    cashNgn: treasuryCashNgn,
    receivablesNgn: sales.outstandingReceivablesNgn,
    inventoryValueNgn: inventoryValueNgn,
    purchaseOrders,
    pendingOutflowsNgn: predictive.pendingOutflowsNgn,
  });

  const payables = buildPayablesOutflowsSummary(db, branchScope, {
    purchaseOrders,
    pendingOutflowsNgn: predictive.pendingOutflowsNgn,
  });

  const materialCosting = buildMaterialCostingPanel(db, branchScope, {
    startISO: period.startISO,
    endISO: period.endISO,
  });

  const targets = buildExecTargetsPanel(db, branchScope, {
    startISO: period.startISO,
    endISO: period.endISO,
    monthKey,
  }, sales);

  const staffActivity = buildStaffActivitySummary(db, branchScope, {
    startISO: period.startISO,
    endISO: period.endISO,
  });

  const reservePolicy = buildReservePolicyReadiness(db);

  const workTrayTierSummary = summarizeExecWorkTrayApprovalTiers(workTrayItems);
  const priceExceptionCount = workTrayItems.filter(
    (it) => String(it.kind || '').toLowerCase() === 'price_exception'
  ).length;
  const targetNairaRow = (targets?.rows || []).find((r) => r.metricKey === 'naira_sales');
  const targetMetreRow = (targets?.rows || []).find((r) => r.metricKey === 'production_metres');
  const cockpitPulses = buildMdCockpitPulses(db, {
    branchScope,
    treasuryCashNgn,
    outstandingReceivablesNgn: sales.outstandingReceivablesNgn,
    inventoryValueNgn,
    producedRevenueNgn: sales.producedRevenueNgn || sales.quotedNgn,
    targetRevenueNgn: targetNairaRow?.target ?? null,
    completedMetres: targetMetreRow?.actual ?? 0,
    targetMetres: targetMetreRow?.target ?? null,
    priceExceptionCount,
    payrollDraftsAwaitingMd: scopedCounts.payrollDraftsAwaitingMd?.count ?? 0,
    workTrayItems,
    biPack,
  });
  const championCustomer = buildChampionCustomerSnippet(topCustomersByPayments);

  return {
    ok: true,
    generatedAtISO: new Date().toISOString(),
    engineRev: BI_ENGINE_REV,
    actor,
    branchScope,
    period: {
      key: period.key,
      startISO: period.startISO,
      endISO: period.endISO,
      biPeriodKey: period.biPeriodKey || 'month',
      kpiPeriodAware: Boolean(period.kpiPeriodAware),
    },
    dataScopeNotes,
    kpis: {
      salesNgn: Math.round(sales.producedRevenueNgn || sales.quotedNgn || 0),
      collectionsNgn: Math.round(sales.collectedNgn || 0),
      collectionRatePct: sales.collectionRatePct ?? null,
      collectionRateLabel: 'Quoted collection rate',
      collectionRateBasis: 'quoted_vs_collected',
      outstandingReceivablesNgn: Math.round(sales.outstandingReceivablesNgn || 0),
      treasuryCashNgn: Math.round(treasuryCashNgn),
      inventoryValueNgn: Math.round(inventoryValueNgn),
      expensesNgn: Math.round(expenseAnalysis.periodTotalNgn || 0),
      expenseToSalesPct:
        expenseAnalysis.expenseToSalesPct ?? expenseAnalysis.expenseToProducedSalesPct ?? null,
      pendingExecutiveActions: workTrayItems.length,
      criticalAlerts,
      salesLabel: 'Produced revenue (estimated attribution)',
      inventoryLabel: 'Estimated',
    },
    decisionAlerts,
    workTray: {
      items: workTrayItems.slice(0, 80),
      summary: {
        total: workTrayItems.length,
        mdOnly: workTrayTierSummary.mdOnly,
        shared: workTrayTierSummary.shared,
        byKind: workTrayItems.reduce((acc, it) => {
          acc[it.kind] = (acc[it.kind] || 0) + 1;
          return acc;
        }, {}),
      },
      readOnlyForActor: readOnlyExecutiveView,
    },
    cockpit: {
      pulses: cockpitPulses,
      championCustomer: championCustomer.champion,
    },
    executiveCounts: scopedCounts,
    sales: {
      receivablesAging: sales.receivablesAging || {},
      topCustomersByPayments,
      topCustomersByDebt: topCustomersByDebtRows,
      debtBasisLabel: `Current outstanding as at ${period.endISO}`,
      debtSortBasis: 'Aging severity, then amount',
    },
    inventory: {
      ...inventoryPanels,
      drillRoutes: {
        analytics: '/exec?tab=intelligence',
        reports: '/reports',
        operations: '/operations',
      },
    },
    expenses: {
      topCategories: expenseAnalysis.topCategories || [],
      byBranch: expenseAnalysis.byBranch || [],
      trend: expenseAnalysis.monthlyTrend || [],
      alerts: expenseAnalysis.alerts || [],
      expenseToSalesPct:
        expenseAnalysis.expenseToSalesPct ?? expenseAnalysis.expenseToProducedSalesPct ?? null,
      periodChangePct: expenseAnalysis.periodChangePct ?? null,
      productiveOverhead: expenseSplit,
    },
    branches: {
      byBranch: enrichedBranches,
      highlights,
      comparisonAvailable,
      scorecardNote: highlights.internalScoreLabel || null,
      comparisonEmptyReason:
        !comparisonAvailable && branchScope !== 'ALL'
          ? 'single_branch'
          : !comparisonAvailable
            ? 'no_branch_rows'
            : null,
    },
    workingCapital,
    payables,
    materialCosting,
    targets,
    staffActivity,
    reservePolicy,
    cash: {
      cashNgn: Math.round(treasuryCashNgn),
      pendingOutflowsNgn: Math.round(predictive.pendingOutflowsNgn || 0),
      receivablesNgn: Math.round(sales.outstandingReceivablesNgn || 0),
      inventoryValueNgn: Math.round(inventoryValueNgn),
      pendingRefunds: scopedCounts.pendingRefunds?.count ?? 0,
      pendingRefundsScope: scopedCounts.pendingRefunds?.scopeBasis ?? 'company',
      pendingRefundsIsCount: true,
      pendingPaymentRequests: scopedCounts.pendingPaymentRequests?.count ?? 0,
      pendingPaymentRequestsScope: scopedCounts.pendingPaymentRequests?.scopeBasis ?? 'company',
      payrollDraftsAwaitingMd: scopedCounts.payrollDraftsAwaitingMd?.count ?? 0,
      payrollDraftsAwaitingMdScope: scopedCounts.payrollDraftsAwaitingMd?.scopeBasis ?? 'company',
      payrollDraftsAwaitingMdIsCount: true,
      horizons: predictive.horizons || [],
      alerts: (predictive.alerts || []).filter((a) => a.category === 'cash'),
      pressureModelLabel: 'Estimated cash pressure based on recent treasury activity',
      notSafeWithdrawalNote: 'Not a safe-withdrawal calculation',
      horizonBasis: 'Recent treasury inflow/outflow average (estimated)',
      safeWithdrawalNote:
        'Safe withdrawal estimate will appear after reserve policies are configured.',
      estimated: true,
    },
    risks: {
      alerts: [
        ...(predictive.alerts || []),
        ...(expenseAnalysis.alerts || []).map((a) => ({ ...a, category: 'expenses' })),
      ].slice(0, 20),
      summaryOnly: !canViewAudit,
    },
    reports: buildReportsLinks({ ...actor, canViewAudit }),
    links: {
      drillRoutes: {
        manager: '/manager',
        analytics: '/exec?tab=intelligence',
        reports: '/reports',
        accounts: '/accounts',
        sales: '/sales',
        operations: '/operations',
        hrExecutive: '/hr/executive',
      },
    },
    degraded: !biPack.ok,
    degradedReason: biPack.ok ? null : biPack.error || 'Business intelligence pack unavailable',
    mdOperationsMonth: mdPack.ok ? mdPack : null,
  };
}

/**
 * Resolve branch scope for exec dashboard query override.
 * @param {object} user
 * @param {{ workspaceBranchId?: string; workspaceViewAll?: boolean }} reqLike
 * @param {string} [queryBranchId]
 */
export function resolveExecDashboardBranchScope(user, reqLike, queryBranchId) {
  const q = String(queryBranchId || '').trim();
  if (q && q.toUpperCase() === 'ALL' && canUseAllBranchesRollup(user)) {
    return 'ALL';
  }
  if (q && q.startsWith('BR-')) {
    if (canUseAllBranchesRollup(user) || String(reqLike?.workspaceBranchId || '') === q) {
      return q;
    }
  }
  if (reqLike?.workspaceViewAll && canUseAllBranchesRollup(user)) {
    return 'ALL';
  }
  return String(reqLike?.workspaceBranchId || '').trim() || 'BR-KD';
}
