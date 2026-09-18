import { describe, expect, it } from 'vitest';
import { renderExpenseCashCatchupPage } from './expenseCashCatchupPage.js';

describe('expense cash catch-up HTML page', () => {
  it('asks unsigned visitors to sign in', () => {
    const html = renderExpenseCashCatchupPage({ user: null });
    expect(html).toMatch(/Sign in to Zarewa as Finance or Administrator/);
    expect(html).not.toMatch(/Post to statement and reduce balance/);
  });

  it('lists unposted expenses and the till picker for finance', () => {
    const html = renderExpenseCashCatchupPage({
      user: { displayName: 'Yola Finance', roleKey: 'admin' },
      canPost: true,
      csrf: 'token-cash-1',
      branches: [{ id: 'BR-YL', name: 'Yola Factory', code: 'YL' }],
      selectedBranchId: 'BR-YL',
      category: 'Refund',
      accounts: [{ id: 12, name: 'Yola Till', type: 'Cash', balance: 2_500_000 }],
      selectedTreasuryAccountId: 12,
      rows: [
        {
          expenseID: 'EXP-1',
          date: '2026-09-03',
          category: 'Refund',
          amountNgn: 45000,
          reference: 'RFD-SEP-03',
          missingTreasury: true,
        },
      ],
    });
    expect(html).toMatch(/Post to statement and reduce balance/);
    expect(html).toMatch(/Yola Till/);
    expect(html).toMatch(/RFD-SEP-03/);
    expect(html).toMatch(/value="token-cash-1"/);
    expect(html).toMatch(/45,000/);
  });
});
