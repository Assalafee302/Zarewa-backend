import { describe, it, expect } from 'vitest';
import {
  sqliteDdlToMysql,
  stripMysqlIncompatibleIndexExprs,
  stripMysqlIllegalTextBlobDefaults,
} from './schemaMysqlTransform.js';

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

describe('schemaMysqlTransform IFNULL index expressions', () => {
  it('strips IFNULL(col, \'\') from CREATE UNIQUE INDEX for MariaDB', () => {
    const ddl = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_rooms_scope_slug_unique
  ON workspace_rooms(scope_kind, IFNULL(branch_id, ''), slug);
`;
    const mysql = sqliteDdlToMysql(ddl);
    expect(mysql).not.toMatch(/IFNULL/i);
    expect(mysql).toMatch(
      /CREATE UNIQUE INDEX idx_workspace_rooms_scope_slug_unique\s+ON workspace_rooms\(scope_kind\(64\), branch_id\(64\), slug\(64\)\)/i
    );
  });

  it('stripMysqlIncompatibleIndexExprs collapses IFNULL(col, \'\') to the column', () => {
    expect(stripMysqlIncompatibleIndexExprs(`ON t(scope_kind, IFNULL(branch_id, ''), slug)`)).toBe(
      `ON t(scope_kind, branch_id, slug)`
    );
  });
});

describe('schemaMysqlTransform MEDIUMTEXT defaults', () => {
  it('strips DEFAULT on JSON-mapped MEDIUMTEXT columns (MySQL 8 STRICT)', () => {
    const ddl = `tags_json TEXT NOT NULL DEFAULT '[]',\n  body_text TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL DEFAULT 'active'`;
    const mysql = sqliteDdlToMysql(ddl);
    expect(mysql).toMatch(/tags_json\s+MEDIUMTEXT\s+NOT\s+NULL/i);
    expect(mysql).not.toMatch(/tags_json\s+MEDIUMTEXT\s+NOT\s+NULL\s+DEFAULT/i);
    expect(mysql).toMatch(/status\s+VARCHAR\(100\)\s+NOT\s+NULL\s+DEFAULT\s+'active'/i);
  });

  it('stripMysqlIllegalTextBlobDefaults is idempotent on clean DDL', () => {
    expect(stripMysqlIllegalTextBlobDefaults(`x MEDIUMTEXT NOT NULL,\n`)).toContain('MEDIUMTEXT NOT NULL');
  });
});
