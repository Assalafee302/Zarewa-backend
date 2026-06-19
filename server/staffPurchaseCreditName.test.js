import { describe, expect, it } from 'vitest';
import { formatStaffSalesCustomerName } from './staffPurchaseCreditOps.js';

describe('formatStaffSalesCustomerName', () => {
  it('includes employee number when present', () => {
    expect(formatStaffSalesCustomerName('Ahmed Musa', 'ZAPKD004')).toBe('Ahmed Musa · ZAPKD004 (Staff)');
  });

  it('falls back without employee number', () => {
    expect(formatStaffSalesCustomerName('Ahmed Musa', '')).toBe('Ahmed Musa (Staff)');
  });

  it('normalizes employee number to uppercase', () => {
    expect(formatStaffSalesCustomerName('Jane Doe', 'zapyl002')).toBe('Jane Doe · ZAPYL002 (Staff)');
  });
});
