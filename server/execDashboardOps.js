/**
 * Executive Command Centre — composes existing BI, exec summary, and management inbox.
 */
import { BI_ENGINE_REV } from '../shared/lib/businessIntelligence.js';
import { receivableDueOnQuotationFromEntries } from '../shared/lib/customerLedgerCore.js';
import { topCustomersByNetPayments } from '../shared/lib/businessIntelligence.js';
import { getBranch } from './branches.js';
import { canUseAllBranchesRollup, userHasPermission } from './auth.js';
import { loadBusinessIntelligencePack } from './businessIntelligenceOps.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';
import { buildMdOperationsPack } from './mdOperationsPack.js';
import {
  execOrgSummary,
  listLedgerEntries,
  listProductionJobs,
  listQuotations,
  listTreasuryAccounts,
} from './readModel.js';

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
  let biPeriodKey = 'month';

  if (key === 'custom' && startISO && endISO) {
    return { key: 'custom', startISO, endISO, biPeriodKey: 'month' };
  }
  if (key === 'today') {
    return { key: 'today', startISO: today, endISO: today, biPeriodKey: 'month' };
  }
  if (key === 'week') {
    return { key: 'week', startISO: addDaysISO(today, -6), endISO: today, biPeriodKey: 'month' };
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
    return { key: 'last_month', startISO, endISO, biPeriodKey: 'month', asOfISO: endISO };
  }
  startISO = `${today.slice(0, 7)}-01`;
  return { key: 'month', startISO, endISO: today, biPeriodKey: 'month', asOfISO: today };
}

const BI_MONTH_SCOPE_NOTE =
  'Period filter applies to available KPI windows. Some BI insights remain based on the latest monthly/business-intelligence window.';

/**
 * Notes when requested period differs from BI pack period (today/week/custom use month BI).
 * @param {{ key?: string; biPeriodKey?: string }} period
 */
export function buildExecDataScopeNotes(period) {
  const key = String(period?.key || 'month').trim().toLowerCase();
  const biKey = String(period?.biPeriodKey || 'month').trim().toLowerCase();
  /** @type {{ id: string; level: string; message: string }[]} */
  const notes = [];
  if (key === 'today' || key === 'week' || key === 'custom' || (key !== biKey && biKey === 'month')) {
    notes.push({ id: 'bi-month-lookback', level: 'info', message: BI_MONTH_SCOPE_NOTE });
  }
  return notes;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {string} startISO
 * @param {string} endISO
 */
export function topCustomersByDebt(db, branchScope, startISO, endISO) {
  const quotations = listQuotations(db, branchScope);
  const ledger = listLedgerEntries(db, branchScope);
  const jobs = listProductionJobs(db, branchScope);
  /** @type {Map<string, { customerID: string; customerName: string; debtNgn: number; quotationCount: number }>} */
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
    };
    curr.debtNgn += Math.round(due);
    curr.quotationCount += 1;
    byCustomer.set(cid, curr);
  }

  return [...byCustomer.values()]
    .sort((a, b) => b.debtNgn - a.debtNgn)
    .slice(0, 15)
    .map((r) => ({
      customerID: r.customerID,
      customerName: r.customerName,
      debtNgn: r.debtNgn,
      quotationCount: r.quotationCount,
    }));
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
  if (k === 'payments') return userHasPermission(user, 'finance.approve');
  if (k === 'material') return userHasPermission(user, 'material_incidents.approve');
  if (k === 'edit_approvals') return userHasPermission(user, 'audit.view') || userHasPermission(user, 'quotations.manage');
  if (k === 'payroll') return userHasPermission(user, 'hr.payroll.md_approve');
  if (k === 'inter_branch_loan') return userHasPermission(user, 'inter_branch_loan.md_approve');
  if (k === 'stock_register') return userHasPermission(user, 'sales.manage') || userHasPermission(user, 'quotations.manage');
  return actorCanActOnApprovals(user);
}

function workItemRoute(kind, row = {}) {
  const k = String(kind || '').toLowerCase();
  if (k === 'refunds') return '/manager';
  if (k === 'payments') return '/manager';
  if (k === 'material') return '/operations/material-exceptions';
  if (k === 'edit_approvals') return '/manager';
  if (k === 'payroll') return '/hr/executive';
  if (k === 'inter_branch_loan') return '/accounts';
  if (k === 'stock_register') return '/operations';
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
      branchName: branchName(db, branchId),
      amountNgn: it.amountNgn != null ? Math.round(Number(it.amountNgn) || 0) : null,
      requestedBy: String(requestedBy).slice(0, 80),
      ageLabel: daysSinceLabel(it.atIso),
      status: 'Approval Pending',
      route: workItemRoute(kind, it),
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
        branchName: 'Company-wide',
        amountNgn: null,
        requestedBy: 'HR',
        ageLabel: daysSinceLabel(r.created_at_iso),
        status: 'MD sign-off required',
        route: '/hr/executive',
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
        branchName: `${branchName(db, r.lender_branch_id)} → ${branchName(db, r.borrower_branch_id)}`,
        amountNgn: Math.round(Number(r.principal_ngn) || 0),
        requestedBy: 'Treasury',
        ageLabel: daysSinceLabel(r.created_at_iso),
        status: String(r.status || 'Pending'),
        route: '/accounts',
      });
    }
  } catch {
    /* optional */
  }

  return extras;
}

/**
 * One summary row per queue kind (CEO / users without full management inbox).
 * @param {object} execSummary
 * @param {object} user
 * @param {boolean} readOnly
 */
export function buildQueueSummaryTray(execSummary, user, readOnly) {
  /** @type {object[]} */
  const items = [];
  const pushSummary = (count, kind, titlePrefix, route) => {
    const n = Number(count) || 0;
    if (n <= 0) return;
    items.push({
      id: `${kind}:summary`,
      kind,
      priority: n > 3 ? 'high' : 'medium',
      title: `${titlePrefix} — ${n} item${n === 1 ? '' : 's'}`,
      branchName: 'All branches',
      amountNgn: null,
      requestedBy: '—',
      ageLabel: '—',
      status: 'Summary',
      route,
      summaryOnly: true,
      canAct: false,
    });
  };
  pushSummary(execSummary.pendingRefunds, 'refunds', 'Refund approvals pending', '/manager');
  pushSummary(execSummary.pendingPaymentRequests, 'payments', 'Payment requests pending', '/manager');
  pushSummary(
    execSummary.payrollDraftsAwaitingMd,
    'payroll',
    'Payroll awaiting MD sign-off',
    '/hr/executive'
  );
  return items;
}

function severityToLevel(sev) {
  if (sev === 'high') return 'critical';
  if (sev === 'medium') return 'warning';
  if (sev === 'low') return 'info';
  return 'info';
}

function skuActionLabel(action) {
  if (action === 'buy') return 'Buy Soon';
  if (action === 'liquidate') return 'Liquidate';
  if (action === 'watch') return 'Watch';
  return 'OK';
}

function buildInventoryPanels(biPack) {
  const inv = biPack.inventory || {};
  const sku = inv.skuIntelligence || {};
  const families = inv.families || [];
  const lowStockHighDemand = [];
  const slowMovingStock = [];
  const recommendations = [];

  for (const fam of ['aluminium', 'aluzinc']) {
    const block = sku[fam];
    if (!block) continue;
    for (const row of block.buyNext || []) {
      lowStockHighDemand.push({
        family: fam,
        gauge: row.gauge,
        colour: row.colour,
        weeksCover: row.weeksCover,
        kgOnHand: row.kgOnHand,
        label: skuActionLabel(row.action),
        reason: row.reason,
        estimated: true,
      });
      recommendations.push({
        family: fam,
        type: 'buy',
        message: `${row.gauge} ${row.colour} ${fam} — ${row.reason}`,
      });
    }
    for (const row of block.reduceStock || []) {
      slowMovingStock.push({
        family: fam,
        gauge: row.gauge,
        colour: row.colour,
        weeksCover: row.weeksCover,
        valuationNgn: row.valuationNgn,
        label: 'Liquidate',
        reason: row.reason,
        estimated: true,
      });
    }
    for (const row of block.needsAttention || []) {
      if (row.action === 'watch') {
        recommendations.push({
          family: fam,
          type: 'watch',
          message: `${row.gauge} ${row.colour} — ${row.reason}`,
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

  const matPerf = biPack.sales?.materialPerformance || {};
  return {
    families,
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

function buildDecisionAlerts(biPack, execSummary, inventoryPanels) {
  /** @type {object[]} */
  const alerts = [];
  const seen = new Set();

  const push = (row) => {
    if (!row?.id || seen.has(row.id)) return;
    seen.add(row.id);
    alerts.push(row);
  };

  for (const a of biPack.predictive?.alerts || []) {
    push({
      id: `bi-${a.id}`,
      level: severityToLevel(a.severity),
      title: a.category ? String(a.category).replace(/_/g, ' ') : 'Insight',
      message: a.message,
      source: 'business_intelligence',
      route: '/analytics',
      metric: a.metric || '',
    });
  }

  for (const row of inventoryPanels.lowStockHighDemand.slice(0, 3)) {
    push({
      id: `sku-buy-${row.family}-${row.gauge}-${row.colour}`,
      level: row.weeksCover != null && row.weeksCover < 2 ? 'critical' : 'warning',
      title: 'Critical Stock Risk',
      message: `${row.gauge} ${row.colour} ${row.family === 'aluzinc' ? 'Aluzinc' : 'Aluminium'} is selling fast and may run out soon (${row.weeksCover ?? '—'} weeks cover).`,
      source: 'sku_intelligence',
      route: '/exec',
    });
  }

  for (const row of inventoryPanels.slowMovingStock.slice(0, 2)) {
    push({
      id: `sku-slow-${row.family}-${row.gauge}`,
      level: 'opportunity',
      title: 'Slow moving stock',
      message: `${row.gauge} ${row.colour} has ${row.weeksCover ?? 'high'} weeks cover — cash tied in slow movers.`,
      source: 'sku_intelligence',
      route: '/analytics',
    });
  }

  if ((execSummary.payrollDraftsAwaitingMd || 0) > 0) {
    push({
      id: 'payroll-md',
      level: 'warning',
      title: 'Approval Pending',
      message: `${execSummary.payrollDraftsAwaitingMd} payroll draft(s) await MD sign-off before lock.`,
      source: 'hr',
      route: '/hr/executive',
    });
  }

  if ((execSummary.pendingRefunds || 0) > 0) {
    push({
      id: 'refunds-pending',
      level: 'warning',
      title: 'Approval Pending',
      message: `${execSummary.pendingRefunds} customer refund(s) pending executive review.`,
      source: 'finance',
      route: '/manager',
    });
  }

  return alerts.slice(0, 24);
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

function buildBranchHighlights(db, byBranch, branchDebtMap) {
  if (!byBranch?.length) {
    return {
      bestPerformingBranch: '—',
      highestDebtorBranch: '—',
      lowestCollectionRateBranch: '—',
      highestStockRiskBranch: '—',
    };
  }
  const withRate = byBranch.map((b) => {
    const produced = Number(b.producedRevenueNgn) || 0;
    const collected = Number(b.netCollectedNgn) || 0;
    const rate = produced > 0 ? collected / produced : null;
    return { ...b, collectionRatePct: rate != null ? Math.round(rate * 1000) / 10 : null };
  });
  const best = [...withRate].sort((a, b) => b.producedRevenueNgn - a.producedRevenueNgn)[0];
  const lowestCol = [...withRate]
    .filter((b) => b.collectionRatePct != null)
    .sort((a, b) => a.collectionRatePct - b.collectionRatePct)[0];
  const highestStock = [...withRate].sort((a, b) => b.coilValuationNgn - a.coilValuationNgn)[0];
  let highestDebtor = '—';
  let maxDebt = 0;
  for (const [bid, debt] of branchDebtMap.entries()) {
    if (debt > maxDebt) {
      maxDebt = debt;
      highestDebtor = branchName(db, bid);
    }
  }

  return {
    bestPerformingBranch: best ? branchName(db, best.branchId) : '—',
    highestDebtorBranch: highestDebtor,
    lowestCollectionRateBranch: lowestCol ? branchName(db, lowestCol.branchId) : '—',
    highestStockRiskBranch: highestStock ? branchName(db, highestStock.branchId) : '—',
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
      route: '/analytics',
    },
    {
      title: 'Stock intelligence',
      description: 'Coil SKU cover, buy/liquidate signals (estimated).',
      route: '/analytics',
    },
    {
      title: 'Expense analysis',
      description: 'Category and branch expense vs produced sales.',
      route: '/analytics',
    },
    {
      title: 'Working capital snapshot',
      description: 'Cash, receivables, inventory, and pending outflows.',
      route: '/exec',
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

  let biPack;
  try {
    biPack = loadBusinessIntelligencePack(db, branchScope, {
      periodKey: period.biPeriodKey,
      asOfISO: period.asOfISO || period.endISO,
    });
  } catch (e) {
    biPack = { ok: false, error: String(e?.message || e) };
  }

  const execSummary = execOrgSummary(db);
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

  const inventoryPanels = biPack.ok ? buildInventoryPanels(biPack) : buildInventoryPanels({ inventory: {}, sales: {} });

  const extras = listExecutiveExtras(db, branchScope);
  const useQueueSummary = !canAccessAttentionInbox(user);
  let workTrayItems = [];
  if (canAccessAttentionInbox(user)) {
    try {
      const attention = listMdAttentionInbox(db, branchScope);
      workTrayItems = mapAttentionToWorkTray(db, attention, user, readOnlyExecutiveView);
    } catch {
      workTrayItems = buildQueueSummaryTray(execSummary, user, readOnlyExecutiveView);
    }
  } else {
    workTrayItems = buildQueueSummaryTray(execSummary, user, readOnlyExecutiveView);
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

  workTrayItems.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
  });

  const decisionAlerts = biPack.ok ? buildDecisionAlerts(biPack, execSummary, inventoryPanels) : [];
  const criticalAlerts = decisionAlerts.filter((a) => a.level === 'critical').length;

  const topCustomersByDebtRows = topCustomersByDebt(db, branchScope, period.startISO, period.endISO);
  const topCustomersByPayments = sales.topCustomers || [];

  const branchDebtMap = new Map();
  for (const q of listQuotations(db, branchScope)) {
    const due = receivableDueOnQuotationFromEntries(
      listLedgerEntries(db, branchScope),
      q,
      listProductionJobs(db, branchScope)
    );
    if (due <= 0) continue;
    const bid = String(q.branchId || q.branch_id || 'UNASSIGNED').trim();
    branchDebtMap.set(bid, (branchDebtMap.get(bid) || 0) + due);
  }

  const byBranchRows = branchBreakdown.byBranch || [];
  const comparisonAvailable = byBranchRows.length > 1;
  const highlights = comparisonAvailable
    ? buildBranchHighlights(db, byBranchRows, branchDebtMap)
    : {
        bestPerformingBranch: null,
        highestDebtorBranch: null,
        lowestCollectionRateBranch: null,
        highestStockRiskBranch: null,
      };

  const expenseSplit = mapExpenseProductiveOverhead(expenseAnalysis.topCategories);
  const dataScopeNotes = buildExecDataScopeNotes(period);

  const actor = {
    role: roleKey,
    canActOnApprovals: canAct,
    readOnlyExecutiveView,
    canViewAudit,
    canUseAllBranches: canUseAllBranchesRollup(user),
  };

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
      expenseToSalesPct: expenseAnalysis.expenseToSalesPct ?? null,
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
        byKind: workTrayItems.reduce((acc, it) => {
          acc[it.kind] = (acc[it.kind] || 0) + 1;
          return acc;
        }, {}),
      },
      readOnlyForActor: readOnlyExecutiveView,
    },
    sales: {
      receivablesAging: sales.receivablesAging || {},
      topCustomersByPayments,
      topCustomersByDebt: topCustomersByDebtRows,
    },
    inventory: inventoryPanels,
    expenses: {
      topCategories: expenseAnalysis.topCategories || [],
      byBranch: expenseAnalysis.byBranch || [],
      trend: expenseAnalysis.monthlyTrend || [],
      alerts: expenseAnalysis.alerts || [],
      expenseToSalesPct: expenseAnalysis.expenseToSalesPct ?? null,
      periodChangePct: expenseAnalysis.periodChangePct ?? null,
      productiveOverhead: expenseSplit,
    },
    branches: {
      byBranch: byBranchRows.map((b) => ({
        ...b,
        branchName: branchName(db, b.branchId),
        customerDebtNgn: Math.round(branchDebtMap.get(b.branchId) || 0),
        collectionRatePct:
          b.producedRevenueNgn > 0
            ? Math.round((b.netCollectedNgn / b.producedRevenueNgn) * 1000) / 10
            : null,
        collectionRateLabel: 'Produced collection rate',
        collectionRateBasis: 'produced_vs_collected',
      })),
      highlights,
      comparisonAvailable,
      comparisonEmptyReason:
        !comparisonAvailable && branchScope !== 'ALL'
          ? 'single_branch'
          : !comparisonAvailable
            ? 'no_branch_rows'
            : null,
    },
    cash: {
      cashNgn: Math.round(treasuryCashNgn),
      pendingOutflowsNgn: Math.round(predictive.pendingOutflowsNgn || 0),
      receivablesNgn: Math.round(sales.outstandingReceivablesNgn || 0),
      inventoryValueNgn: Math.round(inventoryValueNgn),
      pendingRefunds: execSummary.pendingRefunds ?? 0,
      pendingRefundsIsCount: true,
      pendingPaymentRequests: execSummary.pendingPaymentRequests ?? 0,
      payrollDraftsAwaitingMd: execSummary.payrollDraftsAwaitingMd ?? 0,
      payrollDraftsAwaitingMdIsCount: true,
      horizons: predictive.horizons || [],
      alerts: (predictive.alerts || []).filter((a) => a.category === 'cash'),
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
        analytics: '/analytics',
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
