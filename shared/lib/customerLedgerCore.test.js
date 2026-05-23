import { describe, expect, it } from 'vitest';
import {
  companionOverpayNgnByReceiptId,
  planReceiptWithQuotation,
} from './customerLedgerCore.js';
import { quotationOverpaymentExcessNgn } from './refundQuotationMoney.js';

describe('planReceiptWithQuotation', () => {
  it('always posts one RECEIPT for full cash (no RECEIPT/OVERPAY split at post)', () => {
    const qt = { id: 'Q9', totalNgn: 500_000, paidNgn: 0 };
    const plan = planReceiptWithQuotation([], {
      customerID: 'C',
      customerName: 'Cust',
      quotationRow: qt,
      amountNgn: 550_000,
      paymentMethod: 'Cash',
      bankReference: '',
      dateISO: '2026-01-15',
    });
    expect(plan.ok).toBe(true);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].type).toBe('RECEIPT');
    expect(plan.rows[0].amountNgn).toBe(550_000);
  });

  it('refund overpayment excess uses full receipt cash minus quote total', () => {
    const cashInNgn = 550_000;
    const quoteTotalNgn = 500_000;
    expect(quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn })).toBe(50_000);
  });
});

describe('companionOverpayNgnByReceiptId', () => {
  it('still pairs legacy split-till receipt + overpay rows', () => {
    const entries = [
      {
        id: 'R1',
        type: 'RECEIPT',
        customerID: 'C1',
        quotationRef: 'Q1',
        atISO: '2026-04-04T12:00:00.000Z',
        paymentMethod: 'Transfer',
        bankReference: 'REF1',
        amountNgn: 500_000,
        note: 'Settlement to quotation balance (receipt)',
      },
      {
        id: 'O1',
        type: 'OVERPAY_ADVANCE',
        customerID: 'C1',
        quotationRef: 'Q1',
        atISO: '2026-04-04T12:00:00.000Z',
        paymentMethod: 'Transfer',
        bankReference: 'REF1',
        amountNgn: 50_000,
        note: 'Overpayment vs remaining balance on Q1 → advance',
      },
    ];
    expect(companionOverpayNgnByReceiptId(entries).get('R1')).toBe(50_000);
  });
});
