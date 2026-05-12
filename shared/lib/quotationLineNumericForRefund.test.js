import { describe, it, expect } from 'vitest';
import { quotationLineQtyNumber, quotationLineUnitPriceNumber } from './quotationLineNumericForRefund.js';

describe('quotationLineNumericForRefund', () => {
  it('parses comma-formatted unitPrice for blended ₦/m', () => {
    const line = { name: 'Longspan', qty: '100', unitPrice: '5,800' };
    expect(quotationLineQtyNumber(line)).toBe(100);
    expect(quotationLineUnitPriceNumber(line)).toBe(5800);
  });

  it('parses comma qty', () => {
    expect(quotationLineQtyNumber({ qty: '1,245.5' })).toBe(1245.5);
  });
});
