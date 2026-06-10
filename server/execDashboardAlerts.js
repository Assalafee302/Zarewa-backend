/**
 * Executive Command Centre — management-style decision alerts from BI + ops data.
 */

function familyLabel(family) {
  const f = String(family || '').toLowerCase();
  if (f === 'aluzinc') return 'Aluzinc';
  if (f === 'aluminium') return 'Aluminium';
  return f ? f.charAt(0).toUpperCase() + f.slice(1) : 'Material';
}

/**
 * @param {string} branchId
 * @param {(id: string) => string} branchNameFn
 */
function branchLabel(branchId, branchNameFn) {
  const n = branchNameFn(branchId);
  return n && n !== '—' ? n : branchId || 'Branch';
}

/**
 * @param {object} biPack
 * @param {object} execSummary
 * @param {object} inventoryPanels
 * @param {{ branchName: (id: string) => string; byBranch?: object[]; expenseAnalysis?: object; sales?: object }} ctx
 */
export function buildExecutiveDecisionAlerts(biPack, execSummary, inventoryPanels, ctx = {}) {
  /** @type {object[]} */
  const alerts = [];
  const seen = new Set();
  const branchNameFn = ctx.branchName || (() => '—');

  const push = (row) => {
    if (!row?.id || seen.has(row.id)) return;
    seen.add(row.id);
    alerts.push(row);
  };

  for (const row of inventoryPanels.lowStockHighDemand || []) {
    const fam = familyLabel(row.family);
    const cover = row.weeksCover != null ? `${row.weeksCover} weeks` : 'low';
    const level = row.weeksCover != null && row.weeksCover < 2 ? 'critical' : 'warning';
    push({
      id: `sku-buy-${row.family}-${row.gauge}-${row.colour}`,
      level,
      title: 'Stock cover risk',
      message: `${row.gauge} ${row.colour} ${fam} has high demand but only ${cover} of cover remaining.`,
      source: 'sku_intelligence',
      route: '/exec?tab=intelligence',
      metric: row.weeksCover != null ? `${row.weeksCover} wk` : '',
    });
  }

  for (const row of inventoryPanels.slowMovingStock || []) {
    const fam = familyLabel(row.family);
    const val =
      row.valuationNgn != null ? ` (about ₦${Math.round(row.valuationNgn).toLocaleString('en-NG')} tied up)` : '';
    push({
      id: `sku-slow-${row.family}-${row.gauge}-${row.colour}`,
      level: 'opportunity',
      title: 'Slow-moving stock',
      message: `${row.gauge} ${row.colour} ${fam} has ${row.weeksCover ?? 'high'} weeks cover${val} — cash may be tied in slow movers.`,
      source: 'sku_intelligence',
      route: '/exec?tab=intelligence',
    });
  }

  const byBranch = ctx.byBranch || biPack.branchBreakdown?.byBranch || [];
  for (const b of byBranch) {
    const name = branchLabel(b.branchId, branchNameFn);
    const produced = Number(b.producedRevenueNgn) || 0;
    const collected = Number(b.netCollectedNgn) || 0;
    const rate = produced > 0 ? Math.round((collected / produced) * 1000) / 10 : null;
    if (produced >= 500_000 && rate != null && rate < 55) {
      push({
        id: `branch-collect-${b.branchId}`,
        level: rate < 40 ? 'critical' : 'warning',
        title: 'Collections pressure',
        message: `${name} has strong produced sales (₦${produced.toLocaleString('en-NG')}) but weak collections (${rate}% of produced), creating receivable pressure.`,
        source: 'branch_scorecard',
        route: '/exec?tab=intelligence',
        metric: `${rate}%`,
      });
    }
    const stockVal = Number(b.coilValuationNgn) || 0;
    const liq = Number(b.liquidateSkuCount) || 0;
    if (stockVal >= 2_000_000 && liq > 0) {
      push({
        id: `branch-stock-${b.branchId}`,
        level: 'warning',
        title: 'Stock cash tie-up',
        message: `${name} holds high-value slow-moving stock (₦${stockVal.toLocaleString('en-NG')} coil valuation, ${liq} liquidate signal${liq === 1 ? '' : 's'}) that may be tying down cash.`,
        source: 'branch_scorecard',
        route: '/exec?tab=intelligence',
      });
    }
  }

  const expenseAnalysis = ctx.expenseAnalysis || biPack.expenseAnalysis || {};
  for (const a of expenseAnalysis.alerts || []) {
    const topCat = expenseAnalysis.topCategories?.[0];
    if (a.id === 'expense-spike' && expenseAnalysis.periodChangePct != null) {
      push({
        id: 'expense-spike-enriched',
        level: 'warning',
        title: 'Expense spike',
        message: `Operating expenses increased ${expenseAnalysis.periodChangePct}% versus the prior comparable period${topCat?.category ? ` — review ${topCat.category} and other categories` : ''}.`,
        source: 'expenses',
        route: '/exec?tab=intelligence',
        metric: `+${expenseAnalysis.periodChangePct}%`,
      });
      continue;
    }
    if (a.id === 'expense-category-dominant' && topCat) {
      push({
        id: 'expense-cat-dominant',
        level: 'info',
        title: 'Spend concentration',
        message: `${topCat.category} accounts for ${topCat.sharePct}% of period expenses (₦${Math.round(topCat.amountNgn).toLocaleString('en-NG')}) — confirm this matches plan.`,
        source: 'expenses',
        route: '/exec?tab=intelligence',
      });
      continue;
    }
    if (a.message && !/detected$/i.test(a.message)) {
      push({
        id: `exp-${a.id}`,
        level: a.severity === 'high' ? 'critical' : a.severity === 'medium' ? 'warning' : 'info',
        title: 'Expense signal',
        message: a.message,
        source: 'expenses',
        route: '/exec?tab=intelligence',
        metric: a.metric || '',
      });
    }
  }

  const transport = (expenseAnalysis.topCategories || []).find((c) =>
    /transport|carriage|freight|diesel|fuel/i.test(String(c.category || ''))
  );
  if (transport && expenseAnalysis.periodChangePct != null && expenseAnalysis.periodChangePct > 15) {
    push({
      id: 'transport-expense-rise',
      level: 'warning',
      title: 'Transport spend',
      message: `${transport.category} is a major expense line (₦${Math.round(transport.amountNgn).toLocaleString('en-NG')}) while total spend is up ${expenseAnalysis.periodChangePct}% versus the prior period.`,
      source: 'expenses',
      route: '/exec?tab=intelligence',
    });
  }

  const sales = ctx.sales || biPack.sales || {};
  const aging = sales.receivablesAging || {};
  const over90 = Number(aging.over_90 || aging['90+'] || 0);
  const d61 = Number(aging['61_90'] || 0);
  const totalAr = Number(sales.outstandingReceivablesNgn) || 0;
  if (over90 > 0 && over90 >= totalAr * 0.2 && totalAr > 100_000) {
    push({
      id: 'ar-over-90',
      level: 'critical',
      title: 'Aged receivables',
      message: `Customer debt over 90 days is ₦${Math.round(over90).toLocaleString('en-NG')} (${Math.round((over90 / totalAr) * 100)}% of outstanding) — prioritise collection follow-up.`,
      source: 'receivables',
      route: '/reports',
      metric: `₦${Math.round(over90).toLocaleString('en-NG')}`,
    });
  } else if (d61 + over90 > totalAr * 0.35 && totalAr > 100_000) {
    push({
      id: 'ar-61-plus',
      level: 'warning',
      title: 'Receivables aging',
      message: `Debt above 60 days totals ₦${Math.round(d61 + over90).toLocaleString('en-NG')} — collection follow-up needed.`,
      source: 'receivables',
      route: '/reports',
    });
  }

  for (const a of biPack.predictive?.alerts || []) {
    if (!a.message || /inventory alert detected|insight detected/i.test(a.message)) continue;
    if (seen.has(`bi-${a.id}`)) continue;
    push({
      id: `bi-${a.id}`,
      level: a.severity === 'high' ? 'critical' : a.severity === 'medium' ? 'warning' : 'info',
      title: String(a.category || 'cash')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      message: a.message,
      source: 'business_intelligence',
      route: '/exec?tab=intelligence',
      metric: a.metric || '',
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
      route: '/manager',
    });
  }

  const order = { critical: 0, warning: 1, opportunity: 2, info: 3 };
  return alerts
    .sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))
    .slice(0, 28);
}
