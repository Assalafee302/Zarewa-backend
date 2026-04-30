import { workItemIsPersonalForUser, workItemShowsOnWorkspaceUnifiedInbox } from './workItemPersonalInbox.js';

/**
 * Whether this work item still demands action from the current user in the unified inbox.
 * Mirrors UnifiedWorkItemsPanel "needs_action" rules.
 * @param {object} item
 * @param {string} userId
 */
export function workItemNeedsActionForUser(item, userId) {
  const uid = String(userId || '').trim();
  const assigned = String(item?.responsibleUserId || '').trim();
  if (assigned && uid && assigned !== uid) return false;
  const dt = String(item?.documentType || '').trim().toLowerCase();
  const st = String(item?.status || '').trim().toLowerCase();
  if (dt === 'quotation_clearance' || dt === 'production_gate') {
    if (st === 'closed' || st === 'approved' || st === 'completed' || st === 'cancelled' || st === 'rejected') {
      return false;
    }
  }
  return Boolean(item?.requiresApproval || item?.requiresResponse);
}

/**
 * Primary filing tab for the workspace File tray (finished records).
 * @param {object} item
 */
export function fileTrayCategoryLabel(item) {
  const sk = String(item?.sourceKind || '').trim().toLowerCase();
  const dt = String(item?.documentType || '').trim().toLowerCase();
  if (sk === 'office_thread' || String(item?.linkedThreadId || '').trim()) {
    return 'Correspondence & memos';
  }
  if (dt.startsWith('hr_')) return 'HR & people';
  if (
    dt === 'payment_request' ||
    dt === 'refund_request' ||
    dt === 'bank_recon_exceptions' ||
    dt === 'po_transport_payment'
  ) {
    return 'Finance & treasury';
  }
  if (dt === 'material_request' || sk === 'coil_request') return 'Operations & procurement';
  if (
    dt === 'quotation_clearance' ||
    dt === 'production_gate' ||
    dt === 'flagged_transaction' ||
    dt === 'conversion_review'
  ) {
    return 'Sales & management sign-off';
  }
  if (dt === 'edit_approval') return 'Change control';
  return 'Other records';
}

/**
 * Secondary grouping under a category (e.g. document type label).
 * @param {object} item
 */
export function fileTraySubcategoryLabel(item) {
  const dt = String(item?.documentType || '').replace(/_/g, ' ').trim();
  if (!dt) return 'General';
  return dt.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {object[]} items
 * @returns {{ category: string; groups: { subcategory: string; items: object[] }[] }[]}
 */
export function groupFileTrayItemsByCategory(items) {
  const byCat = new Map();
  for (const item of items) {
    const cat = fileTrayCategoryLabel(item);
    const sub = fileTraySubcategoryLabel(item);
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const subMap = byCat.get(cat);
    if (!subMap.has(sub)) subMap.set(sub, []);
    subMap.get(sub).push(item);
  }
  const cats = [...byCat.keys()].sort((a, b) => a.localeCompare(b));
  return cats.map((category) => {
    const subMap = byCat.get(category);
    const subs = [...subMap.keys()].sort((a, b) => a.localeCompare(b));
    return {
      category,
      groups: subs.map((subcategory) => ({ subcategory, items: subMap.get(subcategory) })),
    };
  });
}

/**
 * Filed / closed tray: visible to the user but no longer requiring approval or response.
 * @param {object} item
 */
export function workItemIsFiledTrayItem(item) {
  const st = String(item?.status || '').toLowerCase();
  const archived = String(item?.archivedAtIso || '').trim();
  if (archived) return true;
  if (st === 'closed' || st === 'cancelled' || st === 'completed' || st === 'converted') return true;
  return !item?.requiresApproval && !item?.requiresResponse;
}

/**
 * In-tray: everything the unified inbox would show (visibility), including items awaiting others.
 * @param {object} item
 * @param {{ userId: string; roleKey?: string; permissions?: string[] }} inboxCtx
 */
export function workItemShowsInWorkspaceTray(item, inboxCtx) {
  return workItemShowsOnWorkspaceUnifiedInbox(item, inboxCtx);
}

/**
 * @param {object} item
 * @param {{ userId: string; roleKey?: string; permissions?: string[] }} inboxCtx
 */
export function workItemShowsInFileTray(item, inboxCtx) {
  if (!workItemShowsOnWorkspaceUnifiedInbox(item, inboxCtx)) return false;
  if (!workItemIsFiledTrayItem(item)) return false;
  // Avoid flooding branch managers with unrelated others' filed queue items:
  // show filed role-queue items only when the user is personally on the record.
  const uid = String(inboxCtx?.userId || '').trim();
  const personal = workItemIsPersonalForUser(item, uid);
  const dt = String(item?.documentType || '').trim().toLowerCase();
  const roleRouted =
    dt === 'edit_approval' ||
    dt === 'quotation_clearance' ||
    dt === 'production_gate' ||
    dt === 'flagged_transaction' ||
    dt === 'conversion_review' ||
    dt === 'payment_request' ||
    dt === 'refund_request';
  if (roleRouted && !personal) return false;
  return true;
}

/**
 * Completed records that still need filing metadata (records lens — unfiled queue).
 * @param {object} item
 * @param {{ userId: string; roleKey?: string; permissions?: string[] }} inboxCtx
 */
export function workItemShowsInUnfiledTray(item, inboxCtx) {
  if (!workItemShowsOnWorkspaceUnifiedInbox(item, inboxCtx)) return false;
  if (!workItemIsFiledTrayItem(item)) return false;
  if (!item?.filingIncomplete) return false;
  const uid = String(inboxCtx?.userId || '').trim();
  const personal = workItemIsPersonalForUser(item, uid);
  const dt = String(item?.documentType || '').trim().toLowerCase();
  const roleRouted =
    dt === 'edit_approval' ||
    dt === 'quotation_clearance' ||
    dt === 'production_gate' ||
    dt === 'flagged_transaction' ||
    dt === 'conversion_review' ||
    dt === 'payment_request' ||
    dt === 'refund_request';
  if (roleRouted && !personal) return false;
  return true;
}
