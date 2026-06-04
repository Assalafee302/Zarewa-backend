import { describe, expect, it } from 'vitest';
import {
  buildExecDataScopeNotes,
  buildQueueSummaryTray,
  resolveExecDashboardPeriod,
} from './execDashboardOps.js';

describe('execDashboardOps', () => {
  it('resolveExecDashboardPeriod maps today, week, and last_month', () => {
    const today = resolveExecDashboardPeriod({ periodKey: 'today' });
    expect(today.key).toBe('today');
    expect(today.startISO).toBe(today.endISO);
    expect(today.biPeriodKey).toBe('month');

    const week = resolveExecDashboardPeriod({ periodKey: 'week' });
    expect(week.key).toBe('week');
    expect(week.startISO <= week.endISO).toBe(true);
    expect(week.biPeriodKey).toBe('month');

    const lm = resolveExecDashboardPeriod({ periodKey: 'last_month' });
    expect(lm.key).toBe('last_month');
    expect(lm.startISO).toMatch(/^\d{4}-\d{2}-01$/);
    expect(lm.endISO).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('buildExecDataScopeNotes flags today/week/custom vs month BI', () => {
    const todayNotes = buildExecDataScopeNotes(resolveExecDashboardPeriod({ periodKey: 'today' }));
    expect(todayNotes.length).toBeGreaterThan(0);
    expect(todayNotes[0].id).toBe('bi-month-lookback');

    const monthNotes = buildExecDataScopeNotes(resolveExecDashboardPeriod({ periodKey: 'month' }));
    expect(monthNotes).toEqual([]);
  });

  it('buildQueueSummaryTray emits one summary row per kind, not duplicated stubs', () => {
    const items = buildQueueSummaryTray(
      { pendingRefunds: 12, pendingPaymentRequests: 5, payrollDraftsAwaitingMd: 1 },
      { roleKey: 'ceo', permissions: [] },
      true
    );
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.summaryOnly === true)).toBe(true);
    expect(items.every((i) => i.canAct === false)).toBe(true);
    expect(items.some((i) => String(i.id).includes(':queue:'))).toBe(false);
    expect(items.find((i) => i.kind === 'refunds')?.title).toMatch(/12 items/);
    expect(items.find((i) => i.kind === 'payments')?.title).toMatch(/5 items/);
    expect(items.find((i) => i.kind === 'payroll')?.title).toMatch(/1 item/);
  });

  it('buildQueueSummaryTray skips zero counts', () => {
    const items = buildQueueSummaryTray(
      { pendingRefunds: 0, pendingPaymentRequests: 0, payrollDraftsAwaitingMd: 0 },
      { roleKey: 'ceo' },
      true
    );
    expect(items).toHaveLength(0);
  });
});
