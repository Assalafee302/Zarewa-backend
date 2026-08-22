import { describe, it, expect } from 'vitest';
import { formatNoCoilMatchAlertForCuttingList } from './salesCuttingListMaterialReadiness.js';

describe('salesCuttingListMaterialReadiness', () => {
  it('formats no-match alert with list id and quote material fields', () => {
    const cl = { id: 'CL-0006', customer: 'Acme' };
    const q = {
      materialColor: 'Heritage Blue',
      materialGauge: '0.45mm',
      materialTypeName: 'Aluzinc longspan',
    };
    expect(formatNoCoilMatchAlertForCuttingList(cl, q)).toBe(
      'CL-0006 does not have a coil match for colour Heritage Blue, gauge 0.45mm, material Aluzinc longspan.'
    );
  });
});
