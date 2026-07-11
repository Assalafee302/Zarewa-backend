import { describe, expect, it } from 'vitest';
import {
  assessCuttingListQuotationConsumption,
  finishedTrimMetresToBlankMetres,
  quotedCuttingListSheetPoolMetresFromProducts,
  quotedTrimBlankMetresFromProducts,
  validateCuttingListTrimBlankForProduction,
} from './cuttingListBlankConsumption.js';

describe('cuttingListBlankConsumption', () => {
  it('converts finished trim metres to blank metres at 1200 mm coil width', () => {
    expect(finishedTrimMetresToBlankMetres(3, 400)).toBe(1);
    expect(finishedTrimMetresToBlankMetres(6, 150)).toBe(0.75);
  });

  it('includes cladding in the sheet pool alongside roofing sheet', () => {
    const lines = {
      products: [
        { name: 'Roofing Sheet', qty: 100 },
        { name: 'Cladding', qty: 12 },
      ],
    };
    expect(quotedCuttingListSheetPoolMetresFromProducts(lines)).toBe(112);
  });

  it('sums trim blank from quoted ridge lines using girth', () => {
    const lines = {
      products: [
        { name: 'Roofing Sheet', qty: 100 },
        { name: 'Ridge Cap', qty: 3, girthMm: 400 },
      ],
    };
    expect(quotedTrimBlankMetresFromProducts(lines)).toBe(1);
  });

  it('passes when cutting list total includes trim blank consumption', () => {
    const lines = {
      products: [{ name: 'Roofing Sheet', qty: 100 }, { name: 'Ridge Cap', qty: 3, girthMm: 400 }],
    };
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: lines,
      cuttingListLines: [
        { lineType: 'Roof', sheets: 50, lengthM: 2 },
        { lineType: 'Flatsheet', sheets: 1, lengthM: 1 },
      ],
    });
    expect(assessment.ok).toBe(true);
    expect(assessment.expectedTotalM).toBe(101);
  });

  it('fails save when trim blank is omitted from cutting list total', () => {
    const lines = {
      products: [{ name: 'Roofing Sheet', qty: 100 }, { name: 'Ridge Cap', qty: 3, girthMm: 400 }],
    };
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: lines,
      cuttingListLines: [{ lineType: 'Roof', sheets: 50, lengthM: 2 }],
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.expectedTotalM).toBe(101);
    expect(assessment.cuttingListTotalM).toBe(100);
  });

  it('blocks production when flatsheet section is short of trim blank', () => {
    const lines = {
      products: [{ name: 'Roofing Sheet', qty: 100 }, { name: 'Ridge Cap', qty: 3, girthMm: 400 }],
    };
    const block = validateCuttingListTrimBlankForProduction({
      quotationLinesJson: lines,
      cuttingListLines: [{ lineType: 'Roof', sheets: 101, lengthM: 1 }],
    });
    expect(block.ok).toBe(false);
    expect(block.code).toBe('trim_blank_cl_missing');
  });

  it('flags when quotation expects coil consumption but no cutting list metres exist', () => {
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: { products: [{ name: 'Roofing Sheet', qty: 100 }] },
      cuttingListLines: [],
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.code).toBe('cutting_list_missing_for_quotation');
  });

  it('skips coil alignment for stone quotes without gutter/normal flatsheet (SF sheet counts allowed)', () => {
    const lines = {
      products: [
        { name: 'Roofing Sheet', qty: 80 },
        { name: 'Ridge Cap', qty: 6, girthMm: 400 },
      ],
    };
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: lines,
      cuttingListLines: [
        { lineType: 'Roof', sheets: 80, lengthM: 1 },
        { lineType: 'Flatsheet', sheets: 3, lengthM: 2 },
      ],
      stoneMeterQuote: true,
    });
    expect(assessment.ok).toBe(true);
    expect(assessment.quotedTrimBlankM).toBe(0);
    expect(assessment.expectedTotalM).toBe(0);
    expect(assessment.trimBlankProductionBlocked).toBe(false);
    expect(assessment.code).toBe('stone_sf_cl_skip_coil_alignment');
  });

  it('stone quote with gutter requires flatsheet section to cover coil blank (SF sheets may be extra)', () => {
    const lines = {
      products: [
        { name: 'Roofing Sheet', qty: 80 },
        { name: 'Gutter', qty: 12, girthMm: 400 },
      ],
    };
    const gutterBlank = finishedTrimMetresToBlankMetres(12, 400);
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson: lines,
      cuttingListLines: [
        { lineType: 'Roof', sheets: 80, lengthM: 1 },
        { lineType: 'Flatsheet', sheets: 1, lengthM: gutterBlank },
      ],
      stoneMeterQuote: true,
    });
    expect(assessment.ok).toBe(true);
    expect(assessment.quotedTrimBlankM).toBe(gutterBlank);
    expect(assessment.expectedTotalM).toBe(gutterBlank);
  });
});
