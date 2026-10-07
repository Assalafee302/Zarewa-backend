import { describe, expect, it } from 'vitest';
import { buildManagementPhase1View } from './managementPhase1Report.js';

describe('buildManagementPhase1View', () => {
  it('uses the bank amount, keeps Yusuf, drops a written-off gap, and holds an unpaid refund', () => {
    const view = buildManagementPhase1View({
      periodLocked: true,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      branches: [{ branchId: 'BR-KD', cashNgn: 80_000, refundsNgn: 234_275, revenueNgn: 50_000 }],
      cashRows: [
        { cashNgn: 80_000, amountNgn: 100_000, dateISO: '2026-09-12', bankValueDateISO: '2026-09-12', customerName: 'Ada', quotationRef: 'QT-KD-1', receiptId: 'LE-1', status: 'Cleared' },
      ],
      refundRows: [
        { refundId: 'RF-ARMA', amountNgn: 234_275, dateISO: '2026-09-30', customerName: 'Arma Yau', quotationRef: 'QT-KD-1560' },
      ],
      bankEverLines: [
        { refundId: 'RF-ARMA', amountNgn: 234_275 },
        { refundId: 'RF-AUG', amountNgn: 261_957 },
      ],
      customerDebtors: [
        { customerId: 'CUS-KD-26-1069', customerName: 'YUSUF', owedNgn: 2_034_400, flag: 'refund without confirmed cash' },
        { customerId: 'CUS-KD-26-0001', customerName: 'Rounded', owedNgn: 0 },
      ],
      refundHeaders: [
        { refundId: 'RF-ARMA', customerName: 'Arma Yau', quotationRef: 'QT-KD-1560', status: 'Paid', paidAmountNgn: 861_575, requestedAtISO: '2026-09-29' },
        { refundId: 'RF-OPEN', customerName: 'No bank', quotationRef: 'QT-KD-9', status: 'Approved', amountNgn: 10_000, requestedAtISO: '2026-09-10' },
        { refundId: 'RF-CANCEL', customerName: 'Gone', status: 'Cancelled', amountNgn: 5_000, requestedAtISO: '2026-09-10' },
        { refundId: 'RF-AUG', customerName: 'Murtala Cap', status: 'Paid', paidAmountNgn: 261_957, requestedAtISO: '2026-09-21' },
      ],
      creditApplications: [
        { refundId: 'RF-ARMA', amountNgn: 555_000, status: 'Credit confirmation' },
        { refundId: 'RF-ARMA', amountNgn: 72_300, status: 'Credit confirmation' },
      ],
    });

    expect(view.cashRows[0].bankPaidNgn).toBe(80_000);
    expect(view.cashRows[0].paidDiffers).toBe(true);
    expect(view.debtorRows.map((row) => row.customerName)).toEqual(['YUSUF']);
    expect(view.refundPaidRows.map((row) => row.refundId)).toEqual(['RF-ARMA']);
    expect(view.refundUnpaidRows).toEqual([
      expect.objectContaining({ refundId: 'RF-OPEN', amountNgn: 10_000, status: 'Approved – not paid' }),
    ]);
    expect(view.aligned).toBe(true);
    expect(view.alert).toBe('');
  });

  it('raises a lock banner when the lines do not match the close', () => {
    const view = buildManagementPhase1View({
      periodLocked: true,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      branches: [{ cashNgn: 206_603_845, refundsNgn: 28_512_025, revenueNgn: 175_934_996 }],
      cashRows: [{ cashNgn: 1, amountNgn: 1, dateISO: '2026-09-01' }],
      refundRows: [],
    });
    expect(view.aligned).toBe(false);
    expect(view.alert).toMatch(/locked/i);
    expect(view.alert).toMatch(/206,603,845/);
  });
});