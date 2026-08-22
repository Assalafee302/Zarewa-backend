/** Shared bank-deposit pool statuses (unlinked bank payments).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/bankDeposits.js
 */
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

export const BANK_DEPOSIT_RECLASS_OPTIONS = [
  { value: BANK_DEPOSIT_RECLASS_OTHER_INCOME, label: 'Other income' },
  { value: BANK_DEPOSIT_RECLASS_INTER_BRANCH, label: 'Inter-branch transfer' },
  { value: BANK_DEPOSIT_RECLASS_REFUND_OUT, label: 'Refund / return out' },
  { value: BANK_DEPOSIT_RECLASS_EXPENSE_OFFSET, label: 'Expense offset' },
];

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

/** Close-amount band for unlinked deposit suggestions (₦ floor or % of amount). */
export const BANK_DEPOSIT_CLOSE_AMOUNT_FLOOR_NGN = 100;
export const BANK_DEPOSIT_CLOSE_AMOUNT_RATIO = 0.01;
/** Close-date band for unlinked deposit suggestions / merge candidates (calendar days). */
export const BANK_DEPOSIT_CLOSE_DATE_DAYS = 2;

export function bankDepositCloseAmountToleranceNgn(amountNgn) {
  const amt = Math.round(Math.abs(Number(amountNgn) || 0));
  return Math.max(
    BANK_DEPOSIT_CLOSE_AMOUNT_FLOOR_NGN,
    Math.round(amt * BANK_DEPOSIT_CLOSE_AMOUNT_RATIO)
  );
}

export function isBankDepositAmountExact(a, b) {
  return Math.round(Number(a) || 0) === Math.round(Number(b) || 0);
}

/** True when amounts match within the close band (includes exact). */
export function isBankDepositAmountClose(a, b) {
  const left = Math.round(Math.abs(Number(a) || 0));
  const right = Math.round(Math.abs(Number(b) || 0));
  if (left <= 0 && right <= 0) return false;
  const tol = bankDepositCloseAmountToleranceNgn(Math.max(left, right));
  return Math.abs(left - right) <= tol;
}

export function bankDepositDateDiffDays(isoA, isoB) {
  const a = String(isoA || '').slice(0, 10);
  const b = String(isoB || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const ms = Date.parse(`${a}T12:00:00.000Z`) - Date.parse(`${b}T12:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(Math.abs(ms) / 86_400_000);
}

export function isBankDepositDateExact(isoA, isoB) {
  const a = String(isoA || '').slice(0, 10);
  const b = String(isoB || '').slice(0, 10);
  return Boolean(a) && a === b;
}

/** True when dates match within N calendar days (includes exact). */
export function isBankDepositDateClose(isoA, isoB, days = BANK_DEPOSIT_CLOSE_DATE_DAYS) {
  const diff = bankDepositDateDiffDays(isoA, isoB);
  if (diff == null) return false;
  return diff <= Math.max(0, Number(days) || 0);
}

/**
 * Score an open bank deposit against a receipt/advance candidate.
 * @returns {{
 *   score: number;
 *   amountExact: boolean;
 *   amountClose: boolean;
 *   dateExact: boolean;
 *   dateClose: boolean;
 *   refExact: boolean;
 *   refPartial: boolean;
 *   dateDiffDays: number | null;
 *   matchHints: string[];
 *   canMergeDuplicate: boolean;
 * }}
 */
export function scoreBankDepositMatch(deposit, { amountNgn, bankDateISO, bankReference } = {}) {
  const depAmt = Math.round(Number(deposit?.amountNgn ?? deposit?.amount_ngn) || 0);
  const tgtAmt = Math.round(Math.abs(Number(amountNgn) || 0));
  const depDate = String(deposit?.bankDateISO ?? deposit?.bank_date_iso ?? '').slice(0, 10);
  const tgtDate = String(bankDateISO || '').slice(0, 10);
  const depRef = String(deposit?.bankReference ?? deposit?.bank_reference ?? '')
    .trim()
    .toLowerCase();
  const tgtRef = String(bankReference || '')
    .trim()
    .toLowerCase();

  const amountExact = tgtAmt > 0 && isBankDepositAmountExact(depAmt, tgtAmt);
  const amountClose = tgtAmt > 0 && isBankDepositAmountClose(depAmt, tgtAmt);
  const dateExact = Boolean(tgtDate) && isBankDepositDateExact(depDate, tgtDate);
  const dateClose = Boolean(tgtDate) && isBankDepositDateClose(depDate, tgtDate);
  const dateDiffDays = tgtDate ? bankDepositDateDiffDays(depDate, tgtDate) : null;
  const refExact = Boolean(tgtRef) && Boolean(depRef) && depRef === tgtRef;
  const refPartial =
    Boolean(tgtRef) &&
    Boolean(depRef) &&
    !refExact &&
    (depRef.includes(tgtRef) || tgtRef.includes(depRef));

  let score = 0;
  if (refExact) score += 100;
  else if (refPartial) score += 30;
  if (amountExact) score += 40;
  else if (amountClose) score += 10;
  if (dateExact) score += 20;
  else if (dateClose) score += 8;

  const matchHints = [];
  if (refExact) matchHints.push('exact reference');
  else if (refPartial) matchHints.push('similar reference');
  if (amountExact) matchHints.push('exact amount');
  else if (amountClose) matchHints.push('close amount');
  if (dateExact) matchHints.push('exact date');
  else if (dateClose) matchHints.push('close date');

  // Merge is safe only when treasury cash legs are the same amount; close dates are OK.
  const canMergeDuplicate = amountExact && (dateExact || dateClose);

  return {
    score,
    amountExact,
    amountClose,
    dateExact,
    dateClose,
    refExact,
    refPartial,
    dateDiffDays,
    matchHints,
    canMergeDuplicate,
  };
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
  const hit = BANK_DEPOSIT_RECLASS_OPTIONS.find((o) => o.value === k);
  return hit?.label || k || '—';
}

/** Open / partial unlinked deposits from workspace snapshot. */
export function openBankDepositsFromSnapshot(snapshot) {
  const rows = Array.isArray(snapshot?.bankDeposits) ? snapshot.bankDeposits : [];
  return rows.filter((d) => {
    const remaining = bankDepositRemainingNgn(d);
    const st = String(d?.status || '').toUpperCase();
    return remaining > 0 && BANK_DEPOSIT_LINKABLE_STATUSES.has(st);
  });
}
