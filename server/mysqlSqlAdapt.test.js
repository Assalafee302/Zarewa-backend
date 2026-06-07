import { describe, it, expect } from 'vitest';
import { adaptExecSqlForMysql } from './mysqlSqlAdapt.js';

describe('adaptExecSqlForMysql reserved column names', () => {
  it('escapes `key` column in CREATE TABLE for MariaDB', () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS hr_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at_iso TEXT
    );
    `;
    const mysql = adaptExecSqlForMysql(sql);
    expect(mysql).toContain('`key` VARCHAR(128) PRIMARY KEY');
    expect(mysql).toContain('value_json MEDIUMTEXT NOT NULL');
    expect(mysql).not.toMatch(/\n\s+key VARCHAR/i);
  });
});
