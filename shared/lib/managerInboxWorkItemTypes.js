/**
 * Document types that belong to the Manager Dashboard clearance & related queues.
 * Shown on the workspace unified list only when `userMaySeeManagementApprovalQueues` is true (see workItemPersonalInbox.js).
 */
export const MANAGER_INBOX_DOCUMENT_TYPES = new Set([
  'quotation_clearance',
  'production_gate',
  'flagged_transaction',
  'conversion_review',
]);

export function isManagerInboxWorkItemDocType(documentType) {
  return MANAGER_INBOX_DOCUMENT_TYPES.has(String(documentType || '').trim().toLowerCase());
}
