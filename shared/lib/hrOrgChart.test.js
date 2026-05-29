import { describe, expect, it } from 'vitest';
import { buildHrOrgChart, hrStaffReportingContext } from './hrOrgChart.js';

describe('hrOrgChart', () => {
  it('builds a tree from line managers', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD', lineManagerUserId: null },
      { userId: 'A', displayName: 'Alice', lineManagerUserId: 'MD' },
      { userId: 'B', displayName: 'Bob', lineManagerUserId: 'A' },
    ];
    const chart = buildHrOrgChart(staff);
    expect(chart.roots).toHaveLength(1);
    expect(chart.roots[0].userId).toBe('MD');
    expect(chart.roots[0].children[0].userId).toBe('A');
    expect(chart.roots[0].children[0].children[0].userId).toBe('B');
  });

  it('resolves manager and direct reports', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD' },
      { userId: 'A', displayName: 'Alice', lineManagerUserId: 'MD' },
      { userId: 'B', displayName: 'Bob', lineManagerUserId: 'A' },
    ];
    const ctx = hrStaffReportingContext(staff, 'A');
    expect(ctx.lineManager?.userId).toBe('MD');
    expect(ctx.directReports.map((r) => r.userId)).toEqual(['B']);
  });
});
