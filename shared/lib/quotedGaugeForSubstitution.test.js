import { describe, it, expect } from 'vitest';
import { quotedGaugeLabelForSubstitutionComparison, firstGaugeMmFromLabel } from './quotedGaugeForSubstitution.js';

describe('quotedGaugeForSubstitution', () => {
  it('picks thickest gauge when header and product lines disagree', () => {
    const lines = {
      materialGauge: '0.28mm',
      products: [{ name: 'Roof', qty: '10', unitPrice: '5000', materialGauge: '0.24mm' }],
      accessories: [],
      services: [],
    };
    expect(quotedGaugeLabelForSubstitutionComparison(lines)).toBe('0.28mm');
  });

  it('uses product line when header missing', () => {
    const lines = {
      products: [{ name: 'Roof', qty: '10', unitPrice: '5000', gauge: '0.22mm' }],
      accessories: [],
      services: [],
    };
    expect(quotedGaugeLabelForSubstitutionComparison(lines)).toBe('0.22mm');
  });

  it('reads material_gauge (snake_case) like CuttingListModal', () => {
    const lines = {
      products: [
        { name: 'Longspan', qty: '10', unitPrice: '5000', material_gauge: '0.28mm' },
      ],
      accessories: [],
      services: [],
    };
    expect(quotedGaugeLabelForSubstitutionComparison(lines)).toBe('0.28mm');
  });

  it('reads gaugeLabel on product line', () => {
    const lines = {
      products: [{ name: 'Roof', qty: '10', unitPrice: '5000', gaugeLabel: '0.30mm' }],
      accessories: [],
      services: [],
    };
    expect(quotedGaugeLabelForSubstitutionComparison(lines)).toBe('0.30mm');
  });

  it('firstGaugeMmFromLabel parses leading number', () => {
    expect(firstGaugeMmFromLabel('0.24mm')).toBeCloseTo(0.24, 5);
    expect(firstGaugeMmFromLabel('')).toBe(null);
  });
});
