import { describe, expect, it } from 'vitest';
import { renderExpensePayoutCorrectionPage } from './expensePayoutCorrectionPage.js';

describe('expense payout correction page', () => {
  it('shows both corrections for a finance user', () => {
    const html = renderExpensePayoutCorrectionPage({
      user: { displayName: 'Amina', permissions: ['finance.pay', 'finance.reverse'] },
      canMove: true,
      canRelease: true,
      branches: [{ id: 'BR-YL', name: 'Yola' }],
      accounts: [
        { id: 1, name: 'TAJ', type: 'Bank', balance: 500000 },
        { id: 2, name: 'Moniepoint', type: 'Bank', balance: 1000 },
      ],
      selectedBranchId: 'BR-YL',
      fromTreasuryAccountId: '1',
      toTreasuryAccountId: '2',
      csrf: 'tok',
      payouts: [
        {
          movementId: 'TM-1',
          expenseDate: '2026-09-02',
          expenseId: 'EXP-1',
          category: 'Fuel & lubricant',
          reference: 'PAID-MONIE',
          amountNgn: 80000,
        },
      ],
      refunds: [
        {
          expenseId: 'EXP-R',
          expenseDate: '2026-09-03',
          reference: 'DIRECT-REFUND',
          accountName: 'TAJ',
          amountNgn: 12000,
        },
      ],
    });
    expect(html).toContain('Move payouts to the account that paid');
    expect(html).toContain('Expense refunds to raise again as a normal refund');
    expect(html).toContain('Moniepoint');
    expect(html).toContain('EXP-R');
    expect(html).toContain('Move selected payouts');
  });
});
