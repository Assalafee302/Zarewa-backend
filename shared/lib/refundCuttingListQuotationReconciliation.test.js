import { describe, expect, it } from 'vitest';
import {
  assessCuttingListQuotationMetreVariance,
  cuttingListRoofMetresFromLines,
  validateCuttingListQuotedRoofingAlignment,
} from './refundCuttingListQuotationReconciliation.js';

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

  it('sums only roof lines from cutting list rows', () => {
    expect(
      cuttingListRoofMetresFromLines([
        { lineType: 'Roof', sheets: 2, lengthM: 5 },
        { lineType: 'Cladding', sheets: 1, lengthM: 10 },
      ])
    ).toBe(10);
  });

  it('blocks save when roof metres exist but quotation has none', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotedRoofingMetres: 0,
      cuttingRoofMetres: 40,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cutting_list_no_quoted_roofing_metres');
  });

  it('passes when roof metres match quoted roofing within tolerance', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotedRoofingMetres: 100,
      cuttingRoofMetres: 100.3,
    });
    expect(r.ok).toBe(true);
  });
});
