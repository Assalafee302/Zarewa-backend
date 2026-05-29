import { describe, expect, it } from 'vitest';
import { normalizeMaterialProfile } from './materialProfileNormalize.js';

describe('normalizeMaterialProfile', () => {
  it('merges Metra and Industrial 6 longspan profiles', () => {
    expect(normalizeMaterialProfile('Longspan (Metra)')).toBe('Longspan (Industrial 6 & Metra)');
    expect(normalizeMaterialProfile('Longspan (Indus6)')).toBe('Longspan (Industrial 6 & Metra)');
    expect(normalizeMaterialProfile('Industrial 6')).toBe('Longspan (Industrial 6 & Metra)');
    expect(normalizeMaterialProfile('Metral')).toBe('Longspan (Industrial 6 & Metra)');
  });

  it('leaves unrelated profiles unchanged', () => {
    expect(normalizeMaterialProfile('Corrugated')).toBe('Corrugated');
    expect(normalizeMaterialProfile('Roman')).toBe('Roman');
  });
});
