import { describe, it, expect } from 'vitest';
import {
  REFUND_STAFF_ALLOCATION_DEDUCTION_RATE,
  applyRefundStaffAllocationDeduction,
  applyRefundStaffAllocationDeductions,
  refundSplitTakesStaffDeduction,
  refundStaffAllocationDeductionAmounts,
  sumRefundStaffCompanyDeductionNgn,
  sumRefundStaffNetPayoutNgn,
} from './refundStaffAllocationDeduction.js';

describe('refundStaffAllocationDeduction', () => {
  it('uses 20% company cut', () => {
    expect(REFUND_STAFF_ALLOCATION_DEDUCTION_RATE).toBe(0.2);
    expect(refundStaffAllocationDeductionAmounts(19525)).toEqual({
      grossNgn: 19525,
      deductionRate: 0.2,
      companyDeductionNgn: 3905,
      netPayoutNgn: 15620,
    });
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

  it('deducts for associated staff and claiming staff', () => {
    expect(
      refundSplitTakesStaffDeduction({
        recipientKind: 'associated_staff',
        recipientAssociatedStaffID: 'AS-1',
        amountNgn: 5_000,
      })
    ).toBe(true);
    expect(
      refundSplitTakesStaffDeduction(
        { recipientKind: 'customer', recipientCustomerID: 'CUS-STAFF', amountNgn: 5_000 },
        'CUS-QUOTE'
      )
    ).toBe(true);
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
      'CUS-QUOTE'
    );
    expect(sumRefundStaffCompanyDeductionNgn(rows)).toBe(1000 + 3000);
    expect(sumRefundStaffNetPayoutNgn(rows)).toBe(4000 + 12_000);
  });
});
