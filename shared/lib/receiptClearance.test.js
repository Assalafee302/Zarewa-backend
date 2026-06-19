import { describe, expect, it } from 'vitest';
import {
  isReceiptCleared,
  isReceiptPendingClearance,
  liquidityClearanceSplit,
  pendingClearanceTotalNgn,
  receiptEffectiveCashNgn,
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

  it('uses finance bank-received as effective cash when reconciled', () => {
    expect(
      receiptEffectiveCashNgn({
        amountNgn: 415_350,
        financeReconciliationSavedAtISO: '2026-05-21T10:00:00.000Z',
        bankReceivedAmountNgn: 620_000,
      })
    ).toBe(620_000);
    expect(receiptEffectiveCashNgn({ amountNgn: 100_000 })).toBe(100_000);
    expect(
      receiptEffectiveCashNgn({ amountNgn: 100_000 }, { companionOverpayNgn: 50_000 })
    ).toBe(150_000);
  });
});
