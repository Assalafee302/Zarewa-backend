import { describe, expect, it } from 'vitest';
import {
  COIL_KG_EVENT,
  COIL_KG_RESTORE_BLOCKED,
  coilBookReconcileWouldRestoreKg,
  coilKgRestoreBlockedResult,
} from './coilKgEvents.js';

describe('coil kg reversing events', () => {
  it('treats a positive on-hand delta as a restore', () => {
    expect(coilBookReconcileWouldRestoreKg(18)).toBe(true);
    expect(coilBookReconcileWouldRestoreKg(0.04)).toBe(false);
    expect(coilBookReconcileWouldRestoreKg(-18)).toBe(false);
  });

  it('keeps remaining unchanged when restore is blocked', () => {
    const r = coilKgRestoreBlockedResult({
      coilNo: 'CL-T-8405',
      beforeOnHandKg: 1910,
      suggestedOnHandKg: 2000,
      onHandDeltaKg: 90,
      jobsConsumedKgSum: 410,
    });
    expect(r.ok).toBe(true);
    expect(r.restoreBlocked).toBe(true);
    expect(r.code).toBe(COIL_KG_RESTORE_BLOCKED);
    expect(r.afterOnHandKg).toBe(1910);
    expect(r.suggestedOnHandKg).toBe(2000);
    expect(r.error).toMatch(/not increased/);
  });

  it('uses finish_roll / undo_finish_roll so tail net stays event-sourced', () => {
    expect(COIL_KG_EVENT.COMPLETION_FINISH_ROLL).toBe('finish_roll');
    expect(COIL_KG_EVENT.COMPLETION_UNDO_FINISH_ROLL).toBe('undo_finish_roll');
  });
});
