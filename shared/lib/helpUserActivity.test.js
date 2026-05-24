import { describe, expect, it } from 'vitest';
import {
  buildTransactionActivitySummary,
  buildTransactionCoachingHints,
  guideForErrorNote,
  guideForTransactionAction,
} from './helpUserActivity.js';

describe('helpUserActivity', () => {
  it('maps receipt audit actions to guides', () => {
    expect(guideForTransactionAction('ledger.receipt')?.articleId).toBe('record-receipt');
  });

  it('maps error notes to guides', () => {
    expect(guideForErrorNote('Accounting period locked cannot post')?.articleId).toBe('period-locked');
  });

  it('builds coaching hints from transaction totals', () => {
    const hints = buildTransactionCoachingHints({
      totals: { refundsRequested: 3, receiptCorrections: 1 },
      recentErrors: [],
      suggestedGuides: [],
    });
    expect(hints.some((h) => h.id.includes('refund'))).toBe(true);
  });

  it('summarizes user activity', () => {
    const lines = buildTransactionActivitySummary({
      totals: { receiptsPosted: 4, refundsRequested: 1 },
      performance: { level: 'normal' },
    });
    expect(lines[0]).toMatch(/receipt/i);
  });
});
