import { describe, expect, it } from 'vitest';
import { lineParticipatesInSheetFloorGate } from './pricingPolicyResolve.js';

describe('lineParticipatesInSheetFloorGate', () => {
  it('includes roofing and flat sheet products', () => {
    expect(lineParticipatesInSheetFloorGate({ name: 'Roofing Sheet' }, 'products')).toBe(true);
    expect(lineParticipatesInSheetFloorGate({ name: 'Flat sheet' }, 'products')).toBe(true);
  });

  it('excludes accessories and unnamed products', () => {
    expect(lineParticipatesInSheetFloorGate({ name: 'Drive screw nail' }, 'products')).toBe(false);
  });

  it('excludes labour services without sheet lineKind (Bending, Transport, …)', () => {
    expect(lineParticipatesInSheetFloorGate({ name: 'Bending' }, 'services')).toBe(false);
    expect(lineParticipatesInSheetFloorGate({ name: 'Transportation' }, 'services')).toBe(false);
    expect(lineParticipatesInSheetFloorGate({ name: 'Installation' }, 'services')).toBe(false);
    expect(lineParticipatesInSheetFloorGate({ name: 'Bending', lineKind: 'roofing' }, 'services')).toBe(
      true
    );
  });

  it('includes explicit ridge/flashing service kinds', () => {
    expect(lineParticipatesInSheetFloorGate({ name: 'Ridge', lineKind: 'ridge' }, 'services')).toBe(
      true
    );
  });
});
