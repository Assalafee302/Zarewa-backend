/**
 * Canonical Accounts tabs for expense payment requests.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/accountsExpenseTabs.js
 *
 * Inbox, search, help, and work-item deep links must use these ids.
 * `payment-requests` was a search-only alias for the approval queue.
 * `treasury` is retired on the finance desk (merged into `desk`).
 */
export const ACCOUNTS_TAB_REQUESTS = 'requests';
export const ACCOUNTS_TAB_PAYOUT = 'desk';
export const ACCOUNTS_TAB_EXPENSES = 'expenses';

/**
 * @param {string | null | undefined} tab
 */
export function canonicalAccountsExpenseTab(tab) {
  const t = String(tab || '')
    .trim()
    .toLowerCase();
  if (t === 'payment-requests' || t === 'request') return ACCOUNTS_TAB_REQUESTS;
  if (t === 'treasury') return ACCOUNTS_TAB_PAYOUT;
  return t;
}
