import { describe, expect, it } from 'vitest';
import { BULK_IMPORT_COLUMNS, buildBulkImportTemplateXlsx, buildEmployeeIdUsername } from './hrStaffBulkImport.js';

describe('hrStaffBulkImport username column', () => {
  it('includes Username (existing login) in template columns', () => {
    const col = BULK_IMPORT_COLUMNS.find((c) => c.key === 'username');
    expect(col?.header).toMatch(/username/i);
    expect(col?.header).toMatch(/existing login/i);
  });

  it('uses employee ID as default login username', () => {
    const used = new Set();
    expect(buildEmployeeIdUsername('ZAPKD001', 2, used)).toBe('zapkd001');
    expect(used.has('zapkd001')).toBe(true);
    expect(buildEmployeeIdUsername('ZAPYL002', 3, used)).toBe('zapyl002');
  });

  it('builds template xlsx with legacy link guide sheet', () => {
    const buf = buildBulkImportTemplateXlsx();
    expect(buf?.length).toBeGreaterThan(1000);
  });
});
