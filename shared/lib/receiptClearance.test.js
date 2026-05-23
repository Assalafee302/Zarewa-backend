import { describe, expect, it } from 'vitest';
import {
  isReceiptCleared,
  isReceiptPendingClearance,
  liquidityClearanceSplit,
  pendingClearanceTotalNgn,
} from './receiptClearance.js';

describe('receiptClearance', () => {
  it('treats finance reconciliation timestamp as cleared', () => {
    expect(isReceiptCleared({ status: 'Posted', financeReconciliationSavedAtISO: '2026-01-01' })).toBe(true);
    expect(isReceiptPendingClearance({ status: 'Posted' })).toBe(true);
  });

  it('sums pending clearance only', () => {
    const receipts = [
      { amountNgn: 100_000, status: 'Pending clearance' },
      { amountNgn: 50_000, financeReconciliationSavedAtISO: '2026-01-02' },
      { amountNgn: 10_000, status: 'Reversed' },
    ];
    expect(pendingClearanceTotalNgn(receipts)).toBe(100_000);
  });

  it('splits book liquidity', () => {
    const split = liquidityClearanceSplit([{ balance: 1_000_000 }], [
      { amountNgn: 200_000, status: 'Pending clearance' },
    ]);
    expect(split.bookTotalNgn).toBe(1_000_000);
    expect(split.pendingClearanceNgn).toBe(200_000);
    expect(split.clearedBookNgn).toBe(800_000);
  });
});
