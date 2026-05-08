import { describe, it, expect } from 'vitest';
import {
  normalizeReceiptReferenceToken,
  receiptDuplicateSignalsFromLedgerRows,
} from './receiptPostingGuards.js';

describe('receiptPostingGuards', () => {
  it('normalizeReceiptReferenceToken strips punctuation and case', () => {
    expect(normalizeReceiptReferenceToken('LE-KD-26-0191')).toBe('lekd260191');
    expect(normalizeReceiptReferenceToken('')).toBe('');
  });

  it('flags DUPLICATE_AMOUNT when a prior receipt has the same amount', () => {
    const rows = [
      { id: 'LE-1', amount_ngn: 700_000, at_iso: '2026-05-01T12:00:00.000Z', bank_reference: 'REF-A' },
    ];
    const sig = receiptDuplicateSignalsFromLedgerRows(rows, {
      amountNgn: 700_000,
      bankReference: 'NEW-REF',
    });
    expect(sig.some((s) => s.code === 'DUPLICATE_AMOUNT')).toBe(true);
  });

  it('flags DUPLICATE_REFERENCE when normalized reference overlaps', () => {
    const rows = [
      { id: 'LE-2', amount_ngn: 100_000, at_iso: '2026-05-02T12:00:00.000Z', bank_reference: 'TXN-ABC-999' },
    ];
    const sig = receiptDuplicateSignalsFromLedgerRows(rows, {
      amountNgn: 200_000,
      bankReference: 'txn-abc-999',
    });
    expect(sig.some((s) => s.code === 'DUPLICATE_REFERENCE')).toBe(true);
  });

  it('same calendar day + same amount is covered by DUPLICATE_AMOUNT', () => {
    const rows = [
      { id: 'LE-3', amount_ngn: 169_730, at_iso: '2026-05-08T10:00:00.000Z', bank_reference: 'DAY1' },
    ];
    const sig = receiptDuplicateSignalsFromLedgerRows(rows, {
      amountNgn: 169_730,
      bankReference: 'DAY2',
    });
    expect(sig.some((s) => s.code === 'DUPLICATE_AMOUNT')).toBe(true);
  });

  it('returns empty when no rows and positive amount', () => {
    expect(
      receiptDuplicateSignalsFromLedgerRows([], {
        amountNgn: 50_000,
        bankReference: 'OK',
      })
    ).toEqual([]);
  });
});
