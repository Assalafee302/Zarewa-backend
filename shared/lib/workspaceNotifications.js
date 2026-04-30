import { refundOutstandingAmount } from './refundsStore.js';
import { workItemShowsOnWorkspaceUnifiedInbox } from './workItemPersonalInbox.js';
import { workItemNeedsActionForUser } from './workspaceInboxBuckets.js';

/**
 * Build actionable notifications from workspace snapshot, filtered by permissions.
 * @param {object} params
 * @param {object | null} params.snapshot
 * @param {(p: string) => boolean} params.hasPermission
 * @param {(m: string) => boolean} params.canAccessModule
 * @param {number} params.lowStockSkuCount
 * @param {{ pendingActionApprox?: number; unreadApprox?: number } | null} [params.officeSummary]
 */
export function buildWorkspaceNotifications({
  snapshot,
  hasPermission,
  canAccessModule,
  lowStockSkuCount,
  officeSummary = null,
}) {
  const items = [];
  const can = (p) => hasPermission('*') || hasPermission(p);

  if (canAccessModule('operations') && lowStockSkuCount > 0) {
    items.push({
      id: 'low-stock',
      title: 'Low stock',
      detail: `${lowStockSkuCount} SKU(s) below minimum reorder level.`,
      severity: 'warning',
      path: '/operations',
      state: { focusOpsTab: 'inventory' },
    });
  }

  const paymentRequests = Array.isArray(snapshot?.paymentRequests) ? snapshot.paymentRequests : [];
  const pendingPay = paymentRequests.filter((row) => {
    const requested = Number(row.amountRequestedNgn) || 0;
    const paid = Number(row.paidAmountNgn) || 0;
    if (row.approvalStatus === 'Rejected') return false;
    if (row.approvalStatus !== 'Approved') return true;
    return paid < requested;
  });

  if (
    canAccessModule('finance') &&
    (can('finance.approve') || can('finance.pay')) &&
    pendingPay.length > 0
  ) {
    items.push({
      id: 'payment-requests',
      title: 'Payment requests',
      detail: `${pendingPay.length} request(s) need approval or treasury payout.`,
      severity: 'warning',
      path: '/accounts',
      state: { accountsTab: 'requests' },
    });
  }

  const refunds = Array.isArray(snapshot?.refunds) ? snapshot.refunds : [];
  const refundDue = refunds.filter((x) => x.status === 'Approved' && refundOutstandingAmount(x) > 0);
  if (canAccessModule('finance') && can('finance.pay') && refundDue.length > 0) {
    items.push({
      id: 'refund-payouts',
      title: 'Refund payouts',
      detail: `${refundDue.length} approved refund(s) awaiting treasury payout.`,
      severity: 'warning',
      path: '/accounts',
      state: { accountsTab: 'treasury' },
    });
  }

  const coilReq = Array.isArray(snapshot?.coilRequests) ? snapshot.coilRequests : [];
  const pendingCoils = coilReq.filter((r) => r.status === 'pending');
  if (canAccessModule('operations') && can('operations.manage') && pendingCoils.length > 0) {
    items.push({
      id: 'coil-requests',
      title: 'Coil requests',
      detail: `${pendingCoils.length} store coil request(s) pending acknowledgement.`,
      severity: 'info',
      path: '/operations',
      state: { focusOpsTab: 'inventory' },
    });
  }

  const checks = Array.isArray(snapshot?.productionConversionChecks) ? snapshot.productionConversionChecks : [];
  const criticalCheck = checks.find(
    (row) => String(row.alertState || '').toLowerCase() === 'critical' && String(row.coilNo || '').trim()
  );
  if (canAccessModule('operations') && criticalCheck) {
    items.push({
      id: `coil-critical-${criticalCheck.id || criticalCheck.coilNo}`,
      title: 'Critical coil conversion',
      detail: `${criticalCheck.coilNo} flagged as critical in production checks.`,
      severity: 'warning',
      path: `/operations/coils/${encodeURIComponent(criticalCheck.coilNo)}`,
    });
  }

  const pos = Array.isArray(snapshot?.purchaseOrders) ? snapshot.purchaseOrders : [];
  const inTransit = pos.filter((p) => p.status === 'In Transit' || p.status === 'On loading');
  if (canAccessModule('procurement') && inTransit.length > 0) {
    items.push({
      id: 'po-transit',
      title: 'Purchases in motion',
      detail: `${inTransit.length} PO(s) on loading or in transit — store GRN when coils arrive.`,
      severity: 'info',
      path: '/procurement',
      state: { focusTab: 'suppliers' },
    });
  }

  const quotes = Array.isArray(snapshot?.quotations) ? snapshot.quotations : [];
  const overdue = quotes.filter((q) => {
    if (q.paymentStatus === 'Paid') return false;
    const due = q.dueDateISO;
    if (!due) return false;
    return due < new Date().toISOString().slice(0, 10);
  });
  if (canAccessModule('sales') && (can('sales.view') || can('quotations.manage')) && overdue.length > 0) {
    items.push({
      id: 'overdue-quotes',
      title: 'Quotations past due date',
      detail: `${overdue.length} open quotation(s) with due date before today — follow up collections.`,
      severity: 'warning',
      path: '/sales',
      state: { focusSalesTab: 'quotations' },
    });
  }

  if (canAccessModule('office') && officeSummary) {
    const pending = Number(officeSummary.pendingActionApprox) || 0;
    const unread = Number(officeSummary.unreadApprox) || 0;
    if (pending > 0 || unread > 0) {
      const parts = [];
      if (pending > 0) parts.push(`${pending} thread(s) need your action`);
      if (unread > 0) parts.push(`${unread} unread update(s)`);
      items.push({
        id: 'office-desk',
        title: 'Office Desk',
        detail: parts.join(' · ') || 'Updates on internal memos.',
        severity: pending > 0 ? 'warning' : 'info',
        path: '/',
      });
    }
  }

  const workItems = Array.isArray(snapshot?.unifiedWorkItems) ? snapshot.unifiedWorkItems : [];
  const userId = String(snapshot?.session?.user?.id || '').trim();
  const roleKey = snapshot?.session?.user?.roleKey;
  const permissions = snapshot?.permissions ?? snapshot?.session?.permissions ?? [];
  const inboxCtx = { userId, roleKey, permissions };
  const opsAttn = snapshot?.operationsInventoryAttention;
  if (
    canAccessModule('operations') &&
    (can('operations.manage') || can('production.manage')) &&
    opsAttn?.ok
  ) {
    const stuckN = Number(opsAttn.stuckProductionAttentionDistinctJobCount) || 0;
    if (stuckN > 0) {
      items.push({
        id: 'ops-stuck-production',
        title: 'Production queue hygiene',
        detail: `${stuckN} open production job(s) need follow-up (stale planned/running, missing coil allocations, manager review, or spec mismatch).`,
        severity: 'warning',
        path: '/operations',
        state: { focusOpsTab: 'production' },
      });
    }
    const ic = opsAttn.inventoryChain || {};
    const invHint =
      (Number(ic.wipProductsNonZero) || 0) +
      (Number(ic.completionAdjustmentsLast30d) || 0) +
      (Number(ic.deliveriesInProgress?.count) || 0);
    if (invHint > 0) {
      items.push({
        id: 'ops-inventory-chain',
        title: 'Inventory chain signals',
        detail: `WIP rows (non-zero): ${ic.wipProductsNonZero ?? 0} · Completion adjustments (30d): ${ic.completionAdjustmentsLast30d ?? 0} · Deliveries in progress: ${ic.deliveriesInProgress?.count ?? 0}.`,
        severity: 'info',
        path: '/operations',
        state: { focusOpsTab: 'inventory' },
      });
    }
    const cm = opsAttn.crossModule || {};
    const cross = (Number(cm.partialPurchaseOrderCount) || 0) + (Number(cm.openInTransitLoadCount) || 0);
    if (cross > 0) {
      items.push({
        id: 'ops-cross-module',
        title: 'Procurement / logistics hand-offs',
        detail: `${cm.partialPurchaseOrderCount ?? 0} PO(s) with under-received lines · ${cm.openInTransitLoadCount ?? 0} open in-transit load(s).`,
        severity: 'info',
        path: '/procurement',
        state: { focusTab: 'suppliers' },
      });
    }
  }

  const actionableWorkItems = workItems.filter(
    (item) =>
      workItemShowsOnWorkspaceUnifiedInbox(item, inboxCtx) && workItemNeedsActionForUser(item, userId)
  );
  if (actionableWorkItems.length > 0) {
    const overdueCount = actionableWorkItems.filter((item) => item?.slaState === 'overdue').length;
    items.push({
      id: 'work-items',
      title: 'Workspace registry',
      detail:
        overdueCount > 0
          ? `${actionableWorkItems.length} official item(s) need action · ${overdueCount} overdue.`
          : `${actionableWorkItems.length} official item(s) need action in your workspace.`,
      severity:
        overdueCount > 0 || actionableWorkItems.some((item) => String(item.priority || '').toLowerCase() === 'high')
          ? 'warning'
          : 'info',
      path: '/',
    });
  }

  return items;
}
