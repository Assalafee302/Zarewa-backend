import { describe, expect, it } from 'vitest';
import {
  buildHrOrgChart,
  buildHrOrgChartGrouped,
  buildHrOrgDataQuality,
  detectReportingCycles,
  hrStaffReportingContext,
  summarizeHrOrgChart,
  wouldCreateReportingCycle,
} from './hrOrgChart.js';

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

  it('detects reporting cycles', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD', lineManagerUserId: null },
      { userId: 'A', displayName: 'Alice', lineManagerUserId: 'MD' },
      { userId: 'B', displayName: 'Bob', lineManagerUserId: 'A' },
    ];
    expect(wouldCreateReportingCycle(staff, 'MD', 'B')).toBe(true);
    expect(wouldCreateReportingCycle(staff, 'A', 'B')).toBe(true);
    expect(wouldCreateReportingCycle(staff, 'B', 'MD')).toBe(false);
    expect(wouldCreateReportingCycle(staff, 'A', 'A')).toBe(true);
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

  it('includes avatarUrl on chart nodes', () => {
    const staff = [{ userId: 'A', displayName: 'Alice', avatarUrl: 'https://cdn.example/a.jpg' }];
    const chart = buildHrOrgChart(staff);
    expect(chart.roots[0].avatarUrl).toBe('https://cdn.example/a.jpg');
  });

  it('detects existing reporting cycles', () => {
    const staff = [
      { userId: 'A', displayName: 'Alice', lineManagerUserId: 'B' },
      { userId: 'B', displayName: 'Bob', lineManagerUserId: 'A' },
    ];
    const cycles = detectReportingCycles(staff);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members.map((m) => m.userId).sort()).toEqual(['A', 'B']);
  });

  it('builds data quality summary', () => {
    const staff = [
      { userId: 'MD', displayName: 'MD', lineManagerUserId: null },
      { userId: 'A', displayName: 'Alice', lineManagerUserId: 'MD' },
      { userId: 'X', displayName: 'Unlinked', lineManagerUserId: 'MISSING' },
    ];
    const chart = buildHrOrgChart(staff);
    const dq = buildHrOrgDataQuality(staff, chart);
    expect(dq.noManager).toBe(1);
    expect(dq.orphans).toBe(1);
    expect(dq.orphanBreakdown.manager_not_in_list).toBe(1);
  });
});
