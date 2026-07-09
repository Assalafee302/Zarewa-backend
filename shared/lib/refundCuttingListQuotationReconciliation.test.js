import { describe, expect, it } from 'vitest';
import { assessCuttingListQuotationMetreVariance } from './refundCuttingListQuotationReconciliation.js';

describe('refundCuttingListQuotationReconciliation', () => {
  it('passes when cutting list matches quoted metres within tolerance', () => {
    const r = assessCuttingListQuotationMetreVariance({
      quotedRoofingMetres: 100,
      cuttingListMetresSum: 100.4,
    });
    expect(r.ok).toBe(true);
  });

  it('flags when cutting list and quoted metres diverge materially', () => {
    const r = assessCuttingListQuotationMetreVariance({
      quotedRoofingMetres: 0,
      cuttingListMetresSum: 85,
    });
    expect(r.ok).toBe(true);

    const bad = assessCuttingListQuotationMetreVariance({
      quotedRoofingMetres: 120,
      cuttingListMetresSum: 85,
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('cutting_list_quotation_metre_mismatch');
    expect(bad.deltaMetres).toBe(35);
  });
});
