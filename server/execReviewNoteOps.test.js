import { describe, expect, it } from 'vitest';
import { MD_REVIEW_NOTE_MAX_LEN, mdReviewNotePolicyKey } from './execReviewNoteOps.js';

describe('execReviewNoteOps', () => {
  it('mdReviewNotePolicyKey validates month format', () => {
    expect(mdReviewNotePolicyKey('2026-06')).toBe('md.chairman_review.2026-06');
    expect(mdReviewNotePolicyKey('bad')).toBeNull();
    expect(mdReviewNotePolicyKey('202606')).toBeNull();
  });

  it('review note max length is bounded', () => {
    expect(MD_REVIEW_NOTE_MAX_LEN).toBeGreaterThan(1000);
    expect(MD_REVIEW_NOTE_MAX_LEN).toBeLessThanOrEqual(10000);
  });
});
