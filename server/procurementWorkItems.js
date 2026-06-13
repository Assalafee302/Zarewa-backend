import { DEFAULT_BRANCH_ID } from './branches.js';
import { coilReceiptShortToleranceKg } from '../shared/lib/poLineTypes.js';
import { upsertWorkItemBySource, workRegistryTablesReady } from './workItems.js';

export const PROCUREMENT_WORK_ITEM_SOURCE_KINDS = {
  COIL_GRN_SHORT: 'coil_grn_short_receipt',
};

export const PROCUREMENT_WORK_ITEM_DOCUMENT_TYPES = {
  COIL_GRN_SHORT: 'coil_grn_short_receipt',
};

/**
 * Notify MD (workspace registry) when store receipt landed below PO ordered kg.
 * @param {import('better-sqlite3').Database} db
 */
export function notifyMdCoilShortReceipt(
  db,
  { poID, lineKey, productName, coilNo, orderedKg, receivedKg, shortKg, actor, branchId }
) {
  if (!workRegistryTablesReady(db)) return { ok: true, noop: true };
  const po = String(poID || '').trim();
  const lk = String(lineKey || '').trim();
  const cn = String(coilNo || '').trim();
  const ordered = Number(orderedKg) || 0;
  const received = Number(receivedKg) || 0;
  const short = Number(shortKg) || Math.max(0, ordered - received);
  if (!po || !lk || short <= 0) return { ok: true, noop: true };

  const bid = String(branchId || '').trim() || DEFAULT_BRANCH_ID;
  const uid = String(actor?.id ?? '').trim();
  const disp = String(actor?.displayName ?? actor?.username ?? 'Store receipt').trim();
  const rk = String(actor?.roleKey ?? '').trim();
  const withinTol = short <= coilReceiptShortToleranceKg(ordered);
  const sid = `${po}:${lk}:${cn || 'coil'}`;

  return upsertWorkItemBySource(db, {
    actor,
    sourceKind: PROCUREMENT_WORK_ITEM_SOURCE_KINDS.COIL_GRN_SHORT,
    sourceId: sid,
    branchId: bid,
    officeKey: 'procurement',
    responsibleOfficeKey: 'procurement',
    documentClass: 'report',
    documentType: PROCUREMENT_WORK_ITEM_DOCUMENT_TYPES.COIL_GRN_SHORT,
    status: 'open',
    priority: withinTol ? 'normal' : 'high',
    title: `Coil received under PO — ${po}`,
    summary: `${String(productName || 'Line').trim()}: ${received.toLocaleString('en-NG')} received vs ${ordered.toLocaleString('en-NG')} ordered (${short.toLocaleString('en-NG')} short)${cn ? ` · ${cn}` : ''}. PO line closed — no further store receipt on this line.`,
    body: withinTol
      ? 'Short receipt accepted and line closed. Review supplier / weighbridge variance if needed.'
      : 'Short receipt exceeds typical weighbridge tolerance — line closed. Review supplier credit or delivery follow-up.',
    requiresResponse: true,
    requiresApproval: false,
    senderUserId: uid || null,
    senderDisplayName: disp || null,
    senderRoleKey: rk || null,
    senderOfficeKey: 'operations',
    senderBranchId: bid,
    visibilityEntries: [
      { visibilityKind: 'role_key', visibilityValue: 'md' },
      { visibilityKind: 'role_key', visibilityValue: 'admin' },
      { visibilityKind: 'role_key', visibilityValue: 'ceo' },
      { visibilityKind: 'office_key', visibilityValue: 'procurement' },
    ],
    data: {
      routePath: '/operations',
      routeState: { focusOpsTab: 'inventory' },
      poID: po,
      lineKey: lk,
      coilNo: cn || null,
      orderedKg: ordered,
      receivedKg: received,
      shortKg: short,
      withinTolerance: withinTol,
    },
    links: [
      { entityKind: 'purchase_order', entityId: po },
      ...(cn ? [{ entityKind: 'coil_lot', entityId: cn }] : []),
    ],
  });
}
