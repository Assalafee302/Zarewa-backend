import { describe, expect, it } from 'vitest';
import { expensesPackReport, refundsPackReport } from './standardReportsFinance.js';

describe('expensesPackReport', () => {
  it('filters and summarizes', () => {
    const { detail, summaryByCategory } = expensesPackReport(
      [
        { expenseID: 'EX-1', date: '2026-04-01', category: 'Fuel', expenseType: 'Diesel', amountNgn: 100 },
        { expenseID: 'EX-2', date: '2026-04-15', category: 'Fuel', expenseType: 'Petrol', amountNgn: 50 },
        { expenseID: 'EX-3', date: '2025-01-01', category: 'X', expenseType: 'Y', amountNgn: 999 },
      ],
      '2026-04-01',
      '2026-04-30'
    );
    expect(detail).toHaveLength(2);
    expect(summaryByCategory.find((s) => s.category === 'Fuel')?.totalNgn).toBe(150);
  });
});

describe('refundsPackReport', () => {
  it('collects payout lines in period', () => {
    const { paidInPeriod } = refundsPackReport(
      [
        {
          refundID: 'RF-1',
          customer: 'A',
          quotationRef: 'QT-1',
          status: 'Paid',
          amountNgn: 500,
          paidAmountNgn: 500,
          payoutHistory: [
            { postedAtISO: '2026-05-02T10:00:00.000Z', amountNgn: 500, accountName: 'Bank', reference: 'R1' },
          ],
        },
      ],
      '2026-05-01',
      '2026-05-31'
    );
    expect(paidInPeriod).toHaveLength(1);
    expect(paidInPeriod[0].amountNgn).toBe(500);
  });
});
