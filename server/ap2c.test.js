import { describe, expect, it, vi, afterEach } from 'vitest';
import { classifyPoSettlement } from './ap2SettlementClassification.js';
import {
  supplierAdvanceNgn,
  expectedOutstandingApNgn,
  roundMoney,
} from './ap2ReceivedBasisOps.js';
import { describeSupplierAdvanceGlCapability, tryPostSupplierAdvancePaymentGl } from './ap2SupplierAdvanceGl.js';
import * as featureFlags from './financeFeatureFlags.js';

describe('ap2c settlement classification', () => {
  it('supplier advance when paid > received', () => {
    expect(supplierAdvanceNgn(600_000, 800_000)).toBe(200_000);
    const c = classifyPoSettlement({
      receivedValueNgn: 0,
      supplierPaidNgn: 800_000,
      supplierAdvanceNgn: 800_000,
      expectedApNgn: 0,
    });
    expect(c.classification).toBe('supplier_advance');
    const partial = classifyPoSettlement({
      receivedValueNgn: 600_000,
      supplierPaidNgn: 800_000,
      supplierAdvanceNgn: 200_000,
      expectedApNgn: 0,
    });
    expect(partial.classification).toBe('partially_received_advance');
  });

  it('no supplier advance when received >= paid', () => {
    expect(supplierAdvanceNgn(600_000, 500_000)).toBe(0);
    expect(expectedOutstandingApNgn(600_000, 500_000)).toBe(100_000);
    const c = classifyPoSettlement({
      receivedValueNgn: 600_000,
      supplierPaidNgn: 500_000,
      expectedApNgn: 100_000,
      supplierAdvanceNgn: 0,
    });
    expect(c.classification).toBe('normal_payable');
  });

  it('payable outstanding calculation', () => {
    expect(expectedOutstandingApNgn(1_000_000, 400_000)).toBe(600_000);
  });
});

describe('ap2c supplier advance GL', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posting off by default', () => {
    vi.spyOn(featureFlags, 'readFinanceFeatureFlags').mockReturnValue({
      supplierAdvanceAccountingEnabled: false,
    });
    const r = tryPostSupplierAdvancePaymentGl(null, { amountNgn: 1000, poId: 'PO-1' });
    expect(r.skipped).toBe(true);
  });

});
