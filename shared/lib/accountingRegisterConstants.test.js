import { describe, expect, it } from 'vitest';
import {
  MIN_CUSTOMER_TRADE_RECEIVABLE_NGN,
  meetsCustomerTradeReceivableRegisterFloor,
} from './accountingRegisterConstants.js';

describe('accountingRegisterConstants', () => {
  it('uses ₦1,000 as the customer trade receivable register floor', () => {
    expect(MIN_CUSTOMER_TRADE_RECEIVABLE_NGN).toBe(1000);
  });

  it('meetsCustomerTradeReceivableRegisterFloor', () => {
    expect(meetsCustomerTradeReceivableRegisterFloor(999)).toBe(false);
    expect(meetsCustomerTradeReceivableRegisterFloor(1000)).toBe(true);
    expect(meetsCustomerTradeReceivableRegisterFloor(1001)).toBe(true);
  });
});
