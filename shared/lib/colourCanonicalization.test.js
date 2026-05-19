import { describe, it, expect } from 'vitest';
import {
  canonicalColourName,
  clusterDuplicateSetupColours,
  colourSelectOptionsFromRows,
  normalizeColourKey,
  pickCanonicalSetupColourRow,
} from './colourCanonicalization.js';

const masterData = {
  colours: [
    { name: 'Ivory Beige', abbreviation: 'IV', active: true },
    { name: 'Gray Beige', abbreviation: 'GB', active: true },
    { name: 'HM Blue', abbreviation: 'HMB', active: true },
  ],
};

describe('colourCanonicalization', () => {
  it('normalizes grey/gray and typos', () => {
    expect(normalizeColourKey('Gray Beige')).toBe(normalizeColourKey('Grey Beige'));
    expect(normalizeColourKey('Ivory bege')).toBe(normalizeColourKey('Ivory Beige'));
  });

  it('maps abbreviations and aliases to catalogue names', () => {
    expect(canonicalColourName(masterData, 'IV')).toBe('Ivory Beige');
    expect(canonicalColourName(masterData, 'HMB')).toBe('HM Blue');
    expect(canonicalColourName(masterData, 'Grey Beige')).toBe('Gray Beige');
  });

  it('maps nut bron typo to Nut Brown', () => {
    expect(canonicalColourName(masterData, 'nut bron')).toBe('Nut Brown');
    expect(canonicalColourName(masterData, 'Nut bron')).toBe('Nut Brown');
  });

  it('dedupes HM Blue and HMB setup rows for dropdowns', () => {
    const opts = colourSelectOptionsFromRows(
      [
        { colour_id: 'COL-001', name: 'HM Blue', abbreviation: 'HMB', active: 1, sort_order: 10 },
        { colour_id: 'COL-X', name: 'HMB', abbreviation: 'HMB', active: 1, sort_order: 900 },
      ],
      masterData
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe('HM Blue');
  });

  it('clusters duplicate setup rows by normalized name', () => {
    const groups = clusterDuplicateSetupColours([
      { colour_id: 'COL-006', name: 'Ivory Beige', abbreviation: 'IV', active: 1, sort_order: 60 },
      { colour_id: 'COL-DUP', name: 'Ivory bege', abbreviation: 'IV2', active: 1, sort_order: 900 },
      { colour_id: 'COL-010', name: 'Grey Beige', abbreviation: 'GB', active: 1, sort_order: 50 },
      { colour_id: 'COL-010B', name: 'Gray Beige', abbreviation: 'GB2', active: 1, sort_order: 51 },
    ]);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const ivoryGroup = groups.find((g) => g.some((r) => r.name.includes('Ivory')));
    expect(ivoryGroup).toBeTruthy();
    const winner = pickCanonicalSetupColourRow(ivoryGroup);
    expect(winner?.colour_id).toBe('COL-006');
  });
});
