import { describe, it, expect } from 'vitest';
import {
  applyQuoteCustomerSplitRemainder,
  normalizeRefundSplitRows,
} from './refundSplitCreate.js';

describe('refund split create remainder', () => {
  it('maps an amount-only quotation-sales-staff line to the quote customer', () => {
    const rows = normalizeRefundSplitRows(
      [
        { recipientKind: 'quotation_sales_staff', amountNgn: 410870 },
        {
          recipientKind: 'customer',
          recipientCustomerID: 'CUS-STAFF',
          amountNgn: 100000,
        },
      ],
      { quoteCustomerId: 'CUS-KD-26-0117' }
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientKind: 'customer',
          recipientCustomerID: 'CUS-KD-26-0117',
          amountNgn: 410870,
        }),
        expect.objectContaining({
          recipientCustomerID: 'CUS-STAFF',
          amountNgn: 100000,
        }),
      ])
    );
    const total = rows.reduce((s, r) => s + r.amountNgn, 0);
    expect(total).toBe(510870);
  });

  it('drops a staff line with no payee then puts remainder on the quote customer', () => {
    const normalized = normalizeRefundSplitRows(
      [
        { recipientKind: 'associated_staff', amountNgn: 410870 },
        {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: 'AST-DRV-1',
          amountNgn: 100000,
        },
      ],
      { quoteCustomerId: 'CUS-QUOTE' }
    );
    expect(normalized).toHaveLength(1);
    expect(normalized[0].amountNgn).toBe(100000);

    const withRemainder = applyQuoteCustomerSplitRemainder(normalized, 510870, 'CUS-QUOTE', {
      customerHasBank: true,
    });
    expect(withRemainder).toHaveLength(2);
    expect(withRemainder.find((r) => r.recipientCustomerID === 'CUS-QUOTE')?.amountNgn).toBe(410870);
    const total = withRemainder.reduce((s, r) => s + r.amountNgn, 0);
    expect(total).toBe(510870);
  });

  it('does not invent a customer remainder when the quote customer has no bank', () => {
    const normalized = normalizeRefundSplitRows([
      {
        recipientKind: 'associated_staff',
        recipientAssociatedStaffID: 'AST-DRV-1',
        amountNgn: 100000,
      },
    ]);
    const withRemainder = applyQuoteCustomerSplitRemainder(normalized, 510870, 'CUS-QUOTE', {
      customerHasBank: false,
    });
    expect(withRemainder).toHaveLength(1);
    expect(withRemainder[0].amountNgn).toBe(100000);
  });
});
