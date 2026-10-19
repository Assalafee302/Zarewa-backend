import { describe, it, expect } from 'vitest';
import { refundPayoutGlSourceId, refundPayoutGlSourceBase } from './glOps.js';

describe('refund payout journal key', () => {
  it('is refundId:paid:<movements> for an ordinary payout (unchanged)', () => {
    expect(refundPayoutGlSourceId('RF-KD-26-9730', ['TM-KD-26-3143'])).toBe('RF-KD-26-9730:paid:TM-KD-26-3143');
    expect(refundPayoutGlSourceId('RF-1', ['TM-1', 'TM-2'], '')).toBe('RF-1:paid:TM-1-TM-2');
  });

  it('carries the correction id, so a corrected re-post never collides with the reversed original', () => {
    const original = refundPayoutGlSourceId('RF-KD-26-9730', ['TM-KD-26-3143']);
    const corrected = refundPayoutGlSourceId('RF-KD-26-9730', ['TM-KD-26-3143'], 'R4-A38');
    expect(corrected).toBe('RF-KD-26-9730:paid:TM-KD-26-3143#R4-A38');
    expect(corrected).not.toBe(original);
  });

  it('strips the correction suffix for movement-tail matching', () => {
    expect(refundPayoutGlSourceBase('RF-KD-26-9730:paid:TM-KD-26-3143#R4-A38')).toBe('RF-KD-26-9730:paid:TM-KD-26-3143');
    expect(refundPayoutGlSourceBase('RF-1:paid:TM-1-TM-2')).toBe('RF-1:paid:TM-1-TM-2');
  });

  it('still matches the ERP lookups that use LIKE refundId:paid:%', () => {
    const corrected = refundPayoutGlSourceId('RF-KD-26-9730', ['TM-KD-26-3143'], 'R4-A38');
    expect(corrected.startsWith('RF-KD-26-9730:paid:')).toBe(true);
  });
});
