import { describe, expect, it } from 'vitest';
import {
  fingerprintHelpQuery,
  queryFingerprintSimilarity,
} from './helpSelfTrain.js';

describe('helpSelfTrain', () => {
  it('fingerprints queries', () => {
    const a = fingerprintHelpQuery('How do I record a receipt payment?');
    const b = fingerprintHelpQuery('record receipt payment customer');
    expect(queryFingerprintSimilarity(a, b)).toBeGreaterThan(0.2);
  });
});
