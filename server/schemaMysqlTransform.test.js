import { describe, it, expect } from 'vitest';
import { sqliteDdlToMysql } from './schemaMysqlTransform.js';

describe('schemaMysqlTransform material incident indexes', () => {
  it('does not prefix REAL columns in pool index', () => {
    const ddl = `
CREATE INDEX IF NOT EXISTS idx_material_incidents_pool
  ON material_incidents(branch_id, material_family, gauge_label, colour, meters_available);
`;
    const mysql = sqliteDdlToMysql(ddl);
    expect(mysql).not.toMatch(/meters_available\s*\(\d+\)/i);
  });

  it('matches production pool index without meters_available', () => {
    const ddl = `
CREATE INDEX IF NOT EXISTS idx_material_incidents_pool
  ON material_incidents(branch_id, material_family, gauge_label, colour);
`;
    const mysql = sqliteDdlToMysql(ddl);
    expect(mysql).toContain('gauge_label(64)');
    expect(mysql).not.toContain('meters_available');
  });
});
