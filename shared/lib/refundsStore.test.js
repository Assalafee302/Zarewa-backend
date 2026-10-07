import { describe, it, expect } from 'vitest';
import {
  approvedRefundsAwaitingPayment,
  applyRefundSplitRemainingTillPayable,
  buildRefundCashierPayoutLines,
  capRefundCashierLinesToTillPayable,
  isRefundPayable,
  refundCashierPayeeHeadline,
  refundOutstandingAmount,
} from './refundsStore.js';

describe('refundsStore payable filters', () => {
  const payable = {
    refundID: 'RF-1',
    status: 'Approved',
    amountNgn: 5000,
    approvedAmountNgn: 5000,
    paidAmountNgn: 0,
    quotationRefundsBlockedAtISO: null,
  };

  const blocked = {
    ...payable,
    refundID: 'RF-2',
    quotationRefundsBlockedAtISO: '2026-06-01T10:00:00.000Z',
    quotationRefundsBlockedReason: 'Mistaken overpayment',
  };

  it('treats approved outstanding refunds as payable when quotation is not blocked', () => {
    expect(isRefundPayable(payable)).toBe(true);
    expect(approvedRefundsAwaitingPayment([payable, blocked])).toEqual([payable]);
  });

  it('excludes permanently blocked quotations from payable queues', () => {
    expect(isRefundPayable(blocked)).toBe(false);
    expect(approvedRefundsAwaitingPayment([blocked])).toEqual([]);
  });

  it('drops from Pay when approved fund was applied onto another receipt', () => {
    const applied = {
      ...payable,
      paidAmountNgn: 5000,
      creditAppliedNgn: 5000,
      creditAppliedToQuotationRef: 'QT-NEW',
    };
    expect(isRefundPayable(applied)).toBe(false);
    expect(approvedRefundsAwaitingPayment([applied])).toEqual([]);
  });

  it('reduces outstanding after a partial credit apply', () => {
    const partial = {
      ...payable,
      paidAmountNgn: 2000,
      creditAppliedNgn: 2000,
    };
    expect(isRefundPayable(partial)).toBe(true);
    expect(approvedRefundsAwaitingPayment([partial])).toEqual([partial]);
  });

  it('drops from Pay when settlement till payable is already zero', () => {
    const settledOnTill = {
      ...payable,
      paidAmountNgn: 3500,
      creditAppliedNgn: 3500,
      companyCutNgn: 1500,
      settlementSummary: { tillPayableNgn: 0, cashOutstandingNgn: 0, companyCutNgn: 1500 },
    };
    expect(isRefundPayable(settledOnTill)).toBe(false);
  });

  it('keeps Pay when customer cash is paid but staff till remains (RF-9737 class)', () => {
    const staffLeft = {
      refundID: 'RF-KD-26-9737',
      status: 'Partially paid',
      amountNgn: 942_690,
      approvedAmountNgn: 942_690,
      paidAmountNgn: 899_000,
      creditAppliedNgn: 0,
      companyCutNgn: 8_738,
      settlementSummary: {
        tillPayableNgn: 34_952,
        cashOutstandingNgn: 34_952,
        companyCutNgn: 8_738,
        treasuryPaidNgn: 899_000,
      },
      cashierPayoutLines: [
        {
          payeeName: 'NAZIRU ADAMU',
          tillDueNgn: 0,
          staffShare: false,
          netNgn: 899_000,
        },
        {
          payeeName: 'Muhammad Ibrahim Bakari',
          payeeBankName: 'First Bank',
          payeeAccountNo: '3064987728',
          tillDueNgn: 34_952,
          staffShare: true,
          netNgn: 34_952,
        },
      ],
    };
    expect(isRefundPayable(staffLeft)).toBe(true);
    // Stale leftover-clear counted as credit must not hide the row when till is still open.
    expect(
      isRefundPayable({
        ...staffLeft,
        creditAppliedNgn: 939_610,
      })
    ).toBe(true);
  });

  it('attributes customer cash to the large share so staff till stays open', () => {
    const lines = buildRefundCashierPayoutLines(
      [
        {
          payeeName: 'NAZIRU ADAMU',
          amountNgn: 899_000,
          netPayoutNgn: 899_000,
        },
        {
          payeeName: 'Muhammad Ibrahim Bakari',
          amountNgn: 43_690,
          companyDeductionNgn: 8_738,
          netPayoutNgn: 34_952,
          staffBankAccountMatch: true,
          payoutAccount: {
            payeeName: 'Muhammad Ibrahim Bakari',
            payeeBankName: 'First Bank',
            payeeAccountNo: '3064987728',
          },
        },
      ],
      { paidNgn: 899_000, quotationCustomer: 'Aminu Ibrahim', quotationRef: 'QT-KD-26-1751' }
    );
    const bakari = lines.find((l) => l.payeeName === 'Muhammad Ibrahim Bakari');
    expect(bakari?.tillDueNgn).toBe(34_952);
    expect(bakari?.payeeAccountNo).toBe('3064987728');
    expect(capRefundCashierLinesToTillPayable(lines, 34_952).find((l) => l.staffShare)?.tillDueNgn).toBe(
      34_952
    );
  });

  it('drops from Pay even if a stale settlement summary still shows the old till due', () => {
    const stale = {
      ...payable,
      paidAmountNgn: 5000,
      creditAppliedNgn: 5000,
      settlementSummary: { tillPayableNgn: 5000, cashOutstandingNgn: 5000 },
    };
    expect(isRefundPayable(stale)).toBe(false);
  });

  it('shrinks staff netPayout to till leftover after credit apply (RF-9636 class)', () => {
    const splits = [
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-STAFF',
        amountNgn: 959_380,
        netPayoutNgn: 959_380,
      },
    ];
    const next = applyRefundSplitRemainingTillPayable(splits, 751_480);
    expect(next[0].netPayoutNgn).toBe(751_480);
    expect(next[0].originalNetPayoutNgn).toBe(959_380);
    expect(
      refundOutstandingAmount({
        amountNgn: 959_380,
        approvedAmountNgn: 959_380,
        paidAmountNgn: 207_900,
        creditAppliedNgn: 207_900,
        settlementSummary: { tillPayableNgn: 751_480, cashOutstandingNgn: 751_480 },
      })
    ).toBe(751_480);
  });

  it('keeps customer ₦250,000 and staff ₦67,840 as two payees on one quotation (RF-KD-26-9678)', () => {
    const splits = [
      {
        recipientKind: 'customer',
        payeeName: 'Yau Haruna',
        amountNgn: 250_000,
        netPayoutNgn: 250_000,
        companyDeductionNgn: 0,
      },
      {
        recipientKind: 'customer',
        payeeName: 'Sulieman Abdullahi Liman',
        amountNgn: 84_800,
        grossNgn: 84_800,
        companyDeductionNgn: 16_960,
        netPayoutNgn: 67_840,
        staffBankAccountMatch: true,
      },
    ];
    expect(applyRefundSplitRemainingTillPayable(splits, 46_480)).toEqual(splits);

    const beforePay = buildRefundCashierPayoutLines(splits, {
      quotationCustomer: 'Usman Tijjani',
      quotationRef: 'QT-KD-26-1648',
      paidNgn: 0,
    });
    expect(beforePay.map((l) => [l.payeeName, l.roleLabel, l.tillDueNgn])).toEqual([
      ['Yau Haruna', 'Customer share', 250_000],
      ['Sulieman Abdullahi Liman', 'Staff share', 67_840],
    ]);
    expect(beforePay[0].cashierLabel).toContain('quotation customer Usman Tijjani');
    expect(beforePay[1].cashierLabel).not.toContain('Usman Tijjani is');

    const afterStaffPay = buildRefundCashierPayoutLines(splits, {
      quotationCustomer: 'Usman Tijjani',
      quotationRef: 'QT-KD-26-1648',
      paidNgn: 67_840,
    });
    expect(afterStaffPay.find((l) => l.staffShare)?.tillDueNgn).toBe(0);
    expect(afterStaffPay.find((l) => !l.staffShare)?.tillDueNgn).toBe(250_000);

    const afterBoth = buildRefundCashierPayoutLines(splits, {
      quotationCustomer: 'Usman Tijjani',
      quotationRef: 'QT-KD-26-1648',
      paidNgn: 271_360,
    });
    expect(afterBoth.find((l) => l.staffShare)?.tillDueNgn).toBe(0);
    expect(afterBoth.find((l) => !l.staffShare)?.tillDueNgn).toBe(46_480);
    expect(refundCashierPayeeHeadline(afterStaffPay, 'QT-KD-26-1648')).toMatch(/Yau Haruna/);
    expect(refundCashierPayeeHeadline(afterStaffPay, 'QT-KD-26-1648')).toMatch(/does not change the other/);
  });
});
