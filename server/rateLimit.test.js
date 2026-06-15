import { describe, it, expect } from 'vitest';
import { allowRateLimit } from './rateLimit.js';

describe('rateLimit', () => {
  it('allows events within window then blocks', () => {
    const buckets = new Map();
    const key = 'test-ip';
    expect(allowRateLimit(buckets, key, 3, 60_000)).toBe(true);
    expect(allowRateLimit(buckets, key, 3, 60_000)).toBe(true);
    expect(allowRateLimit(buckets, key, 3, 60_000)).toBe(true);
    expect(allowRateLimit(buckets, key, 3, 60_000)).toBe(false);
  });
});
