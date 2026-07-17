import { describe, it, expect } from 'vitest';
import { adaptExecSqlForMysql, expandNamedBindParams } from './mysqlSqlAdapt.js';

describe('expandNamedBindParams', () => {
  it('expands @named placeholders to positional ? for MySQL', () => {
    const { sql, args } = expandNamedBindParams(
      'INSERT INTO hr_staff_profiles (user_id, branch_id) VALUES (@user_id, @branch_id)',
      [{ user_id: 'USR-1', branch_id: 'BR-KD' }]
    );
    expect(sql).toBe('INSERT INTO hr_staff_profiles (user_id, branch_id) VALUES (?, ?)');
    expect(args).toEqual(['USR-1', 'BR-KD']);
  });

  it('leaves positional SQL unchanged', () => {
    const { sql, args } = expandNamedBindParams('SELECT id FROM app_users WHERE id = ?', ['USR-1']);
    expect(sql).toBe('SELECT id FROM app_users WHERE id = ?');
    expect(args).toEqual(['USR-1']);
  });
});

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

describe('adaptExecSqlForMysql index IFNULL expressions', () => {
  it('strips IFNULL from CREATE UNIQUE INDEX but leaves SELECT IFNULL alone', () => {
    const idx = adaptExecSqlForMysql(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_rooms_scope_slug_unique
       ON workspace_rooms(scope_kind, IFNULL(branch_id, ''), slug)`
    );
    expect(idx).not.toMatch(/IFNULL/i);
    expect(idx).toMatch(/ON workspace_rooms\(scope_kind, branch_id, slug\)/i);

    const select = adaptExecSqlForMysql(`SELECT IFNULL(branch_id, '') AS b FROM workspace_rooms`);
    expect(select).toContain(`IFNULL(branch_id, '')`);
  });
});
