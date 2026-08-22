import { describe, expect, it } from 'vitest';
import {
  companionOverpayNgnByReceiptId,
  planReceiptWithQuotation,
  pendingAdvanceDepositRowsFromEntries,
  advanceInRemainingNgnByIdFromEntries,
  overpayCreditNgnByCustomerIdFromEntries,
} from './customerLedgerCore.js';
import { quotationOverpaymentExcessNgn } from './refundQuotationMoney.js';

describe('pending advance deposits', () => {
  it('hides fully applied ADVANCE_IN rows and shows partial remaining FIFO', () => {
    const entries = [
      { id: 'A1', customerID: 'C1', type: 'ADVANCE_IN', amountNgn: 100_000, atISO: '2026-01-01T12:00:00.000Z' },
      { id: 'A2', customerID: 'C1', type: 'ADVANCE_IN', amountNgn: 50_000, atISO: '2026-01-02T12:00:00.000Z' },
      { id: 'AP1', customerID: 'C1', type: 'ADVANCE_APPLIED', amountNgn: 120_000, quotationRef: 'Q1' },
    ];
    const remaining = advanceInRemainingNgnByIdFromEntries(entries);
    expect(remaining.get('A1')).toBe(0);
    expect(remaining.get('A2')).toBe(30_000);
    const pending = pendingAdvanceDepositRowsFromEntries(entries);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('A2');
    expect(pending[0].remainingNgn).toBe(30_000);
    expect(pending[0].originalAmountNgn).toBe(50_000);
  });

  it('excludes reversed advances', () => {
    const entries = [
      { id: 'A1', customerID: 'C1', type: 'ADVANCE_IN', amountNgn: 75_000, atISO: '2026-01-01T12:00:00.000Z' },
      {
        id: 'R1',
        customerID: 'C1',
        type: 'ADVANCE_REVERSAL',
        amountNgn: 75_000,
        bankReference: 'REVERSAL_OF:A1',
      },
    ];
    expect(pendingAdvanceDepositRowsFromEntries(entries)).toHaveLength(0);
  });
});

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

describe('overpayCreditNgnByCustomerIdFromEntries', () => {
  it('maps positive unapplied overpay credit per customer', () => {
    const entries = [
      { customerID: 'C1', type: 'OVERPAY_ADVANCE', amountNgn: 50_000 },
      { customerID: 'C1', type: 'OVERPAY_REVERSAL', amountNgn: 10_000 },
      { customerID: 'C2', type: 'OVERPAY_ADVANCE', amountNgn: 5_000 },
      { customerID: 'C2', type: 'REFUND_OVERPAY', amountNgn: 5_000 },
    ];
    const map = overpayCreditNgnByCustomerIdFromEntries(entries);
    expect(map.get('C1')).toBe(40_000);
    expect(map.has('C2')).toBe(false);
  });
});
