/** Shared bank-deposit pool statuses (unlinked bank payments). */
export const BANK_DEPOSIT_STATUS_OPEN = 'OPEN';
export const BANK_DEPOSIT_STATUS_RESERVED = 'RESERVED';
export const BANK_DEPOSIT_STATUS_PARTIAL = 'PARTIAL';
export const BANK_DEPOSIT_STATUS_ALLOCATED = 'ALLOCATED';
export const BANK_DEPOSIT_STATUS_REVERSED = 'REVERSED';
export const BANK_DEPOSIT_STATUS_RECLASSED = 'RECLASSED';

export const BANK_DEPOSIT_ALLOC_KIND_RECEIPT = 'receipt';
export const BANK_DEPOSIT_ALLOC_KIND_ADVANCE = 'advance';

export const BANK_DEPOSIT_TREASURY_TYPE = 'BANK_UNIDENTIFIED_IN';
export const BANK_DEPOSIT_TREASURY_REVERSAL_TYPE = 'BANK_UNIDENTIFIED_OUT';
export const BANK_DEPOSIT_TREASURY_SOURCE_KIND = 'BANK_DEPOSIT';

/** GL suspense for unallocated bank receipts (account code 2150). */
export const BANK_DEPOSIT_GL_SUSPENSE_CODE = '2150';

/** Reclassify an unlinked deposit that is not a customer payment. */
export const BANK_DEPOSIT_RECLASS_OTHER_INCOME = 'OTHER_INCOME';
export const BANK_DEPOSIT_RECLASS_INTER_BRANCH = 'INTER_BRANCH';
export const BANK_DEPOSIT_RECLASS_REFUND_OUT = 'REFUND_OUT';
export const BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET = 'EXPENSE_OFFSET';

export const BANK_DEPOSIT_RECLASS_KINDS = new Set([
  BANK_DEPOSIT_RECLASS_OTHER_INCOME,
  BANK_DEPOSIT_RECLASS_INTER_BRANCH,
  BANK_DEPOSIT_RECLASS_REFUND_OUT,
  BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET,
]);

/** Reservation TTL when Sales opens a deposit for linking (ms). */
export const BANK_DEPOSIT_RESERVE_MS = 15 * 60 * 1000;

export const BANK_DEPOSIT_LINKABLE_STATUSES = new Set([
  BANK_DEPOSIT_STATUS_OPEN,
  BANK_DEPOSIT_STATUS_PARTIAL,
  BANK_DEPOSIT_STATUS_RESERVED,
]);

export function bankDepositRemainingNgn(row) {
  const total = Math.round(Number(row?.amountNgn ?? row?.amount_ngn) || 0);
  const allocated = Math.round(Number(row?.allocatedNgn ?? row?.allocated_ngn) || 0);
  return Math.max(0, total - allocated);
}

export function bankDepositStatusLabel(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === BANK_DEPOSIT_STATUS_OPEN) return 'Unlinked';
  if (s === BANK_DEPOSIT_STATUS_RESERVED) return 'In use';
  if (s === BANK_DEPOSIT_STATUS_PARTIAL) return 'Part linked';
  if (s === BANK_DEPOSIT_STATUS_ALLOCATED) return 'Linked';
  if (s === BANK_DEPOSIT_STATUS_REVERSED) return 'Reversed';
  if (s === BANK_DEPOSIT_STATUS_RECLASSED) return 'Reclassified';
  return s || '—';
}

export function bankDepositReclassKindLabel(kind) {
  const k = String(kind || '').trim().toUpperCase();
  if (k === BANK_DEPOSIT_RECLASS_OTHER_INCOME) return 'Other income';
  if (k === BANK_DEPOSIT_RECLASS_INTER_BRANCH) return 'Inter-branch transfer';
  if (k === BANK_DEPOSIT_RECLASS_REFUND_OUT) return 'Refund / return out';
  if (k === BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET) return 'Expense offset';
  return k || '—';
}
