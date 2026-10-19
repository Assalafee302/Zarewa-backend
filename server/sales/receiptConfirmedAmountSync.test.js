import { describe, it, expect } from 'vitest';
import { receiptConfirmedBankAmountAfterCorrection } from './receiptConfirmedAmountSync.js';
import { quotationPaymentCashBreakdownFromRows } from '../quotationPaymentCash.js';

// QT-KD-26-1818 / LE-KD-26-2150 (Adam Suleiman): sales entered ₦1,215,000 + ₦464,000 = ₦1,679,000,
// confirmed 16 Oct; on 17 Oct line 1 was corrected to ₦1,250,000 (bank 14 Oct) → ₦1,714,000.
const clearedReceipt = {
  id: 'LE-KD-26-2150',
  ledger_entry_id: 'LE-KD-26-2150',
  amount_ngn: 1_679_000,
  bank_received_amount_ngn: 1_679_000,
  status: 'Cleared',
  finance_reconciliation_saved_at_iso: '2026-10-16T15:31:38.144Z',
};

describe('receiptConfirmedBankAmountAfterCorrection', () => {
  it('moves a cleared receipt confirmed amount to the corrected total', () => {
    expect(receiptConfirmedBankAmountAfterCorrection(clearedReceipt, 1_714_000)).toBe(1_714_000);
  });

  it('leaves the field when it already matches', () => {
    expect(receiptConfirmedBankAmountAfterCorrection(clearedReceipt, 1_679_000)).toBeNull();
  });

  it('does not invent a confirmed amount on a receipt finance has not confirmed', () => {
    const pending = {
      ...clearedReceipt,
      bank_received_amount_ngn: null,
      status: 'Pending clearance',
      finance_reconciliation_saved_at_iso: null,
    };
    expect(receiptConfirmedBankAmountAfterCorrection(pending, 1_714_000)).toBeNull();
  });

  it('carries a partial split confirm forward (field already set, receipt not cleared yet)', () => {
    const partial = {
      ...clearedReceipt,
      bank_received_amount_ngn: 1_215_000,
      status: 'Pending clearance',
      finance_reconciliation_saved_at_iso: null,
    };
    expect(receiptConfirmedBankAmountAfterCorrection(partial, 1_250_000)).toBe(1_250_000);
  });

  it('keeps a refund-fund ₦0 confirm at ₦0', () => {
    const fundCovered = { ...clearedReceipt, bank_received_amount_ngn: 0 };
    expect(receiptConfirmedBankAmountAfterCorrection(fundCovered, 0)).toBeNull();
  });

  it('ignores reversed receipts', () => {
    expect(
      receiptConfirmedBankAmountAfterCorrection({ ...clearedReceipt, status: 'Reversed' }, 1_714_000)
    ).toBeNull();
  });
});

describe('refund cash-in reads the confirmed amount (entered ≠ confirmed)', () => {
  const ledger = [
    { id: 'LE-KD-26-2150', type: 'RECEIPT', quotationRef: 'QT-KD-26-1818', amountNgn: 1_439_040 },
    {
      id: 'LE-KD-26-2152',
      type: 'OVERPAY_ADVANCE',
      quotationRef: 'QT-KD-26-1818',
      amountNgn: 274_960,
      note: 'Overpayment vs remaining balance on QT-KD-26-1818 → customer credit',
    },
  ];

  it('stale confirmed field (the bug) gives the entered ₦1,679,000', () => {
    const stale = { ...clearedReceipt, amount_ngn: 1_714_000 };
    expect(quotationPaymentCashBreakdownFromRows([stale], ledger).cashInNgn).toBe(1_679_000);
  });

  it('after the correction flows into the confirmed field, cash-in is ₦1,714,000', () => {
    const next = receiptConfirmedBankAmountAfterCorrection(clearedReceipt, 1_714_000);
    const fixed = { ...clearedReceipt, amount_ngn: 1_714_000, bank_received_amount_ngn: next };
    const cash = quotationPaymentCashBreakdownFromRows([fixed], ledger);
    expect(cash.cashInNgn).toBe(1_714_000);
    // Overpayment the refund may use = cash-in − quote total ₦1,439,040.
    expect(cash.cashInNgn - 1_439_040).toBe(274_960);
  });
});
