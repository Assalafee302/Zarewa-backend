import { describe, expect, it } from 'vitest';
import { heldReceiptClearanceBlock } from './receiptClearanceHold.js';

describe('heldReceiptClearanceBlock', () => {
  it('blocks a cashier from clearing the three Attah receipts', () => {
    const cashier = { roleKey: 'cashier', permissions: ['finance.pay', 'finance.post'] };
    for (const id of ['LE-KD-26-1969', 'LE-KD-26-1971', 'LE-KD-26-1972']) {
      const block = heldReceiptClearanceBlock(id, cashier);
      expect(block?.code).toBe('MANAGER_BANK_CASH_CONFIRM_REQUIRED');
    }
    expect(heldReceiptClearanceBlock('LE-OTHER', cashier)).toBeNull();
  });

  it('lets a finance manager confirm the bank or cash', () => {
    expect(heldReceiptClearanceBlock('LE-KD-26-1969', { roleKey: 'finance_manager' })).toBeNull();
    expect(heldReceiptClearanceBlock('LE-KD-26-1971', { permissions: ['finance.approve'] })).toBeNull();
  });
});
