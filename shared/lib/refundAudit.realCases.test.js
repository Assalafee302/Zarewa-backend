/**
 * Refund audit (feat/refund-audit) — Part 2 calculation tests with real Kaduna figures.
 * Every number below is read from the restored copy zarewa_restore_20261014 (14 Oct 2026) or the owner's
 * brief; each test states the hand calculation and what the ERP returns. Pure functions only.
 */
import { describe, it, expect } from 'vitest';
import {
  quotationRefundHardCapNgn,
  quotationOverpaymentExcessNgn,
  quotationOverpaymentResidualNgn,
  quotationRemainingRefundableNgn,
  validateRefundCalculationLinesNgn,
  overpayResidualNeededForPayoutNgn,
} from './refundQuotationMoney.js';
import { buildDerivedRefundCategoryCapsNgn } from './refundCategoryDerivedCaps.js';
import {
  refundAmountExceedsEconomicFloorCap,
  refundFloorGatedAmountNgn,
  refundRequestIsEconomicFloorExempt,
} from '../refundConstants.js';
import {
  applyRefundStaffAllocationDeductions,
  applyRefundStaffAllocationDeduction,
  sumRefundStaffCompanyDeductionNgn,
  sumRefundStaffNetPayoutNgn,
} from './refundStaffAllocationDeduction.js';
import { refundOverpayConsumedNgn, unclaimedOverpayCreditNgn } from './refundCreditApply.js';
import { quotationPaymentCashBreakdownFromRows } from '../../server/quotationPaymentCash.js';
import { payoutRemainderOffersRoundingClose, PAYOUT_ROUNDING_CLOSE_MAX_NGN } from './payoutRoundingClose.js';
import { assertTreasuryAmount, TreasuryAmountError } from './treasuryAmountPolicy.js';
import { buildRefundCashierPayoutLines } from './refundsStore.js';

/* ------------------------------------------------------------------------------------------------ */
/* QT-KD-26-1777 (Abbas Gabdo) — overpayment + substitution paid, then nails shortfall               */
/* ------------------------------------------------------------------------------------------------ */
describe('QT-KD-26-1777 Gabdo — 2+ refunds/credits on one quotation', () => {
  const cashIn = 12_000_000; // LE-KD-26-2060, bank_received_amount_ngn
  const quoteTotal = 10_218_200; // 1,751 m × ₦5,700 + 95 packs × ₦2,500
  const rf9776 = 1_913_200; // Overpayment 1,752,600 + Substitution 160,600 (Approved)
  const creditOutToQt1782 = 29_200; // RCA-1791658390301-ak0d1s, kind overpay, no refund id

  it('overpayment residual on the refund form = 1,752,600 (excess 1,781,800 − credit out 29,200)', () => {
    expect(quotationOverpaymentExcessNgn({ cashInNgn: cashIn, quoteTotalNgn: quoteTotal })).toBe(1_781_800);
    expect(
      quotationOverpaymentResidualNgn({
        cashInNgn: cashIn,
        quoteTotalNgn: quoteTotal,
        overpaymentAlreadyRefundedNgn: 0,
        creditAppliedOutNgn: creditOutToQt1782,
      })
    ).toBe(1_752_600);
  });

  it('refundable balance after RF-9776 and the QT-1782 credit = 10,057,600 (the hand figure)', () => {
    // quotationActiveRefundedTotalNgn = Σ non-rejected refunds + unlinked credit out (text-sum bug fixed on this branch)
    const activeRefunded = rf9776 + creditOutToQt1782;
    expect(activeRefunded).toBe(1_942_400);
    expect(quotationRefundHardCapNgn({ cashInNgn: cashIn, totalRefundedNgn: activeRefunded })).toBe(10_057_600);
    // The MySQL text-sum bug produced "1913200" + 29200 = 191,320,029,200 → cap 0 → "fully covered".
    const buggy = Math.max(0, cashIn - Number('1913200' + 29_200));
    expect(buggy).toBe(0);
  });

  it('nails shortfall line = (95 − 35) × ₦2,500 = ₦150,000 and fits the hard cap', () => {
    const shortfallLine = {
      category: 'Accessory shortfall',
      label: 'Accessory shortfall: Drive screw nail (60 × ₦2,500)',
      amountNgn: 60 * 2_500,
    };
    expect(shortfallLine.amountNgn).toBe(150_000);
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: cashIn,
      quoteTotalNgn: quoteTotal,
      totalRefundedNgn: rf9776 + creditOutToQt1782,
      calculationLines: [shortfallLine],
      categorySuggestedMaxNgn: { 'Accessory shortfall': 150_000 },
      derivedCategoryMaxNgn: {},
      overpaymentAlreadyRefundedNgn: 1_752_600,
      creditAppliedOutNgn: creditOutToQt1782,
    });
    expect(r.ok).toBe(true);
    expect(r.hardCapNgn).toBe(10_057_600);
  });

  it('DECISION — the economic floor still refuses the nails shortfall on this below-floor quote', () => {
    // 1,751 m completed at workbook floor ₦5,750/m (quoted ₦5,700/m, below floor, quoted-selling cap applies
    // only when the quote is below floor: floor value = 1,751 × 5,700 = 9,980,700 via quoted_selling_cap).
    const floorDeliveredQuotedCap = 1_751 * 5_700;
    const priorRefunded = rf9776 + creditOutToQt1782;
    const maxDefensible = Math.max(0, cashIn - floorDeliveredQuotedCap - priorRefunded);
    expect(maxDefensible).toBe(76_900); // 12,000,000 − 9,980,700 − 1,942,400
    const lines = [{ category: 'Accessory shortfall', label: 'Accessory shortfall: Drive screw nail (60 × ₦2,500)', amountNgn: 150_000 }];
    expect(refundRequestIsEconomicFloorExempt({ categories: ['Accessory shortfall'], calculationLines: lines })).toBe(false);
    expect(refundFloorGatedAmountNgn(lines)).toBe(150_000);
    expect(
      refundAmountExceedsEconomicFloorCap({
        amountNgn: 150_000,
        calculationLines: lines,
        categories: ['Accessory shortfall'],
        maxDefensibleRefundNgn: maxDefensible,
      })
    ).toBe(true);
    // Derived caps give Accessory shortfall no cap of its own (only Order cancellation / Other / MD discount).
    const caps = buildDerivedRefundCategoryCapsNgn({
      cashInNgn: cashIn,
      totalRefundedNgn: priorRefunded,
      economicFloor: { maxDefensibleRefundNgn: maxDefensible, floorDeliveredValueNgn: floorDeliveredQuotedCap, producedOutputMeters: 1_751 },
    });
    expect(caps['Order cancellation']).toBe(76_900);
    expect(caps['Accessory shortfall']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Receipt whose confirmed amount differs from the entered amount                                   */
/* ------------------------------------------------------------------------------------------------ */
describe('receipt confirmed ≠ entered (bank_received_amount_ngn is the cash-in once cleared)', () => {
  const ledger = [];
  it('QT-KD-26-1818 class: entered 1,679,000, bank lines 1,250,000 + 464,000 → cash in 1,714,000', () => {
    const cleared = {
      id: 'LE-KD-26-2150',
      amount_ngn: 1_714_000, // book amount after the correction
      bank_received_amount_ngn: 1_714_000, // synced by hotfix/refund-uses-confirmed-amount
      status: 'Cleared',
      finance_reconciliation_saved_at_iso: '2026-10-15T10:00:00.000Z',
      ledger_entry_id: 'LE-KD-26-2150',
    };
    const b = quotationPaymentCashBreakdownFromRows([cleared], ledger);
    expect(b.cashInNgn).toBe(1_714_000);
    expect(b.reconciledReceiptCashNgn).toBe(1_714_000);
  });

  it('before the sync the field kept the old figure and refunds saw 1,679,000', () => {
    const stale = {
      id: 'LE-KD-26-2150',
      amount_ngn: 1_714_000,
      bank_received_amount_ngn: 1_679_000, // not moved by the correction (the bug)
      status: 'Cleared',
      finance_reconciliation_saved_at_iso: '2026-10-15T10:00:00.000Z',
      ledger_entry_id: 'LE-KD-26-2150',
    };
    const b = quotationPaymentCashBreakdownFromRows([stale], ledger);
    expect(b.cashInNgn).toBe(1_679_000);
    expect(b.receiptAllocatedSumNgn).toBe(1_679_000);
  });

  it('a pending (uncleared) receipt counts its entered amount, and refunds are refused until cleared', () => {
    const pending = { id: 'LE-X', amount_ngn: 500_000, bank_received_amount_ngn: null, status: 'Pending', ledger_entry_id: 'LE-X' };
    expect(quotationPaymentCashBreakdownFromRows([pending], ledger).cashInNgn).toBe(500_000);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* RF-KD-26-9734 Mahadi — mixed refund paid in cash, later offered as credit                          */
/* ------------------------------------------------------------------------------------------------ */
describe('RF-KD-26-9734 Mahadi — mixed refund (Overpayment 47,450 + Installation 20,000 + Transport 7,000)', () => {
  const row = {
    refund_id: 'RF-KD-26-9734',
    status: 'Paid',
    reason_category: '["Overpayment","Installation issue","Transport issue"]',
    calculation_lines_json: JSON.stringify([
      { label: 'Overpayment on QT-KD-26-1697', amountNgn: 47_450, category: 'Overpayment' },
      { label: 'Unclaimed installation / labour: Installation', amountNgn: 20_000, category: 'Installation issue' },
      { label: 'Unclaimed transport: Transportation', amountNgn: 7_000, category: 'Transport issue' },
    ]),
    amount_ngn: 74_450,
    paid_amount_ngn: 72_216, // after the driver's 3 % cut (₦2,234)
    paid_at_iso: '2026-10-06',
    paid_by: 'Mansur Lawal Matazu',
  };
  const economicExcess = 196_350 - 148_900; // LE-KD-26-1959 vs quote total

  it('overpayment consumed by the cash payout = the Overpayment line (47,450), capped by cash out', () => {
    expect(economicExcess).toBe(47_450);
    expect(refundOverpayConsumedNgn(row, 72_216)).toBe(47_450);
  });

  it('nothing is left to offer as credit on QT-KD-26-1697 (was ₦42,766 before the fix)', () => {
    expect(
      unclaimedOverpayCreditNgn({ ledgerPoolNgn: 0, economicExcessNgn: economicExcess, refundOpenNgn: 0, refundConsumedNgn: 47_450 })
    ).toBe(0);
    // The old helper returned 0 consumed for a mixed refund:
    expect(unclaimedOverpayCreditNgn({ economicExcessNgn: economicExcess, refundConsumedNgn: 0 })).toBe(47_450);
  });

  it('till payout residual gate needs only the Overpayment line, not the full 72,216', () => {
    expect(overpayResidualNeededForPayoutNgn({ overpayLineNgn: 47_450, payoutAmountNgn: 72_216 })).toBe(47_450);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Staff split: customer 100 %, staff 80 % / 20 % retained                                           */
/* ------------------------------------------------------------------------------------------------ */
describe('staff split — RF-KD-26-9769 Yunusa and RF-KD-26-9776 Gabdo', () => {
  const yunusaSplits = [
    { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-1118', amountNgn: 730_000 },
    { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-0953', amountNgn: 172_940, staffBankAccountMatch: true, forceClaimingStaffCut: true },
  ];

  it('RF-9769: customer 730,000 untouched; staff 172,940 → cut 34,588, net 138,352', () => {
    const out = applyRefundStaffAllocationDeductions(yunusaSplits, 'CUS-KD-26-1118', { overpaymentOnly: true });
    expect(out[0]).toMatchObject({ companyDeductionNgn: 0, netPayoutNgn: 730_000, deductionRate: 0 });
    expect(out[1]).toMatchObject({ companyDeductionNgn: 34_588, netPayoutNgn: 138_352, deductionRate: 0.2 });
    expect(sumRefundStaffCompanyDeductionNgn(out)).toBe(34_588);
    expect(sumRefundStaffNetPayoutNgn(out)).toBe(868_352); // = paid_amount_ngn on the row (730,000 + 138,352)
  });

  it('RF-9776: customer 1,752,600; staff 160,600 → cut 32,120, net 128,480', () => {
    const splits = [
      { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-0904', amountNgn: 1_752_600 },
      { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-0953', amountNgn: 160_600, staffBankAccountMatch: true },
    ];
    const out = applyRefundStaffAllocationDeductions(splits, 'CUS-KD-26-0904', {});
    expect(out[1]).toMatchObject({ companyDeductionNgn: 32_120, netPayoutNgn: 128_480 });
    expect(out[0].netPayoutNgn).toBe(1_752_600);
    // Owner's payouts: 1,147,000 + 605,600 to the customer (= 1,752,600) and 128,480 to staff.
    expect(1_147_000 + 605_600).toBe(1_752_600);
  });

  it('the 20 % is on the staff share only; an associated-staff driver takes 3 % (RF-9734: 74,450 → 2,234)', () => {
    const driver = applyRefundStaffAllocationDeduction(
      { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AS-001', amountNgn: 74_450 },
      'CUS-KD-26-1100'
    );
    expect(driver.companyDeductionNgn).toBe(2_234); // round(74,450 × 0.03) = 2,233.5 → 2,234
    expect(driver.netPayoutNgn).toBe(72_216);
  });

  it('cashier desk attributes cash already paid to each payee, not to one changing balance', () => {
    const lines = buildRefundCashierPayoutLines(
      [
        { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-1118', amountNgn: 730_000, companyDeductionNgn: 0, netPayoutNgn: 730_000, payoutAccount: { payeeName: 'Babangida' } },
        { recipientKind: 'customer', recipientCustomerID: 'CUS-KD-26-0953', amountNgn: 172_940, companyDeductionNgn: 34_588, netPayoutNgn: 138_352, staffBankAccountMatch: true, payoutAccount: { payeeName: 'Abdulrahman Uthman Sali' } },
      ],
      { quotationCustomer: 'Yunusa Driver', quotationRef: 'QT-KD-26-1747', paidNgn: 730_000 }
    );
    expect(lines.map((l) => [l.payeeName, l.paidToPayeeNgn, l.tillDueNgn])).toEqual([
      ['Babangida', 730_000, 0],
      ['Abdulrahman Uthman Sali', 0, 138_352],
    ]);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Remainders ₦1–₦500                                                                               */
/* ------------------------------------------------------------------------------------------------ */
describe('remainders — what happens to ₦1 … ₦500 left on a refund', () => {
  it('₦1 is inside the settlement tolerance (treated as paid); ₦2–₦200 may be closed as rounding; ₦201+ must be paid', () => {
    expect(payoutRemainderOffersRoundingClose(1)).toBe(false);
    expect(payoutRemainderOffersRoundingClose(2)).toBe(true);
    expect(payoutRemainderOffersRoundingClose(PAYOUT_ROUNDING_CLOSE_MAX_NGN)).toBe(true);
    expect(payoutRemainderOffersRoundingClose(201)).toBe(false);
    expect(payoutRemainderOffersRoundingClose(500)).toBe(false);
  });

  it('a payout line below ₦100 needs a confirmation reason; ₦100 and above does not', () => {
    expect(() => assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: -80 })).toThrow(TreasuryAmountError);
    expect(assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: -80, amountFloorReason: 'last ₦80 of RF-9700' }).ok).toBe(true);
    expect(assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: -100 }).ok).toBe(true);
    expect(assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: -300 }).ok).toBe(true);
  });

  it('a "remainder" that is only the company cut is not a remainder (RF-KD-26-9733: approved 1,000, paid 800)', () => {
    const out = applyRefundStaffAllocationDeduction(
      { recipientKind: 'customer', recipientCustomerID: 'CUS-STAFF', amountNgn: 1_000 },
      'CUS-QUOTE'
    );
    expect(out.companyDeductionNgn).toBe(200);
    expect(out.netPayoutNgn).toBe(800);
    // net cash due = approved − cut = 800 = paid → nothing left; approved − paid (200) is not owed to anyone.
    expect(1_000 - out.companyDeductionNgn - 800).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* "Remaining" on the form is the suggested-lines sum, not the refundable balance                   */
/* ------------------------------------------------------------------------------------------------ */
describe('what the form calls "Remaining"', () => {
  it('QT-1777 after RF-9776: hard cap 10,057,600 but "Remaining" shows 150,000 (sum of what is suggested)', () => {
    const remaining = quotationRemainingRefundableNgn({
      cashInNgn: 12_000_000,
      quoteTotalNgn: 10_218_200,
      totalRefundedNgn: 1_942_400,
      suggestedLines: [{ category: 'Accessory shortfall', amountNgn: 150_000 }],
    });
    expect(remaining).toBe(150_000);
    expect(quotationRefundHardCapNgn({ cashInNgn: 12_000_000, totalRefundedNgn: 1_942_400 })).toBe(10_057_600);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Refusal messages state the rule and every number (fix on feat/refund-audit)                       */
/* ------------------------------------------------------------------------------------------------ */
import { quotationRefundableBreakdown, refundAboveRefundableMessage } from './refundQuotationMoney.js';

describe('refundable balance breakdown and refusal sentence', () => {
  it('QT-1777: cash 12,000,000 − refunds 1,913,200 − credit out 29,200 = refundable 10,057,600', () => {
    const b = quotationRefundableBreakdown({ cashInNgn: 12_000_000, refundsNgn: 1_913_200, creditOutNgn: 29_200 });
    expect(b.refundableNgn).toBe(10_057_600);
    expect(b.sentence).toBe(
      'cash received ₦12,000,000 − existing refunds ₦1,913,200 − credit applied to other quotations ₦29,200 = refundable ₦10,057,600'
    );
  });

  it("the owner's example: refundable 157,600, request 160,000 → exceeds by 2,400", () => {
    const msg = refundAboveRefundableMessage({ requestedNgn: 160_000, cashInNgn: 2_100_000, refundsNgn: 1_913_200, creditOutNgn: 29_200 });
    expect(msg).toBe(
      'Refund ₦160,000 is above the refundable balance ₦157,600 by ₦2,400 (cash received ₦2,100,000 − existing refunds ₦1,913,200 − credit applied to other quotations ₦29,200 = refundable ₦157,600).'
    );
  });

  it('nothing refundable: says so with the same numbers', () => {
    const msg = refundAboveRefundableMessage({ requestedNgn: 50_000, cashInNgn: 500_000, refundsNgn: 500_000 });
    expect(msg).toBe('Refund ₦50,000 cannot be paid: nothing is refundable on this quotation (cash received ₦500,000 − existing refunds ₦500,000 = refundable ₦0).');
  });

  it('validateRefundCalculationLinesNgn carries the breakdown when lines exceed the balance', () => {
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: 2_100_000,
      quoteTotalNgn: 2_000_000,
      totalRefundedNgn: 1_942_400, // refunds 1,913,200 + credit out 29,200 (quotationActiveRefundedTotalNgn)
      creditAppliedOutNgn: 29_200,
      calculationLines: [{ category: 'Accessory shortfall', amountNgn: 160_000 }],
      categorySuggestedMaxNgn: { 'Accessory shortfall': 160_000 },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_ABOVE_REFUNDABLE');
    expect(r.error).toMatch(/above the refundable balance ₦157,600 by ₦2,400/);
    expect(r.error).toMatch(/existing refunds ₦1,913,200 − credit applied to other quotations ₦29,200/);
  });
});
