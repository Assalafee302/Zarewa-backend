import { describe, expect, it } from 'vitest';
import { salesPeriodCashBridgeExportRows } from './liveAnalytics.js';

describe('salesPeriodCashBridgeExportRows refund cash', () => {
  it('uses treasury history and subtracts a reversal', () => {
    const rows = salesPeriodCashBridgeExportRows([], [], [], [
      {
        refundID: 'RF-1',
        customer: 'Ada',
        quotationRef: 'QT-1',
        status: 'Paid',
        paidAmountNgn: 80_000,
        paidAtISO: '2026-09-10',
        payoutHistory: [
          { id: 'TM-1', postedAtISO: '2026-09-04', amountNgn: 50_000, movementType: 'REFUND_PAYOUT' },
          { id: 'TM-2', postedAtISO: '2026-09-05', amountNgn: -20_000, movementType: 'REFUND_PAYOUT_REVERSAL_IN' },
        ],
      },
    ], '2026-09-01', '2026-09-30');
    const payouts = rows.filter((r) => r.reportSection === 'Refund payouts (period)');
    expect(payouts.map((r) => r.amountNgn)).toEqual([50_000, -20_000]);
    expect(payouts.some((r) => r.category === 'Refund cash paid (single paid date)')).toBe(false);
  });

  it('keeps a partially paid refund in the open balance', () => {
    const rows = salesPeriodCashBridgeExportRows([], [], [], [
      {
        refundID: 'RF-PART',
        customer: 'Ada',
        quotationRef: 'QT-1',
        status: 'Partially paid',
        amountNgn: 100_000,
        approvedAmountNgn: 100_000,
        paidAmountNgn: 40_000,
        payoutHistory: [],
      },
    ], '2026-09-01', '2026-09-30');
    const open = rows.find((r) => r.recordId === 'RF-PART');
    expect(open?.reportSection).toBe('Refunds awaiting payout');
    expect(open?.amountNgn).toBe(60_000);
  });
});
