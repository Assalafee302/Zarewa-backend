import { describe, expect, it } from 'vitest';
import {
  MIN_ACCOUNTING_REGISTER_LINE_NGN,
  MIN_CUSTOMER_TRADE_RECEIVABLE_NGN,
  meetsAccountingRegisterCaptureFloor,
  meetsCustomerTradeReceivableRegisterFloor,
} from './accountingRegisterConstants.js';

describe('accountingRegisterConstants', () => {
  it('uses ₦1,500 as the register capture floor', () => {
    expect(MIN_ACCOUNTING_REGISTER_LINE_NGN).toBe(1500);
    expect(MIN_CUSTOMER_TRADE_RECEIVABLE_NGN).toBe(1500);
  });

  it('meetsAccountingRegisterCaptureFloor', () => {
    expect(meetsAccountingRegisterCaptureFloor(1499)).toBe(false);
    expect(meetsAccountingRegisterCaptureFloor(1500)).toBe(true);
    expect(meetsAccountingRegisterCaptureFloor(1501)).toBe(true);
  });

  it('meetsCustomerTradeReceivableRegisterFloor', () => {
    expect(meetsCustomerTradeReceivableRegisterFloor(1499)).toBe(false);
    expect(meetsCustomerTradeReceivableRegisterFloor(1500)).toBe(true);
  });
});
