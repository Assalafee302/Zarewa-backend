import { DEFAULT_BRANCH_ID } from './branches.js';
import { listBankReconciliation } from './readModel.js';
import {
  FINANCE_WORK_ITEM_DOCUMENT_TYPES,
  FINANCE_WORK_ITEM_SOURCE_KINDS,
} from './financeWorkItemConstants.js';
import { sumTransportPaymentsForPo } from './writeOps.js';
import { findPersistedWorkItemBySource, upsertWorkItemBySource, workRegistryTablesReady } from './workItems.js';

/**
 * Upsert one work item per branch summarising bank lines still in Review or PendingManager.
 * Clears to closed when the queue is empty.
 */
export function syncFinanceBankReconExceptionWorkItem(db, branchId, actor) {
  const bid = String(branchId || '').trim() || DEFAULT_BRANCH_ID;
  const sk = FINANCE_WORK_ITEM_SOURCE_KINDS.BANK_RECON_EXCEPTIONS;
  const sid = bid;
  const pending = listBankReconciliation(db, bid).filter(
    (l) => l.status === 'Review' || l.status === 'PendingManager'
  );

  const uid = String(actor?.id ?? '').trim();
  const disp = String(actor?.displayName ?? actor?.username ?? 'System').trim();
  const rk = String(actor?.roleKey ?? '').trim();
  const officeKey = 'finance';

  const basePayload = {
    actor,
    sourceKind: sk,
    sourceId: sid,
    branchId: bid,
    officeKey,
    responsibleOfficeKey: officeKey,
    documentClass: 'report',
    documentType: FINANCE_WORK_ITEM_DOCUMENT_TYPES.BANK_RECON_EXCEPTIONS,
    senderUserId: uid || null,
    senderDisplayName: disp || null,
    senderRoleKey: rk || null,
    senderOfficeKey: officeKey,
    senderBranchId: bid,
    data: { routePath: '/accounts', routeState: { accountsTab: 'receipts' } },
  };

  if (pending.length === 0) {
    const ex = findPersistedWorkItemBySource(db, sk, sid);
    if (!ex) return { ok: true, noop: true };
    return upsertWorkItemBySource(db, {
      ...basePayload,
      status: 'closed',
      title: 'Bank reconciliation — no pending lines',
      summary: 'All statement lines are matched or excluded.',
      requiresResponse: false,
      requiresApproval: false,
      priority: 'normal',
      closedAtIso: new Date().toISOString(),
    });
  }

  const hasManager = pending.some((l) => l.status === 'PendingManager');
  return upsertWorkItemBySource(db, {
    ...basePayload,
    status: 'open',
    priority: hasManager ? 'high' : 'normal',
    title: `Bank reconciliation — ${pending.length} line(s) need action`,
    summary: `${pending.length} statement line(s) in Review or awaiting manager clearance.`,
    requiresResponse: true,
    requiresApproval: false,
    closedAtIso: null,
  });
}

/**
 * Open or close a Finance work item for PO transport fee payment (visible to cashier / finance).
 */
export function syncFinancePoTransportWorkItem(db, poID, actor) {
  if (!workRegistryTablesReady(db)) return { ok: true, noop: true };
  const row = db.prepare(`SELECT * FROM purchase_orders WHERE po_id = ?`).get(poID);
  if (!row) return { ok: false };
  const total = Number(row.transport_amount_ngn) || 0;
  const paid = sumTransportPaymentsForPo(db, poID);
  const bid = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  const officeKey = 'finance';
  const uid = String(actor?.id ?? '').trim();
  const disp = String(actor?.displayName ?? actor?.username ?? 'System').trim();
  const rk = String(actor?.roleKey ?? '').trim();
  const sk = FINANCE_WORK_ITEM_SOURCE_KINDS.PO_TRANSPORT;
  const sid = poID;

  if (total <= 0 || !String(row.transport_agent_id ?? '').trim()) {
    const ex = findPersistedWorkItemBySource(db, sk, sid);
    if (!ex) return { ok: true, noop: true };
    return upsertWorkItemBySource(db, {
      actor,
      sourceKind: sk,
      sourceId: sid,
      branchId: bid,
      officeKey,
      responsibleOfficeKey: officeKey,
      documentClass: 'request',
      documentType: FINANCE_WORK_ITEM_DOCUMENT_TYPES.PO_TRANSPORT,
      status: 'closed',
      title: `PO ${poID} — transport fee`,
      summary: 'No transport fee or no transporter assigned.',
      requiresResponse: false,
      priority: 'normal',
      closedAtIso: new Date().toISOString(),
    });
  }

  if (paid >= total) {
    return upsertWorkItemBySource(db, {
      actor,
      sourceKind: sk,
      sourceId: sid,
      branchId: bid,
      officeKey,
      responsibleOfficeKey: officeKey,
      documentClass: 'request',
      documentType: FINANCE_WORK_ITEM_DOCUMENT_TYPES.PO_TRANSPORT,
      status: 'closed',
      title: `PO ${poID} — transport fee paid`,
      summary: `Recorded ${paid} of ${total} (transport fee settled).`,
      requiresResponse: false,
      priority: 'normal',
      closedAtIso: new Date().toISOString(),
      senderUserId: uid || null,
      senderDisplayName: disp || null,
      senderRoleKey: rk || null,
      senderOfficeKey: officeKey,
      senderBranchId: bid,
      data: { routePath: '/accounts', routeState: { accountsTab: 'movements' } },
    });
  }

  const outstanding = total - paid;
  return upsertWorkItemBySource(db, {
    actor,
    sourceKind: sk,
    sourceId: sid,
    branchId: bid,
    officeKey,
    responsibleOfficeKey: officeKey,
    documentClass: 'request',
    documentType: FINANCE_WORK_ITEM_DOCUMENT_TYPES.PO_TRANSPORT,
    status: 'open',
    title: `PO ${poID} — transport fee payment`,
    summary: `Outstanding ${outstanding} on transport fee of ${total} (quoted on PO).${paid > 0 ? ` Paid ${paid} so far.` : ''}`,
    requiresResponse: true,
    priority: 'high',
    closedAtIso: null,
    senderUserId: uid || null,
    senderDisplayName: disp || null,
    senderRoleKey: rk || null,
    senderOfficeKey: officeKey,
    senderBranchId: bid,
    data: {
      routePath: '/accounts',
      routeState: { accountsTab: 'movements' },
      poID,
      transportAmountNgn: total,
      transportPaidNgn: paid,
    },
  });
}
