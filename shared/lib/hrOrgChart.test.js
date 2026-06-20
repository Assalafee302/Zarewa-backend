import { describe, expect, it } from 'vitest';
import { buildHrOrgChart, buildHrOrgChartGrouped, hrStaffReportingContext, summarizeHrOrgChart } from './hrOrgChart.js';

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
    expect(chart.roots[0].directReportCount).toBe(1);
    expect(chart.roots[0].subtreeSize).toBe(3);
  });

  it('summarizes departments and depth', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD', department: 'Executive', normalized: { orgNode: 'hq_admin', taxonomy: { seniority: 'leadership', roleFamily: 'general' } } },
      { userId: 'A', displayName: 'Alice', department: 'HR', lineManagerUserId: 'MD', normalized: { orgNode: 'branch_ops', taxonomy: { seniority: 'mid', roleFamily: 'hr' } } },
    ];
    const chart = buildHrOrgChart(staff);
    const summary = summarizeHrOrgChart(chart);
    expect(summary.total).toBe(2);
    expect(summary.leadership).toBe(1);
    expect(summary.maxDepth).toBe(1);
    expect(summary.departments.some((d) => d.key === 'HR')).toBe(true);
  });

  it('groups chart sections by department', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD', department: 'Executive' },
      { userId: 'A', displayName: 'Alice', department: 'HR', lineManagerUserId: 'MD' },
      { userId: 'B', displayName: 'Bob', department: 'HR', lineManagerUserId: 'A' },
    ];
    const chart = buildHrOrgChart(staff);
    const sections = buildHrOrgChartGrouped(chart, 'department');
    const hr = sections.find((s) => s.key === 'HR');
    expect(hr?.count).toBe(2);
    expect(hr?.roots[0].userId).toBe('A');
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
