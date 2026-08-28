import { describe, it, expect } from 'vitest';
import {
  allTreasurySplitsFinanceConfirmed,
  expandReceiptsToPaymentConfirmQueue,
  paymentConfirmQueueRowAmountNgn,
  unconfirmedTreasurySplitsForReceipt,
} from './receiptPaymentConfirmQueue.js';

describe('receiptPaymentConfirmQueue', () => {
  const receipt = {
    id: 'LE-1',
    ledgerEntryId: 'LE-1',
    amountNgn: 95_200,
    status: 'Pending clearance',
  };

  const movements = [
    {
      id: 'TM-A',
      type: 'RECEIPT_IN',
      sourceKind: 'LEDGER_RECEIPT',
      sourceId: 'LE-1',
      amountNgn: 61_200,
    },
    {
      id: 'TM-B',
      type: 'RECEIPT_IN',
      sourceKind: 'LEDGER_RECEIPT',
      sourceId: 'LE-1',
      amountNgn: 34_000,
    },
  ];

  it('expands multi-split pending receipts into one queue row per payment', () => {
    const rows = expandReceiptsToPaymentConfirmQueue([receipt], movements);
    expect(rows).toHaveLength(2);
    expect(rows[0]._movementId).toBe('TM-A');
    expect(rows[1]._movementId).toBe('TM-B');
    expect(paymentConfirmQueueRowAmountNgn(rows[0])).toBe(61_200);
    expect(paymentConfirmQueueRowAmountNgn(rows[1])).toBe(34_000);
  });

  it('skips confirmed splits', () => {
    const withOneDone = movements.map((m) =>
      m.id === 'TM-A' ? { ...m, financeConfirmedAtISO: '2026-08-28T12:00:00.000Z' } : m
    );
    const pending = unconfirmedTreasurySplitsForReceipt(receipt, withOneDone);
    expect(pending).toHaveLength(1);
    expect(pending[0].movementId).toBe('TM-B');
    expect(allTreasurySplitsFinanceConfirmed(receipt, withOneDone)).toBe(false);
  });
});
