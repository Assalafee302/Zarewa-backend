import { describe, expect, it } from 'vitest';
import { buildSalesMonthEndPack, resolveSalesMonthEndPeriod, salesMonthEndPackToCsv } from './salesMonthEndPack.js';

const PERIOD = { startDate: '2026-09-01', endDate: '2026-09-30', month: '2026-09' };

function pack(extra) {
  return buildSalesMonthEndPack({ ...PERIOD, branchScope: 'BR-KD', asOfISO: '2026-09-29T12:00:00.000Z', ...extra });
}

describe('resolveSalesMonthEndPeriod', () => {
  it('expands a calendar month', () => {
    expect(resolveSalesMonthEndPeriod({ month: '2026-09' })).toMatchObject({
      ok: true,
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  it('rejects a missing range', () => {
    expect(resolveSalesMonthEndPeriod({}).ok).toBe(false);
  });
});

describe('buildSalesMonthEndPack', () => {
  it('keeps overpayment refunds out of net sales and shows credit separately from cash', () => {
    const result = pack({
      quotations: [
        { id: 'QT-PROD', customer: 'Ada', totalNgn: 1_000_000, paidNgn: 1_000_000, status: 'Pending' },
        { id: 'QT-OVER', customer: 'Bola', totalNgn: 400_000, paidNgn: 1_000_000, status: 'Pending' },
      ],
      productionJobs: [
        {
          jobID: 'JOB-1',
          quotationRef: 'QT-PROD',
          status: 'Completed',
          actualMeters: 10,
          completedAtISO: '2026-09-12',
        },
      ],
      refunds: [
        {
          refundId: 'RF-OVER',
          customer: 'Bola',
          quotationRef: 'QT-OVER',
          status: 'Paid',
          amountNgn: 600_000,
          approvedAmountNgn: 600_000,
          paidAmountNgn: 600_000,
          creditAppliedNgn: 200_000,
          salesTreatment: 'customer_money',
        },
        {
          refundId: 'RF-CUT',
          customer: 'Ada',
          quotationRef: 'QT-PROD',
          status: 'Paid',
          amountNgn: 50_000,
          approvedAmountNgn: 50_000,
          paidAmountNgn: 50_000,
          creditAppliedNgn: 0,
          salesTreatment: 'concession',
        },
      ],
      creditApplications: [
        {
          applicationId: 'RCA-1',
          refundId: 'RF-OVER',
          createdAtISO: '2026-09-21T12:00:00.000Z',
          amountNgn: 200_000,
          sourceQuotationRef: 'QT-OVER',
          targetQuotationRef: 'QT-NEXT',
          sourceReceiptId: 'LE-ZERO',
          status: 'Credit confirmation',
        },
      ],
      receipts: [
        { id: 'LE-ZERO', dateISO: '2026-09-21', amountNgn: 0, customer: 'Bola', quotationRef: 'QT-NEXT', status: 'Cleared', linkedTreasuryNgn: 0 },
        { id: 'LE-CASH', dateISO: '2026-09-10', amountNgn: 1_000_000, customer: 'Ada', quotationRef: 'QT-PROD', status: 'Cleared', linkedTreasuryNgn: 1_000_000 },
      ],
      treasuryMovements: [
        { id: 'TM-IN', postedAtISO: '2026-09-10', type: 'RECEIPT_IN', amountNgn: 1_000_000, accountName: 'Zarewa', sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-CASH' },
        { id: 'TM-OUT', postedAtISO: '2026-09-22', type: 'REFUND_PAYOUT', amountNgn: -400_000, accountName: 'Zarewa', sourceKind: 'REFUND', sourceId: 'RF-OVER', counterpartyName: 'Bola' },
        { id: 'TM-CUT', postedAtISO: '2026-09-22', type: 'REFUND_PAYOUT', amountNgn: -50_000, accountName: 'Zarewa', sourceKind: 'REFUND', sourceId: 'RF-CUT', counterpartyName: 'Ada' },
        { id: 'TM-REV', postedAtISO: '2026-09-23', type: 'REFUND_PAYOUT_REVERSAL_IN', amountNgn: 10_000, accountName: 'Zarewa', sourceKind: 'REFUND', sourceId: 'RF-CUT' },
      ],
    });

    expect(result.cover.revenueNgn).toBe(1_000_000);
    expect(result.cover.concessionRefundsNgn).toBe(40_000);
    expect(result.cover.netSalesNgn).toBe(960_000);
    expect(result.cover.cashRefundsNgn).toBe(440_000);
    expect(result.cover.creditAppliedNgn).toBe(200_000);
    expect(result.cover.creditBySourceNgn).toBe(200_000);
    expect(result.cover.receiptsDatedInMonthNgn).toBe(1_000_000);
    const zero = result.receiptLines.find((r) => r.receiptId === 'LE-ZERO');
    expect(zero.fundSource).toBe('Refund credit');
    expect(zero.creditNgn).toBe(200_000);
    expect(result.cover.bankInNgn).toBe(1_010_000);
    expect(result.cover.bankOutNgn).toBe(450_000);
    expect(result.customersWeOweLines.find((r) => r.recordId === 'QT-OVER')).toBeUndefined();
  });

  it('holds unpaid overpayment and a partially paid refund, and skips an unproduced expired quote', () => {
    const result = pack({
      quotations: [
        { id: 'QT-HELD', customer: 'Sani', totalNgn: 2_000_000, paidNgn: 2_500_000, status: 'Pending' },
        { id: 'QT-DEAD', customer: 'Old', totalNgn: 9_000_000, paidNgn: 0, status: 'Expired' },
        { id: 'QT-DUE', customer: 'Nura', totalNgn: 80_000, paidNgn: 20_000, status: 'Pending' },
      ],
      productionJobs: [
        { jobID: 'JOB-DUE', quotationRef: 'QT-DUE', status: 'Completed', actualMeters: 4, completedAtISO: '2026-08-01' },
      ],
      refunds: [
        {
          refundId: 'RF-PART',
          customer: 'Sani',
          quotationRef: 'QT-OTHER',
          status: 'Partially paid',
          amountNgn: 100_000,
          approvedAmountNgn: 100_000,
          paidAmountNgn: 40_000,
          creditAppliedNgn: 0,
          salesTreatment: 'customer_money',
        },
      ],
    });
    expect(result.cover.unrefundedOverpayNgn).toBe(500_000);
    expect(result.cover.openRefundsNgn).toBe(60_000);
    expect(result.cover.customersWeOweNgn).toBe(560_000);
    expect(result.debtorLines.map((r) => r.quotationRef)).toEqual(['QT-DUE']);
    expect(result.cover.customersWhoOweUsNgn).toBe(60_000);
  });

  it('lists standing data problems', () => {
    const result = pack({
      refunds: [
        {
          refundId: 'RF-9546',
          customer: 'Ada',
          quotationRef: 'QT-1',
          status: 'Paid',
          amountNgn: 79_600,
          approvedAmountNgn: 16_926,
          paidAmountNgn: 79_600,
          creditAppliedNgn: 62_674,
          salesTreatment: 'customer_money',
        },
        {
          refundId: 'RF-REJ',
          customer: 'Ada',
          quotationRef: 'QT-2',
          status: 'Rejected',
          amountNgn: 25_875,
          approvedAmountNgn: 0,
          paidAmountNgn: 25_875,
          creditAppliedNgn: 25_875,
          salesTreatment: 'customer_money',
        },
      ],
      creditApplications: [
        {
          applicationId: 'RCA-X',
          refundId: 'RF-9546',
          createdAtISO: '2026-08-28T12:00:00.000Z',
          amountNgn: 62_674,
          status: 'Credit confirmation',
        },
      ],
      malformedTreasury: [{ id: 'TM-BAD', postedAtISO: '262026-09-T12:00:00.000Z', type: 'PAYMENT_REQUEST_OUT', amountNgn: -36_000 }],
      unmatchedReceiptIns: [{ id: 'TM-ORPHAN', postedAtISO: '2026-09-12', sourceId: 'LE-MISSING', amountNgn: 7_520 }],
    });
    const codes = result.exceptions.map((e) => e.code);
    expect(codes).toContain('paid_above_approved');
    expect(codes).toContain('rejected_refund_still_settled');
    expect(codes).toContain('malformed_treasury_date');
    expect(codes).toContain('unmatched_receipt_in');
    expect(salesMonthEndPackToCsv(result)).toContain('malformed_treasury_date');
  });

  it('keeps company cut out of money owed to customers', () => {
    const result = pack({
      companyCutOpenNgn: 80_000,
      walletOpenNgn: 15_000,
      quotations: [{ id: 'QT-HELD', customer: 'Sani', totalNgn: 100_000, paidNgn: 140_000, status: 'Pending' }],
    });
    expect(result.cover.companyCutOpenNgn).toBe(80_000);
    expect(result.cover.customersWeOweNgn).toBe(55_000);
    expect(result.customersWeOweLines.some((r) => r.block === 'company_cut_open')).toBe(true);
  });
});
