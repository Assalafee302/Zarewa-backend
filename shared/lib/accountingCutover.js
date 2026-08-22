/**
 * Signed accounting go-live — opening balance journal date (June 2026).
 * Frontend copies via `npm run sync:shared` → src/shared/accountingCutover.js
 */
export const ACCOUNTING_OPENING_DATE_ISO = '2026-06-01';
export const ACCOUNTING_OPENING_DATE_LABEL = '1 June 2026';
export const ACCOUNTING_OPENING_PERIOD_KEY = '2026-06';
export const ACCOUNTING_OPENING_SOURCE_ID = 'OPENING_BALANCE_2026-06';

/** @param {string | null | undefined} dateISO */
export function openingPeriodKeyFromDateISO(dateISO) {
  const d = String(dateISO || ACCOUNTING_OPENING_DATE_ISO).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ACCOUNTING_OPENING_PERIOD_KEY;
  return d.slice(0, 7);
}

/** @param {string | null | undefined} dateISO */
export function openingBalanceSourceIdBaseFromDateISO(dateISO) {
  return `OPENING_BALANCE_${openingPeriodKeyFromDateISO(dateISO)}`;
}

/**
 * GL source_id for an opening balance journal.
 * @param {string | null | undefined} branchScope
 * @param {string | null | undefined} [cutoverDateISO] defaults to global HQ cutover date
 */
export function openingBalanceSourceId(branchScope, cutoverDateISO) {
  const bid = String(branchScope ?? '').trim();
  const base = openingBalanceSourceIdBaseFromDateISO(cutoverDateISO);
  if (!bid || bid === 'ALL') return base;
  return `${base}:${bid}`;
}

/** @param {string | null | undefined} dateISO */
export function openingCutoverDateLabel(dateISO) {
  const d = String(dateISO || ACCOUNTING_OPENING_DATE_ISO).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ACCOUNTING_OPENING_DATE_LABEL;
  const dt = new Date(`${d}T12:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
