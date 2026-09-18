import { describe, expect, it } from 'vitest';
import { renderCashierStatementPage } from './cashierStatementPage.js';
import { renderExpenseDuplicatesPage } from './expenseDuplicatesPage.js';

describe('cashier statement HTML page', () => {
  it('lets finance pick dates before 12 Sep', () => {
    const html = renderCashierStatementPage({
      user: { displayName: 'Yola Finance' },
      canView: true,
      branches: [{ id: 'BR-YL', name: 'Yola Factory', code: 'YL' }],
      selectedBranchId: 'BR-YL',
      accounts: [{ id: 9, name: 'POS', type: 'Bank' }],
      selectedTreasuryAccountId: 9,
      fromISO: '2026-09-05',
      toISO: '2026-09-18',
      statement: {
        ok: true,
        account: { name: 'POS', type: 'Bank', liveBalanceNgn: 1000 },
        fromISO: '2026-09-05',
        toISO: '2026-09-18',
        openingBalanceNgn: 0,
        closingBalanceNgn: 1000,
        inflowNgn: 2000,
        outflowNgn: 1000,
        lineCount: 1,
        lines: [
          {
            n: 1,
            date: '2026-09-07',
            source: 'Expense',
            description: 'Refund · Ref 9886',
            inNgn: 0,
            outNgn: 216300,
            balanceNgn: -216300,
          },
        ],
      },
    });
    expect(html).toMatch(/name="fromISO"/);
    expect(html).toMatch(/2026-09-05/);
    expect(html).toMatch(/9886/);
    expect(html).not.toMatch(/min="/);
  });
});

describe('expense duplicates HTML page', () => {
  it('lists extras to delete and the keeper to keep', () => {
    const html = renderExpenseDuplicatesPage({
      user: { displayName: 'Yola Finance' },
      canPost: true,
      csrf: 'dup-csrf',
      branches: [{ id: 'BR-YL', name: 'Yola Factory', code: 'YL' }],
      selectedBranchId: 'BR-YL',
      extraCount: 2,
      restoreCashNgn: 14800,
      groups: [
        {
          date: '2026-09-12',
          category: 'Refund',
          reference: '9899',
          amountNgn: 7400,
          keepExpenseID: 'EXP-YL-26-0210',
          extraExpenseIDs: ['EXP-YL-26-0211', 'EXP-YL-26-0212'],
        },
      ],
    });
    expect(html).toMatch(/Keep EXP-YL-26-0210/);
    expect(html).toMatch(/EXP-YL-26-0211/);
    expect(html).toMatch(/Delete selected extras and restore cash/);
  });
});
