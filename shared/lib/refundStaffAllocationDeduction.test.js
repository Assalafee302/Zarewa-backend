import { describe, it, expect } from 'vitest';
import {
  REFUND_STAFF_ALLOCATION_DEDUCTION_RATE,
  applyRefundStaffAllocationDeduction,
  applyRefundStaffAllocationDeductions,
  normalizeRefundStaffAllocationDeductionRate,
  refundSplitTakesStaffDeduction,
  refundStaffAllocationDeductionAmounts,
  sumRefundStaffCompanyDeductionNgn,
  sumRefundStaffNetPayoutNgn,
  sumRefundStaffUnclearedOffsetNgn,
} from './refundStaffAllocationDeduction.js';

describe('refundStaffAllocationDeduction', () => {
  it('uses 20% company cut by default', () => {
    expect(REFUND_STAFF_ALLOCATION_DEDUCTION_RATE).toBe(0.2);
    expect(refundStaffAllocationDeductionAmounts(19525)).toEqual({
      grossNgn: 19525,
      deductionRate: 0.2,
      companyDeductionNgn: 3905,
      netPayoutNgn: 15620,
    });
  });

  it('accepts Admin/MD percent overrides', () => {
    expect(normalizeRefundStaffAllocationDeductionRate(10)).toBe(0.1);
    expect(normalizeRefundStaffAllocationDeductionRate(0)).toBe(0);
    expect(refundStaffAllocationDeductionAmounts(10_000, 0.1).companyDeductionNgn).toBe(1000);
  });

  it('does not deduct when paying the quote customer', () => {
    expect(
      refundSplitTakesStaffDeduction(
        { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 10_000 },
        'CUS-1'
      )
    ).toBe(false);
    const row = applyRefundStaffAllocationDeduction(
      { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 10_000 },
      'CUS-1'
    );
    expect(row.companyDeductionNgn).toBe(0);
    expect(row.netPayoutNgn).toBe(10_000);
  });

  it('offsets uncleared receipts from net after company cut', () => {
    const row = applyRefundStaffAllocationDeduction(
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-CLAIM',
        amountNgn: 20_000,
      },
      'CUS-QUOTE',
      { deductionRate: 0.2, unclearedReceiptHoldNgn: 5_000 }
    );
    expect(row.grossNgn).toBe(20_000);
    expect(row.companyDeductionNgn).toBe(4_000);
    expect(row.unclearedReceiptOffsetNgn).toBe(5_000);
    expect(row.netPayoutNgn).toBe(11_000);
    expect(row.payoutHeldForUnclearedReceipts).toBe(false);
  });

  it('holds payout when uncleared float covers remaining net', () => {
    const row = applyRefundStaffAllocationDeduction(
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-CLAIM',
        amountNgn: 10_000,
      },
      'CUS-QUOTE',
      { deductionRate: 0.2, unclearedReceiptHoldNgn: 50_000 }
    );
    expect(row.netPayoutNgn).toBe(0);
    expect(row.unclearedReceiptOffsetNgn).toBe(8_000);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('allows Admin/MD to waive company cut while still offsetting uncleared receipts', () => {
    const row = applyRefundStaffAllocationDeduction(
      {
        recipientKind: 'associated_staff',
        recipientAssociatedStaffID: 'AS-1',
        amountNgn: 10_000,
        companyCutWaived: true,
        companyCutWaiverNote: 'MD waived transporter cut',
      },
      'CUS-QUOTE',
      { deductionRate: 0.2, unclearedReceiptHoldNgn: 1_500 }
    );
    expect(row.companyCutWaived).toBe(true);
    expect(row.companyDeductionNgn).toBe(0);
    expect(row.deductionRate).toBe(0);
    expect(row.unclearedReceiptOffsetNgn).toBe(1_500);
    expect(row.netPayoutNgn).toBe(8_500);
  });

  it('deducts for associated staff and claiming staff', () => {
    const rows = applyRefundStaffAllocationDeductions(
      [
        {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: 'AS-1',
          amountNgn: 5_000,
        },
        {
          recipientKind: 'customer',
          recipientCustomerID: 'CUS-CLAIM',
          amountNgn: 15_000,
          note: 'Claiming staff',
        },
      ],
      'CUS-QUOTE',
      {
        deductionRate: 0.2,
        unclearedByCustomerId: { 'CUS-CLAIM': 2_000 },
      }
    );
    expect(sumRefundStaffCompanyDeductionNgn(rows)).toBe(1000 + 3000);
    expect(sumRefundStaffUnclearedOffsetNgn(rows)).toBe(2_000);
    expect(sumRefundStaffNetPayoutNgn(rows)).toBe(4000 + 10_000);
  });
});
