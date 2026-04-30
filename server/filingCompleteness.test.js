import { describe, it, expect } from 'vitest';
import { filingCompletenessForWorkItem } from './filingCompleteness.js';

describe('filingCompletenessForWorkItem', () => {
  it('marks payment_request incomplete without reference', () => {
    const r = filingCompletenessForWorkItem('payment_request', null);
    expect(r.filingIncomplete).toBe(true);
  });
  it('marks complete when reference present', () => {
    const r = filingCompletenessForWorkItem('payment_request', { filingReference: 'ZR/B1/PREQ/2026/00001' });
    expect(r.filingIncomplete).toBe(false);
  });
  it('ignores types without filing reference requirement', () => {
    const r = filingCompletenessForWorkItem('memo', null);
    expect(r.filingIncomplete).toBe(false);
  });
});
