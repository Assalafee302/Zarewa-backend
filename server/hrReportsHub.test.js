import { describe, expect, it } from 'vitest';
import {
  HR_REPORT_CATALOG,
  LEGACY_EXPORT_KIND_MAP,
  getHrReportCatalog,
  parseReportFilters,
  reportPreviewToCsv,
} from './hrReportsHub.js';

describe('hrReportsHub', () => {
  it('catalog includes priority reports', () => {
    const { reports } = getHrReportCatalog();
    const priorityIds = reports.filter((r) => r.priority).map((r) => r.id);
    expect(priorityIds).toContain('employee-master');
    expect(priorityIds).toContain('absence-reports');
    expect(priorityIds).toContain('promotion-due');
    expect(priorityIds).toContain('policy-acknowledgement');
  });

  it('legacy export kinds map to report ids', () => {
    expect(LEGACY_EXPORT_KIND_MAP['absence-reports']).toBe('absence-reports');
    expect(LEGACY_EXPORT_KIND_MAP['promotion-due']).toBe('promotion-due');
  });

  it('parseReportFilters normalizes query params', () => {
    const f = parseReportFilters({ branchId: 'BR-KD', fromIso: '2026-01-01', period: '202606' });
    expect(f.branchId).toBe('BR-KD');
    expect(f.fromIso).toBe('2026-01-01');
    expect(f.periodYyyymm).toBe('202606');
  });

  it('reportPreviewToCsv produces headers and rows', () => {
    const preview = {
      columns: [{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count' }],
      rows: [{ name: 'Alice', count: 1 }],
    };
    const csv = reportPreviewToCsv(preview);
    expect(csv).toContain('Name,Count');
    expect(csv).toContain('Alice,1');
  });

  it('catalog has grouped categories', () => {
    const { byCategory } = getHrReportCatalog();
    expect(byCategory.employee?.length).toBeGreaterThan(0);
    expect(byCategory.attendance?.length).toBeGreaterThan(0);
    expect(byCategory.compliance?.length).toBeGreaterThan(0);
  });
});
