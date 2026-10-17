import { describe, expect, it } from 'vitest';
import { useRefundCreditInsteadBlock } from './receiptUseRefundCreditOps.js';

describe('use refund credit instead (A6)', () => {
  const pending = { id: 'RC-1', status: 'Pending clearance', quotation_ref: 'QT-1' };

  it('allows an unconfirmed receipt when the customer has credit for the quotation', () => {
    expect(useRefundCreditInsteadBlock(pending, 50000)).toBe('');
  });

  it('refuses confirmed, reversed, quote-less receipts and customers with no credit', () => {
    expect(useRefundCreditInsteadBlock({ ...pending, status: 'Cleared' }, 50000)).toMatch(/already confirmed/);
    expect(useRefundCreditInsteadBlock({ ...pending, finance_reconciliation_saved_at_iso: '2026-10-17' }, 50000)).toMatch(
      /already confirmed/
    );
    expect(useRefundCreditInsteadBlock({ ...pending, status: 'Reversed' }, 50000)).toMatch(/reversed/);
    expect(useRefundCreditInsteadBlock({ ...pending, quotation_ref: '' }, 50000)).toMatch(/no quotation/);
    expect(useRefundCreditInsteadBlock(pending, 0)).toMatch(/no approved refund/);
    expect(useRefundCreditInsteadBlock(null, 50000)).toMatch(/not found/);
  });
});
