import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetWorkItemSyncDebounceForTests,
  shouldSyncDerivedWorkItemsNow,
} from './workItems.js';

describe('shouldSyncDerivedWorkItemsNow', () => {
  beforeEach(() => {
    resetWorkItemSyncDebounceForTests();
  });

  it('allows the first sync then debounces the same user+branch', () => {
    expect(shouldSyncDerivedWorkItemsNow('u1', 'BR-KD')).toBe(true);
    expect(shouldSyncDerivedWorkItemsNow('u1', 'BR-KD')).toBe(false);
  });

  it('tracks user+branch pairs independently', () => {
    expect(shouldSyncDerivedWorkItemsNow('u1', 'BR-KD')).toBe(true);
    expect(shouldSyncDerivedWorkItemsNow('u1', 'BR-AB')).toBe(true);
    expect(shouldSyncDerivedWorkItemsNow('u2', 'BR-KD')).toBe(true);
  });

  it('rejects empty user ids', () => {
    expect(shouldSyncDerivedWorkItemsNow('', 'BR-KD')).toBe(false);
    expect(shouldSyncDerivedWorkItemsNow(null, 'BR-KD')).toBe(false);
  });
});
