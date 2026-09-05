import { describe, it, expect } from 'vitest';
import {
  REFUND_STAFF_ALLOCATION_DEDUCTION_RATE,
  REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE,
  applyRefundStaffAllocationDeduction,
  applyRefundStaffAllocationDeductions,
  normalizeRefundStaffAllocationDeductionRate,
  refundSplitIsAssociatedStaff,
  refundSplitTakesStaffDeduction,
  refundStaffAllocationDeductionAmounts,
  sumRefundStaffCompanyDeductionNgn,
  sumRefundStaffNetPayoutNgn,
  sumRefundStaffUnclearedOffsetNgn,
} from './refundStaffAllocationDeduction.js';

describe('refundStaffAllocationDeduction', () => {
  it('uses 20% company cut by default (company / claiming staff)', () => {
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

  it('holds quote-customer payout when they have uncleared receipts', () => {
    const row = applyRefundStaffAllocationDeduction(
      { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 10_000 },
      'CUS-1',
      { unclearedReceiptHoldNgn: 4_000 }
    );
    expect(row.companyDeductionNgn).toBe(0);
    expect(row.netPayoutNgn).toBe(10_000);
    expect(row.unclearedReceiptHoldNgn).toBe(4_000);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('does not auto-offset uncleared receipts from net payout', () => {
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
    expect(row.unclearedReceiptOffsetNgn).toBe(0);
    expect(row.netPayoutNgn).toBe(16_000);
    expect(row.unclearedReceiptHoldNgn).toBe(5_000);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('flags payout held when uncleared float exists even if net remains payable', () => {
    const row = applyRefundStaffAllocationDeduction(
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-CLAIM',
        amountNgn: 10_000,
      },
      'CUS-QUOTE',
      { deductionRate: 0.2, unclearedReceiptHoldNgn: 50_000 }
    );
    expect(row.netPayoutNgn).toBe(8_000);
    expect(row.unclearedReceiptOffsetNgn).toBe(0);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('allows Admin/MD to waive company cut while still flagging uncleared hold', () => {
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
    expect(row.unclearedReceiptOffsetNgn).toBe(0);
    expect(row.netPayoutNgn).toBe(10_000);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('flags overpayment fund as cashier-referral eligible while till payout stays held', () => {
    const row = applyRefundStaffAllocationDeduction(
      {
        recipientKind: 'associated_staff',
        recipientAssociatedStaffID: 'AS-1',
        amountNgn: 61_200,
      },
      'CUS-QUOTE',
      { deductionRate: 0.2, unclearedReceiptHoldNgn: 48_960, overpaymentOnly: true }
    );
    expect(row.netPayoutNgn).toBe(48_960);
    expect(row.payoutHeldForUnclearedReceipts).toBe(true);
    expect(row.overpaymentCashierReferralAvailable).toBe(true);
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
    expect(sumRefundStaffUnclearedOffsetNgn(rows)).toBe(0);
    expect(sumRefundStaffNetPayoutNgn(rows)).toBe(4000 + 12_000);
    expect(rows[1].payoutHeldForUnclearedReceipts).toBe(true);
  });

  it('identifies associated staff (driver/installer) vs. claiming staff by recipientKind', () => {
    expect(
      refundSplitIsAssociatedStaff({ recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AS-1' })
    ).toBe(true);
    expect(
      refundSplitIsAssociatedStaff({ recipientKind: 'customer', recipientCustomerID: 'CUS-CLAIM' })
    ).toBe(false);
  });

  it('applies 3% to associated staff (Transport/Installation) and 20% to claiming staff by default — no opts needed', () => {
    const rows = applyRefundStaffAllocationDeductions(
      [
        {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: 'AS-DRIVER',
          amountNgn: 14_300,
          note: 'Transport',
        },
        {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: 'AS-INSTALLER',
          amountNgn: 20_000,
          note: 'Installation',
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
    const [driver, installer, claimant] = rows;
    expect(driver.deductionRate).toBe(REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE);
    expect(driver.companyDeductionNgn).toBe(429);
    expect(driver.netPayoutNgn).toBe(13_871);
    expect(installer.deductionRate).toBe(REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE);
    expect(installer.companyDeductionNgn).toBe(600);
    expect(installer.netPayoutNgn).toBe(19_400);
    expect(claimant.deductionRate).toBe(REFUND_STAFF_ALLOCATION_DEDUCTION_RATE);
    expect(claimant.companyDeductionNgn).toBe(3_000);
    expect(claimant.netPayoutNgn).toBe(12_000);
  });

  it('lets org policy set the two rates independently', () => {
    const rows = applyRefundStaffAllocationDeductions(
      [
        { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AS-1', amountNgn: 10_000 },
        { recipientKind: 'customer', recipientCustomerID: 'CUS-CLAIM', amountNgn: 10_000 },
      ],
      'CUS-QUOTE',
      { associatedStaffDeductionRate: 0.05, claimingStaffDeductionRate: 0.15 }
    );
    expect(rows[0].companyDeductionNgn).toBe(500);
    expect(rows[1].companyDeductionNgn).toBe(1_500);
  });

  it('never deducts from the quote customer’s own refund, regardless of either rate', () => {
    const row = applyRefundStaffAllocationDeduction(
      { recipientKind: 'customer', recipientCustomerID: 'CUS-QUOTE', amountNgn: 50_000 },
      'CUS-QUOTE',
      { associatedStaffDeductionRate: 0.5, claimingStaffDeductionRate: 0.5 }
    );
    expect(row.companyDeductionNgn).toBe(0);
    expect(row.netPayoutNgn).toBe(50_000);
  });
});
