import { describe, expect, it } from 'vitest';
import { buildHrLifecycleChecklist, normalizeHrLifecycleState } from './hrStaffLifecycle.js';

describe('hrStaffLifecycle', () => {
  it('marks onboarding incomplete when tasks pending', () => {
    const c = buildHrLifecycleChecklist('onboarding', { welcome_briefing: { done: true, at: '2026-01-01' } });
    expect(c.complete).toBe(false);
    expect(c.pendingCount).toBeGreaterThan(0);
  });

  it('normalizes separation and both workflows', () => {
    const s = normalizeHrLifecycleState({
      onboarding: { it_access: { done: true } },
      separation: { status: 'separating', lastWorkingDayIso: '2026-06-30' },
    });
    expect(s.onboarding.tasks.find((t) => t.key === 'it_access')?.done).toBe(true);
    expect(s.separation.status).toBe('separating');
    expect(s.separation.lastWorkingDayIso).toBe('2026-06-30');
  });
});
