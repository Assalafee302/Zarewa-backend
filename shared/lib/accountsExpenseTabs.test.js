import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_TAB_EXPENSES,
  ACCOUNTS_TAB_PAYOUT,
  ACCOUNTS_TAB_REQUESTS,
  canonicalAccountsExpenseTab,
} from './accountsExpenseTabs.js';

describe('accountsExpenseTabs', () => {
  it('maps retired aliases onto the three canonical expense tabs', () => {
    expect(canonicalAccountsExpenseTab('payment-requests')).toBe(ACCOUNTS_TAB_REQUESTS);
    expect(canonicalAccountsExpenseTab('request')).toBe(ACCOUNTS_TAB_REQUESTS);
    expect(canonicalAccountsExpenseTab('treasury')).toBe(ACCOUNTS_TAB_PAYOUT);
    expect(canonicalAccountsExpenseTab('desk')).toBe(ACCOUNTS_TAB_PAYOUT);
    expect(canonicalAccountsExpenseTab('expenses')).toBe(ACCOUNTS_TAB_EXPENSES);
    expect(canonicalAccountsExpenseTab('disbursements')).toBe('disbursements');
  });
});
