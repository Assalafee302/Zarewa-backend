import { buildBootstrap } from './bootstrap.js';
import { userHasPermission } from './auth.js';
import { resolveBootstrapBranchScope } from './branchScope.js';
import {
  canReadFinanceDomain,
  canReadOperationsDomain,
  canReadProcurementDomain,
  canReadSalesDomain,
} from './workspaceAccess.js';
import { workspaceQuickSearch } from './workspaceSearchOps.js';
import {
  hrListScope,
  hrTablesReady,
  listHrAttendance,
  listHrObservability,
  listHrPolicyAcknowledgements,
  listHrStaff,
  listPayrollRuns,
} from './hrOps.js';
import { canAccessModuleWithPermissions } from '../shared/lib/moduleAccess.js';
import { buildWorkspaceNotifications } from '../shared/lib/workspaceNotifications.js';
import { quotationNeedsFollowUpAlert } from '../shared/lib/quotationLifecycleUi.js';
import { computeCuttingListMaterialReadiness } from '../shared/lib/salesCuttingListMaterialReadiness.js';
import { openAuditQueue, totalLiquidityNgn } from '../shared/lib/liveAnalytics.js';
import { refundOutstandingAmount } from '../shared/lib/refundsStore.js';

export const AI_ASSISTANT_MODES = ['search', 'sales', 'procurement', 'operations', 'finance', 'hr'];

function inferAiModeFromPath(pathname) {
  const path = String(pathname || '').toLowerCase();
  if (path.startsWith('/sales') || path.startsWith('/customers')) return 'sales';
  if (path.startsWith('/procurement')) return 'procurement';
  if (path.startsWith('/operations') || path.startsWith('/deliveries')) return 'operations';
  if (path.startsWith('/accounts') || path.startsWith('/accounting')) return 'finance';
  if (path.startsWith('/hr')) return 'hr';
  return 'search';
}

function parsePathFromContext(context) {
  const match = String(context || '').match(/Path:\s*(\S+)/i);
  return match ? match[1] : '';
}

function formatNgn(n) {
  return `NGN ${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

function clampText(value, max = 12000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function pushLines(lines, title, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  lines.push(title);
  rows.forEach((row) => lines.push(`- ${row}`));
}

function topRows(rows, limit, mapFn) {
  return (rows || []).slice(0, limit).map(mapFn).filter(Boolean);
}

function allowedModesForPermissions(user, permissions) {
  if (!user || String(user.roleKey || '').toLowerCase() === 'ceo') return [];
  const modes = ['search'];
  if (canReadSalesDomain(user)) modes.push('sales');
  if (canReadProcurementDomain(user)) modes.push('procurement');
  if (canReadOperationsDomain(user)) modes.push('operations');
  if (canReadFinanceDomain(user)) modes.push('finance');
  if (canAccessModuleWithPermissions(permissions || [], 'hr')) modes.push('hr');
  return modes;
}

function normalizeMode(rawMode, pageContext, context) {
  const direct = String(rawMode || '').trim().toLowerCase();
  if (AI_ASSISTANT_MODES.includes(direct)) return direct;
  const path = pageContext?.pathname || parsePathFromContext(context);
  return inferAiModeFromPath(path);
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (String(row?.role || '').toLowerCase() === 'user') {
      return String(row?.content || '').trim();
    }
  }
  return '';
}

function scalarPageContext(pageContext) {
  const entries = Object.entries(pageContext || {})
    .filter(([, value]) => value != null && value !== '' && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${value}`);
  return entries;
}

function firstGaugeNumeric(gaugeStr) {
  const match = String(gaugeStr ?? '').match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1], 10) : null;
}

function roughMetersFromKg(kg, gaugeMm) {
  if (kg == null || Number.isNaN(kg) || kg <= 0) return null;
  const gauge = gaugeMm ?? 0.26;
  const kgPerM =
    gauge <= 0.22 ? 2.35 : gauge <= 0.26 ? 2.65 : gauge <= 0.3 ? 2.9 : gauge <= 0.45 ? 3.4 : 3.8;
  return Math.max(0, Math.round(kg / kgPerM));
}

function colourShort(colourStr) {
  const value = String(colourStr ?? '').trim();
  if (!value) return '—';
  const token = value.split(/[·,]/)[0].trim();
  return token.length > 8 ? `${token.slice(0, 7)}…` : token;
}

function buildSalesCoilInventoryRows(snapshot) {
  const products = Array.isArray(snapshot?.products) ? snapshot.products : [];
  const coilLots = Array.isArray(snapshot?.coilLots) ? snapshot.coilLots : [];
  const yardRegister = Array.isArray(snapshot?.yardCoilRegister) ? snapshot.yardCoilRegister : [];
  const seenIds = new Set();
  const rows = [];
  const pushRow = (row) => {
    if (seenIds.has(row.id)) return;
    seenIds.add(row.id);
    rows.push(row);
  };

  if (coilLots.length > 0) {
    coilLots.forEach((lot) => {
      const product = products.find((row) => row.productID === lot.productID);
      const attrs = product?.dashboardAttrs || {};
      const gaugeLabel = attrs?.gauge ?? lot.gaugeLabel ?? '—';
      const gaugeNum = firstGaugeNumeric(gaugeLabel);
      const kgNum =
        lot.weightKg != null && !Number.isNaN(Number(lot.weightKg))
          ? Number(lot.weightKg)
          : product?.unit === 'kg'
            ? Number(lot.qtyReceived)
            : null;
      pushRow({
        id: lot.coilNo,
        colour: colourShort(attrs?.colour ?? lot.colour),
        gaugeLabel,
        materialType: attrs?.materialType ?? lot.materialTypeName ?? product?.name ?? lot.productID,
        kg: kgNum,
        estMeters: roughMetersFromKg(kgNum, gaugeNum),
        low: product ? Number(product.stockLevel) < Number(product.lowStockThreshold) : false,
      });
    });
  } else {
    products
      .filter((row) => row.unit === 'kg')
      .forEach((product) => {
        const attrs = product.dashboardAttrs || {};
        const gaugeLabel = attrs?.gauge ?? '—';
        const gaugeNum = firstGaugeNumeric(gaugeLabel);
        const kgTotal = Number(product.stockLevel) || 0;
        const colours = String(attrs?.colour ?? '')
          .split(/[·,]/)
          .map((token) => token.trim())
          .filter(Boolean);
        const share = colours.length > 0 ? Math.max(0, Math.round(kgTotal / colours.length)) : kgTotal;
        if (colours.length === 0) {
          pushRow({
            id: product.productID,
            colour: colourShort(attrs?.colour),
            gaugeLabel,
            materialType: attrs?.materialType ?? product.name,
            kg: kgTotal,
            estMeters: roughMetersFromKg(kgTotal, gaugeNum),
            low: Number(product.stockLevel) < Number(product.lowStockThreshold),
          });
          return;
        }
        colours.forEach((colour, index) => {
          pushRow({
            id: `${product.productID}-${index + 1}`,
            colour: colourShort(colour),
            gaugeLabel,
            materialType: attrs?.materialType ?? product.name,
            kg: share,
            estMeters: roughMetersFromKg(share, gaugeNum),
            low: Number(product.stockLevel) < Number(product.lowStockThreshold),
          });
        });
      });
  }

  yardRegister.forEach((row) => {
    pushRow({
      id: row.id,
      colour: row.colour,
      gaugeLabel: row.gaugeLabel,
      materialType: row.materialType,
      kg: row.weightKg,
      estMeters: roughMetersFromKg(row.weightKg, firstGaugeNumeric(row.gaugeLabel)),
      low: false,
    });
  });

  return rows;
}

function aiPermissions(req) {
  return Array.isArray(req?.session?.permissions) ? req.session.permissions : [];
}

function lowStockCount(snapshot) {
  return (snapshot?.products || []).filter((row) => Number(row.stockLevel) < Number(row.lowStockThreshold)).length;
}

function dashboardNotifications(req, snapshot) {
  const permissions = aiPermissions(req);
  return buildWorkspaceNotifications({
    snapshot,
    hasPermission: (permission) => permission === '*' || userHasPermission(req.user, permission),
    canAccessModule: (moduleKey) => canAccessModuleWithPermissions(permissions, moduleKey),
    lowStockSkuCount: lowStockCount(snapshot),
  });
}

function searchHitsForQuery(db, req, searchQuery, limit = 8) {
  const query = String(searchQuery || '').trim();
  if (query.length < 2) return [];
  return workspaceQuickSearch(db, req, query, limit);
}

function searchSection(db, req, pageContext) {
  const searchQuery = String(pageContext?.searchQuery || '').trim();
  const hits = searchHitsForQuery(db, req, searchQuery, 8);
  if (!searchQuery) return [];
  if (hits.length === 0) return [`Search query from UI: ${searchQuery}`, 'No structured search hits matched that query.'];
  return [
    `Search query from UI: ${searchQuery}`,
    ...hits.map((hit) => `${hit.kind} · ${hit.label}${hit.sublabel ? ` · ${hit.sublabel}` : ''}`),
  ];
}

function salesContextLines(db, req, snapshot, branchScope, pageContext) {
  const activeTab = String(pageContext?.activeTab || pageContext?.focusSalesTab || 'quotations');
  const quotes = Array.isArray(snapshot?.quotations) ? snapshot.quotations : [];
  const receipts = Array.isArray(snapshot?.receipts) ? snapshot.receipts : [];
  const cuttingLists = Array.isArray(snapshot?.cuttingLists) ? snapshot.cuttingLists : [];
  const refunds = Array.isArray(snapshot?.refunds) ? snapshot.refunds : [];
  const customers = Array.isArray(snapshot?.customers) ? snapshot.customers : [];
  const followUps = quotes.filter((row) => quotationNeedsFollowUpAlert(row));
  const overdueQuotes = quotes.filter((row) => {
    if (String(row.paymentStatus || '').trim() === 'Paid') return false;
    const due = String(row.dueDateISO || '').trim();
    if (!due) return false;
    return due < new Date().toISOString().slice(0, 10);
  });
  const refundsAwaitingPay = refunds.filter((row) => row.status === 'Approved' && refundOutstandingAmount(row) > 0);
  const readiness = computeCuttingListMaterialReadiness(cuttingLists, quotes, buildSalesCoilInventoryRows(snapshot));
  const searchRows = searchSection(db, req, pageContext);

  const lines = [
    `Branch scope: ${branchScope}`,
    `Current sales tab: ${activeTab}`,
    `Visible sales records: ${quotes.length} quotations, ${receipts.length} receipts, ${cuttingLists.length} cutting lists, ${refunds.length} refunds, ${customers.length} customers.`,
    `Attention counts: ${followUps.length} quotations need follow-up, ${overdueQuotes.length} quotations are past due, ${refundsAwaitingPay.length} refunds await payout, ${readiness.waitingWithSpecNoStock} cutting lists have spec but no stock match.`,
  ];

  pushLines(
    lines,
    'Quotation follow-up sample:',
    topRows(followUps, 5, (row) => `${row.id} · ${row.customer} · ${row.status} · ${row.paymentStatus}`)
  );
  pushLines(
    lines,
    'Recent receipts sample:',
    topRows(receipts, 5, (row) => `${row.id} · ${row.customer} · ${formatNgn(row.amountNgn)} · ${row.dateISO || row.date}`)
  );
  pushLines(
    lines,
    'Cutting-list readiness sample:',
    topRows(
      readiness.ready,
      5,
      (row) =>
        `${row.cl.id} · ${row.cl.customer} · est ${Math.round(row.totalEstM || 0).toLocaleString()} m available vs ${Math.round(
          row.needM || 0
        ).toLocaleString()} m needed`
    )
  );
  pushLines(
    lines,
    'Refund queue sample:',
    topRows(refundsAwaitingPay, 5, (row) => `${row.refundID} · ${row.customer} · outstanding ${formatNgn(refundOutstandingAmount(row))}`)
  );
  pushLines(lines, 'Search detail:', searchRows);
  return lines;
}

function purchaseOrderOutstandingNgn(po) {
  return (po?.lines || []).reduce((sum, line) => {
    const qty = Number(line.qtyOrdered) || 0;
    const unitPrice = Number(line.unitPricePerKgNgn ?? line.unitPriceNgn) || 0;
    return sum + qty * unitPrice;
  }, 0);
}

function procurementContextLines(db, req, snapshot, branchScope, pageContext) {
  const activeTab = String(pageContext?.activeTab || pageContext?.focusTab || 'purchases');
  const pos = Array.isArray(snapshot?.purchaseOrders) ? snapshot.purchaseOrders : [];
  const suppliers = Array.isArray(snapshot?.suppliers) ? snapshot.suppliers : [];
  const lowStock = (snapshot?.products || []).filter((row) => Number(row.stockLevel) < Number(row.lowStockThreshold));
  const inTransit = pos.filter((row) => row.status === 'In Transit' || row.status === 'On loading');
  const outstandingValue = pos.reduce((sum, row) => sum + purchaseOrderOutstandingNgn(row), 0);
  const searchRows = searchSection(db, req, pageContext);
  const lines = [
    `Branch scope: ${branchScope}`,
    `Current procurement tab: ${activeTab}`,
    `Visible procurement records: ${pos.length} purchase orders, ${suppliers.length} suppliers, ${lowStock.length} low-stock products in view.`,
    `Purchasing pressure: ${inTransit.length} orders are in transit or on loading. Open ordered value is about ${formatNgn(outstandingValue)}.`,
  ];
  pushLines(
    lines,
    'Transit purchase orders:',
    topRows(inTransit, 5, (row) => `${row.poID} · ${row.supplierName} · ${row.status} · ETA ${row.expectedDeliveryISO || '—'}`)
  );
  pushLines(
    lines,
    'Supplier sample:',
    topRows(suppliers, 5, (row) => `${row.supplierID} · ${row.name}${row.city ? ` · ${row.city}` : ''}`)
  );
  pushLines(
    lines,
    'Low-stock sample:',
    topRows(lowStock, 5, (row) => `${row.productID} · ${row.name} · ${row.stockLevel}/${row.lowStockThreshold}`)
  );
  pushLines(lines, 'Search detail:', searchRows);
  return lines;
}

function operationsContextLines(db, req, snapshot, branchScope, pageContext) {
  const activeTab = String(pageContext?.activeTab || pageContext?.focusOpsTab || 'inventory');
  const jobs = Array.isArray(snapshot?.productionJobs) ? snapshot.productionJobs : [];
  const checks = Array.isArray(snapshot?.productionConversionChecks) ? snapshot.productionConversionChecks : [];
  const machines = Array.isArray(snapshot?.machines) ? snapshot.machines : [];
  const coilRequests = Array.isArray(snapshot?.coilRequests) ? snapshot.coilRequests : [];
  const lowStock = (snapshot?.products || []).filter((row) => Number(row.stockLevel) < Number(row.lowStockThreshold));
  const criticalChecks = checks.filter((row) => String(row.alertState || '').toLowerCase() === 'critical');
  const needsReviewJobs = jobs.filter((row) => Boolean(row.managerReviewRequired));
  const pendingCoilRequests = coilRequests.filter((row) => String(row.status || '').toLowerCase() === 'pending');
  const searchRows = searchSection(db, req, pageContext);
  const attn = snapshot?.operationsInventoryAttention;
  const attnLine = attn?.ok
    ? `Attention rollup: ${attn.stuckProductionAttentionDistinctJobCount ?? 0} distinct open job(s) with hygiene flags · WIP rows≠0: ${attn.inventoryChain?.wipProductsNonZero ?? 0} · FG completion adjustments (30d): ${attn.inventoryChain?.completionAdjustmentsLast30d ?? 0} · deliveries in progress: ${attn.inventoryChain?.deliveriesInProgress?.count ?? 0} · partial POs: ${attn.crossModule?.partialPurchaseOrderCount ?? 0} · open in-transit loads: ${attn.crossModule?.openInTransitLoadCount ?? 0}.`
    : '';
  const lines = [
    `Branch scope: ${branchScope}`,
    `Current operations tab: ${activeTab}`,
    `Visible operations records: ${jobs.length} production jobs, ${checks.length} conversion checks, ${machines.length} machines (maintenance), ${pendingCoilRequests.length} pending coil requests.`,
    `Exceptions: ${criticalChecks.length} critical conversion checks, ${needsReviewJobs.length} jobs marked for manager review, ${lowStock.length} low-stock SKUs.`,
    ...(attnLine ? [attnLine] : []),
  ];
  pushLines(
    lines,
    'Critical conversion sample:',
    topRows(
      criticalChecks,
      5,
      (row) => `${row.coilNo || row.jobID || row.id || '—'} · ${row.alertState} · variance ${row.variancePct ?? row.variancePercent ?? '—'}`
    )
  );
  pushLines(
    lines,
    'Jobs needing review:',
    topRows(needsReviewJobs, 5, (row) => `${row.jobID} · ${row.quotationRef || '—'} · ${row.status || '—'}`)
  );
  pushLines(
    lines,
    'Pending coil requests:',
    topRows(
      pendingCoilRequests,
      5,
      (row) => `${row.id} · ${row.gauge || '—'} mm · ${row.colour || '—'} · ${row.requestedKg || 0} kg`
    )
  );
  pushLines(lines, 'Search detail:', searchRows);
  return lines;
}

function financeContextLines(db, req, snapshot, branchScope, pageContext) {
  const activeTab = String(pageContext?.activeTab || pageContext?.accountsTab || 'treasury');
  const treasuryAccounts = Array.isArray(snapshot?.treasuryAccounts) ? snapshot.treasuryAccounts : [];
  const paymentRequests = Array.isArray(snapshot?.paymentRequests) ? snapshot.paymentRequests : [];
  const refunds = Array.isArray(snapshot?.refunds) ? snapshot.refunds : [];
  const payables = Array.isArray(snapshot?.accountsPayable) ? snapshot.accountsPayable : [];
  const bankReconciliation = Array.isArray(snapshot?.bankReconciliation) ? snapshot.bankReconciliation : [];
  const receipts = Array.isArray(snapshot?.receipts) ? snapshot.receipts : [];
  const auditQueue = openAuditQueue(bankReconciliation, paymentRequests, refunds);
  const refundsAwaitingPay = refunds.filter((row) => row.status === 'Approved' && refundOutstandingAmount(row) > 0);
  const openPayables = payables.reduce(
    (sum, row) => sum + Math.max(0, (Number(row.amountNgn) || 0) - (Number(row.paidNgn) || 0)),
    0
  );
  const unclearedReceipts = receipts.filter(
    (row) => row.bankConfirmedAtISO || row.bankReceivedAmountNgn != null || row.financeDeliveryClearedAtISO
  );
  const searchRows = searchSection(db, req, pageContext);
  const lines = [
    `Branch scope: ${branchScope}`,
    `Current finance tab: ${activeTab}`,
    `Visible finance records: ${treasuryAccounts.length} treasury accounts, ${paymentRequests.length} payment requests, ${refunds.length} refunds, ${payables.length} payables, ${bankReconciliation.length} bank-reconciliation lines.`,
    `Liquidity and queues: total liquidity ${formatNgn(totalLiquidityNgn(treasuryAccounts))}, open payables about ${formatNgn(openPayables)}, ${refundsAwaitingPay.length} refunds await payout, audit queue size ${auditQueue.length}.`,
  ];
  pushLines(
    lines,
    'Treasury balances:',
    topRows(treasuryAccounts, 5, (row) => `${row.name} · ${row.type} · ${formatNgn(row.balance)}`)
  );
  pushLines(
    lines,
    'Audit and reconciliation queue:',
    topRows(auditQueue, 6, (row) => `${row.id} · ${row.customer} · ${formatNgn(row.amount)} · ${row.desc}`)
  );
  pushLines(
    lines,
    'Refund payouts awaiting treasury:',
    topRows(refundsAwaitingPay, 5, (row) => `${row.refundID} · ${row.customer} · ${formatNgn(refundOutstandingAmount(row))}`)
  );
  pushLines(
    lines,
    'Receipt finance sample:',
    topRows(
      unclearedReceipts,
      5,
      (row) => `${row.id} · ${row.customer} · bank confirmed ${row.bankConfirmedAtISO || '—'} · cleared ${row.financeDeliveryClearedAtISO || '—'}`
    )
  );
  pushLines(lines, 'Search detail:', searchRows);
  return lines;
}

function hrContextLines(db, req, pageContext) {
  if (!hrTablesReady(db)) {
    return ['HR module tables are not initialized in this workspace.'];
  }
  const scope = hrListScope(req);
  const staff = listHrStaff(db, scope);
  const observability = listHrObservability(db, scope);
  const payrollRuns = listPayrollRuns(db);
  const attendanceUploads = listHrAttendance(db, scope);
  const handbookAcks = listHrPolicyAcknowledgements(db, { policyKey: 'employee_handbook' });
  const staffUserId = String(pageContext?.staffUserId || '').trim();
  const selectedStaff = staffUserId ? staff.find((row) => String(row.userId || '') === staffUserId) : null;
  const lines = [
    `HR branch scope: ${scope.viewAll ? 'ALL' : scope.branchId}`,
    `Visible HR records: ${staff.length} staff records, ${observability.summary?.pendingHrReview || 0} pending HR reviews, ${observability.summary?.pendingManagerReview || 0} manager-side reviews, ${observability.summary?.overdueRequests || 0} overdue requests.`,
    `Payroll and attendance: ${payrollRuns.length} payroll runs visible, ${attendanceUploads.length} attendance uploads visible, ${handbookAcks.length} handbook acknowledgements recorded.`,
  ];
  pushLines(
    lines,
    'Recent payroll runs:',
    topRows(payrollRuns, 5, (row) => `${row.id} · ${row.periodYyyymm} · ${row.status}`)
  );
  pushLines(
    lines,
    'Recent attendance uploads:',
    topRows(attendanceUploads, 4, (row) => `${row.id} · period ${row.periodYyyymm} · ${row.branchId}`)
  );
  pushLines(
    lines,
    'Recent handbook acknowledgements:',
    topRows(
      handbookAcks,
      5,
      (row) => `${row.userId} · ${row.policyVersion} · ${String(row.acceptedAtIso || '').slice(0, 10)}`
    )
  );
  if (selectedStaff) {
    pushLines(lines, 'Selected staff context:', [
      `${selectedStaff.displayName || selectedStaff.username} · ${selectedStaff.department || '—'} · ${
        selectedStaff.jobTitle || '—'
      } · branch ${selectedStaff.branchId || '—'}`,
      `Compliance flags: handbook ${selectedStaff.complianceBadges?.handbookAcknowledged ? 'acknowledged' : 'missing'}, overdue review ${
        selectedStaff.complianceBadges?.overdueReview ? 'yes' : 'no'
      }`,
    ]);
  }
  return lines;
}

function searchDashboardContextLines(db, req, snapshot, branchScope, pageContext, messages) {
  const notifications = dashboardNotifications(req, snapshot);
  const query = String(pageContext?.searchQuery || '').trim() || '';
  const hits = query ? searchHitsForQuery(db, req, query, 8) : [];
  const latestQuestion = latestUserMessage(messages);
  const lines = [
    `Branch scope: ${branchScope}`,
    `Visible workspace snapshot: ${snapshot.customers?.length || 0} customers, ${snapshot.quotations?.length || 0} quotations, ${
      snapshot.purchaseOrders?.length || 0
    } purchase orders, ${snapshot.productionJobs?.length || 0} production jobs, ${snapshot.paymentRequests?.length || 0} payment requests.`,
    `Current dashboard signals: ${lowStockCount(snapshot)} low-stock SKUs, ${notifications.length} notification cards visible for this role.`,
  ];
  pushLines(
    lines,
    'Current notifications:',
    topRows(notifications, 6, (row) => `${row.title} · ${row.detail}${row.path ? ` · ${row.path}` : ''}`)
  );
  if (query) {
    pushLines(
      lines,
      'Workspace search results:',
      hits.length > 0
        ? hits.map((row) => `${row.kind} · ${row.label}${row.sublabel ? ` · ${row.sublabel}` : ''}`)
        : ['No structured hits matched the current search query.']
    );
  }
  if (latestQuestion) {
    lines.push(`Latest user question: ${latestQuestion}`);
  }
  return lines;
}

export function readAiStatusForRequest(req, aiEnabled) {
  const permissions = aiPermissions(req);
  const allowedModes = allowedModesForPermissions(req?.user, permissions);
  return {
    ok: true,
    enabled: Boolean(aiEnabled) && allowedModes.length > 0,
    allowedModes,
  };
}

export function buildAiContextForRequest(db, req, opts = {}) {
  const permissions = aiPermissions(req);
  const allowedModes = allowedModesForPermissions(req?.user, permissions);
  const mode = normalizeMode(opts.mode, opts.pageContext, opts.context);

  if (!allowedModes.includes(mode)) {
    const err = new Error('AI assistant is not available for this area.');
    err.code = 'AI_FORBIDDEN';
    throw err;
  }

  const branchScope = resolveBootstrapBranchScope(req);
  const baseLines = [];
  const pageContextLines = scalarPageContext(opts.pageContext);
  if (pageContextLines.length > 0) {
    pushLines(baseLines, 'Client page context:', pageContextLines);
  }

  if (mode === 'hr') {
    const hrLines = hrContextLines(db, req, opts.pageContext || {});
    return {
      mode,
      retrievedContext: clampText([...baseLines, 'Live workspace context:', ...hrLines].join('\n')),
    };
  }

  const snapshot = buildBootstrap(db, {
    user: req.user,
    session: req.session,
    includeControls: false,
    includeUsers: false,
    branchScope,
  });

  let modeLines = [];
  if (mode === 'sales') {
    modeLines = salesContextLines(db, req, snapshot, branchScope, opts.pageContext || {});
  } else if (mode === 'procurement') {
    modeLines = procurementContextLines(db, req, snapshot, branchScope, opts.pageContext || {});
  } else if (mode === 'operations') {
    modeLines = operationsContextLines(db, req, snapshot, branchScope, opts.pageContext || {});
  } else if (mode === 'finance') {
    modeLines = financeContextLines(db, req, snapshot, branchScope, opts.pageContext || {});
  } else {
    modeLines = searchDashboardContextLines(db, req, snapshot, branchScope, opts.pageContext || {}, opts.messages);
  }

  return {
    mode,
    retrievedContext: clampText([...baseLines, 'Live workspace context:', ...modeLines].join('\n')),
  };
}
