import { describe, it, expect } from 'vitest';
import { resolveReceiptPostingCustomer } from './receiptQuotationCustomer.js';

describe('resolveReceiptPostingCustomer', () => {
  it('uses the quotation customer when the request omits customerID', () => {
    const r = resolveReceiptPostingCustomer({ customerID: 'CUS-1' }, '');
    expect(r).toEqual({
      ok: true,
      customerID: 'CUS-1',
      requestedCustomerId: '',
      usedQuoteCustomer: true,
    });
  });

  it('uses the quotation customer when a leftover receipt customer differs', () => {
    const r = resolveReceiptPostingCustomer({ customer_id: 'CUS-QUOTE' }, 'CUS-RECEIPT');
    expect(r.ok).toBe(true);
    expect(r.customerID).toBe('CUS-QUOTE');
    expect(r.usedQuoteCustomer).toBe(true);
  });

  it('keeps the quotation customer when the request already matches', () => {
    const r = resolveReceiptPostingCustomer({ customerID: 'CUS-1' }, 'CUS-1');
    expect(r.ok).toBe(true);
    expect(r.customerID).toBe('CUS-1');
    expect(r.usedQuoteCustomer).toBe(false);
  });

  it('rejects a quotation with no customer on file', () => {
    expect(resolveReceiptPostingCustomer({ id: 'QT-1' }, 'CUS-1')).toEqual({
      ok: false,
      error: 'This quotation has no customer on file.',
    });
  });
});
