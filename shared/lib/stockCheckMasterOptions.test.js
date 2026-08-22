import { describe, it, expect } from 'vitest';
import {
  canonicalColourName,
  coloursMatchWithMaster,
  stockRowMatchesColourFilter,
} from './stockCheckMasterOptions.js';

const masterData = {
  colours: [
    { name: 'Ivory Beige', abbreviation: 'IV', active: true },
    { name: 'Bush Green', abbreviation: 'BG', active: true },
  ],
};

describe('stockCheckMasterOptions colour canonicalization', () => {
  it('maps IV abbreviation to Ivory Beige master name', () => {
    expect(canonicalColourName(masterData, 'IV')).toBe('Ivory Beige');
    expect(canonicalColourName(masterData, 'iv')).toBe('Ivory Beige');
    expect(canonicalColourName(masterData, 'Ivory Beige')).toBe('Ivory Beige');
  });

  it('treats IV and Ivory Beige as the same for stock filters', () => {
    const row = { colour: 'IV', colourRaw: 'IV' };
    expect(stockRowMatchesColourFilter(masterData, 'Ivory Beige', row)).toBe(true);
    expect(stockRowMatchesColourFilter(masterData, 'IV', { colour: 'Ivory Beige', colourRaw: 'Ivory Beige' })).toBe(
      true
    );
    expect(coloursMatchWithMaster(masterData, 'IV', 'Ivory Beige')).toBe(true);
  });
});
