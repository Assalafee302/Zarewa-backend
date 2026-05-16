import { describe, it, expect } from 'vitest';
import {
  capSuggestedRefundLinesToHeadroom,
  quotationActualCashInNgn,
  quotationOverpaymentExcessNgn,
  quotationRefundHeadroomNgn,
} from './refundQuotationMoney.js';

describe('refundQuotationMoney', () => {
  it('overpayment excess is cash in minus quote total', () => {
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: 460_000, quoteTotalNgn: 172_800 })
    ).toBe(287_200);
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: 172_800, quoteTotalNgn: 172_800 })
    ).toBe(0);
  });

  it('refund headroom when overpaid is cash in minus quote total minus refunds', () => {
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 460_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(287_200);
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 460_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 50_000,
      })
    ).toBe(237_200);
  });

  it('refund headroom when not overpaid is cash in minus refunds', () => {
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 172_800,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(172_800);
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 100_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(100_000);
  });

  it('allocates contractual lines before overpayment when sharing headroom', () => {
    const { lines } = capSuggestedRefundLinesToHeadroom(
      [
        { label: 'Overpayment', amountNgn: 1_215_800, category: 'Overpayment' },
        { label: 'Unproduced', amountNgn: 335_820, category: 'Unproduced meterage' },
      ],
      1_215_800
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.category === 'Unproduced meterage')?.amountNgn).toBe(335_820);
    expect(lines.find((l) => l.category === 'Overpayment')?.amountNgn).toBe(879_980);
    expect(lines.reduce((s, l) => s + l.amountNgn, 0)).toBe(1_215_800);
  });

  it('returns all lines unchanged when total is within headroom', () => {
    const { lines, warnings } = capSuggestedRefundLinesToHeadroom(
      [
        { label: 'Unproduced', amountNgn: 100_000, category: 'Unproduced meterage' },
        { label: 'Transport', amountNgn: 50_000, category: 'Transport issue' },
      ],
      200_000
    );
    expect(lines).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it('dedupes settled-quote repeat overpay when receipt cash is already on file', () => {
    const cashIn = quotationActualCashInNgn({
      receiptCashNgn: 580_400,
      advanceAppliedNgn: 0,
      netOverpayLedgerNgn: 596_260,
      companionOverpayOnQuoteNgn: 15_860,
      settledQuoteFullOverpayNgn: 580_400,
    });
    expect(cashIn).toBe(580_400);
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: cashIn,
        quoteTotalNgn: 564_540,
        totalRefundedNgn: 0,
      })
    ).toBe(15_860);
  });
});
