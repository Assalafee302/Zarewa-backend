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

  it('shows a description and the paying bank when a treasury movement is on record', () => {
    const { detail } = expensesPackReport(
      [{ expenseID: 'EX-9', date: '2026-04-05', category: 'Logistics', expenseType: 'Haulage to Kano', amountNgn: 20000 }],
      '2026-04-01',
      '2026-04-30',
      [
        {
          type: 'EXPENSE',
          sourceKind: 'EXPENSE',
          sourceId: 'EX-9',
          accountType: 'Bank',
          accountName: 'Zenith Production',
          bankName: 'Zenith Bank',
          amountNgn: -20000,
          postedAtISO: '2026-04-05',
        },
      ]
    );
    expect(detail).toHaveLength(1);
    expect(detail[0].description).toBe('Haulage to Kano');
    expect(detail[0].bankAccount).toBe('ZENITH');
  });

  it('shows "Cash" for till-paid expenses', () => {
    const { detail, dateBasis } = expensesPackReport(
      [{ expenseID: 'EX-10', date: '2026-04-06', category: 'Sundry', expenseType: 'Fuel', amountNgn: 5000 }],
      '2026-04-01',
      '2026-04-30',
      [
        {
          type: 'EXPENSE',
          sourceKind: 'EXPENSE',
          sourceId: 'EX-10',
          accountType: 'Cash',
          accountName: 'Cash Office (Till)',
          amountNgn: -5000,
          postedAtISO: '2026-04-06',
        },
      ]
    );
    expect(dateBasis).toBe('paid');
    expect(detail[0].bankAccount).toBe('Cash');
  });

  it('uses payment-request payout cash and omits unpaid memos', () => {
    const { detail, summaryByCategory } = expensesPackReport(
      [
        {
          expenseID: 'EX-PR-1',
          date: '2026-04-01',
          category: 'Maintenance',
          expenseType: 'Payment request (pending payout)',
          amountNgn: 80000,
          paymentMethod: 'Pending',
        },
        {
          expenseID: 'EX-UNPAID',
          date: '2026-04-02',
          category: 'Office expenses',
          expenseType: 'Payment request (pending payout)',
          amountNgn: 15000,
          paymentMethod: 'Pending',
        },
      ],
      '2026-04-01',
      '2026-04-30',
      [
        {
          type: 'PAYMENT_REQUEST_OUT',
          sourceKind: 'PAYMENT_REQUEST',
          sourceId: 'PR-1',
          counterpartyId: 'EX-PR-1',
          accountType: 'Bank',
          bankName: 'Zenith Bank',
          amountNgn: -80000,
          postedAtISO: '2026-04-10',
        },
      ]
    );
    expect(detail).toHaveLength(1);
    expect(detail[0].expenseIdFull).toBe('EX-PR-1');
    expect(detail[0].dateISO).toBe('2026-04-10');
    expect(detail[0].amountNgn).toBe(80000);
    expect(detail[0].bankAccount).toBe('ZENITH');
    expect(summaryByCategory.find((s) => s.category === 'Office expenses')).toBeUndefined();
  });

  it('nets a reversed payment-request payout to zero', () => {
    const { detail } = expensesPackReport(
      [{ expenseID: 'EX-REV', date: '2026-04-01', category: 'Fuel', amountNgn: 9000 }],
      '2026-04-01',
      '2026-04-30',
      [
        {
          type: 'PAYMENT_REQUEST_OUT',
          sourceKind: 'PAYMENT_REQUEST',
          counterpartyId: 'EX-REV',
          amountNgn: -9000,
          postedAtISO: '2026-04-08',
          accountType: 'Cash',
        },
        {
          type: 'PAYMENT_REQUEST_REVERSAL_IN',
          sourceKind: 'PAYMENT_REQUEST',
          counterpartyId: 'EX-REV',
          amountNgn: 9000,
          postedAtISO: '2026-04-09',
          accountType: 'Cash',
        },
      ]
    );
    expect(detail).toHaveLength(0);
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
