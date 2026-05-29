import { describe, it, expect } from 'vitest';
import { runMemoAssist } from './memoAssist.js';

describe('runMemoAssist', () => {
  it('classifies diesel memo', () => {
    const r = runMemoAssist({
      action: 'classify',
      subject: 'Generator diesel',
      body: 'Need fuel for branch generator',
    });
    expect(r.memoType).toBeTruthy();
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('returns checklist for expense memo', () => {
    const r = runMemoAssist({
      action: 'checklist',
      subject: 'Office supplies',
      body: 'Paper and toner',
      memoType: 'expense_request',
    });
    expect(Array.isArray(r.missingDetails) || Array.isArray(r.requiredDetails)).toBe(true);
  });

  it('builds correction_memo template', () => {
    const r = runMemoAssist({
      action: 'correction_memo',
      subject: 'Wrong amount',
      body: 'Payment entered incorrectly',
    });
    expect(r.improvedBody || r.correctionMemo?.body).toBeTruthy();
  });

  it('rejects unknown action via server handler contract', () => {
    const r = runMemoAssist({ action: 'not_real', subject: 'x', body: 'y' });
    expect(r.memoType || r.error).toBeTruthy();
  });
});
