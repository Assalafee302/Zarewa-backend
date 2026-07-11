import { describe, expect, it } from 'vitest';
import {
  assessCuttingListQuotationMetreVariance,
  cuttingListRoofMetresFromLines,
  cuttingListTotalMetresFromLines,
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
      cuttingListMetres: 40,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('cutting_list_no_quoted_roofing_metres');
  });

  it('passes when list total matches quote even if roof section is short', () => {
    const total = cuttingListTotalMetresFromLines([
      { lineType: 'Roof', sheets: 30, lengthM: 4.466666 },
      { lineType: 'Flatsheet', sheets: 1, lengthM: 0.5 },
    ]);
    const r = validateCuttingListQuotedRoofingAlignment({
      quotedRoofingMetres: 134.5,
      cuttingListMetres: total,
    });
    expect(r.ok).toBe(true);
  });

  it('passes when roof metres match quoted roofing within tolerance', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotedRoofingMetres: 100,
      cuttingListMetres: 100.3,
    });
    expect(r.ok).toBe(true);
  });

  it('passes at exact 0.5 m tolerance boundary', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotedRoofingMetres: 134.5,
      cuttingListMetres: 134.0,
    });
    expect(r.ok).toBe(true);
  });

  it('uses quotation products payload when lines object is provided', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotationLinesJson: {
        products: [{ name: 'Roofing Sheet', qty: 100 }, { name: 'Ridge Cap', qty: 3, girthMm: 400 }],
      },
      cuttingListLines: [
        { lineType: 'Roof', sheets: 50, lengthM: 2 },
        { lineType: 'Flatsheet', sheets: 1, lengthM: 1 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.quotedTrimBlankM).toBe(1);
  });

  it('forwards stoneMeterQuote so sold SF does not fail coil metre alignment', () => {
    const r = validateCuttingListQuotedRoofingAlignment({
      quotationLinesJson: {
        products: [
          { name: 'Roofing Sheet', qty: 120 },
          { name: 'Stone flatsheet 2', qty: 8 },
        ],
      },
      cuttingListLines: [
        { lineType: 'Roof', sheets: 1, lengthM: 120 },
        { lineType: 'StoneFlatsheet', sheets: 8, lengthM: 2 },
      ],
      stoneMeterQuote: true,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('stone_sf_cl_skip_coil_alignment');
  });
});
