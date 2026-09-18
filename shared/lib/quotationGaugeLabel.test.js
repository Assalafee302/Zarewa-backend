import { describe, expect, it } from 'vitest';
import { quotationGaugeLabel } from './materialTransactionReportCore.js';

describe('quotationGaugeLabel', () => {
  it('prefers header materialGaugeDisplay over stale product line gauge', () => {
    expect(
      quotationGaugeLabel({
        materialGauge: '0.28mm',
        materialGaugeDisplay: '0.35mm',
        quotationLines: { products: [{ gauge: '0.24mm' }] },
      })
    ).toBe('0.35mm');
  });

  it('falls back to materialGauge then product line', () => {
    expect(
      quotationGaugeLabel({
        materialGauge: '0.28mm',
        quotationLines: { products: [{ gauge: '0.24mm' }] },
      })
    ).toBe('0.28mm');
    expect(
      quotationGaugeLabel({
        quotationLines: { products: [{ gauge: '0.24mm' }] },
      })
    ).toBe('0.24mm');
  });
});
