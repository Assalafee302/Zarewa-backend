import { describe, it, expect } from 'vitest';
import {
  adaptExecSqlForMysql,
  adaptSqlForMysql,
  clearAdaptSqlCache,
  expandNamedBindParams,
} from './mysqlSqlAdapt.js';

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

describe('adaptSqlForMysql CAST REAL', () => {
  it('rewrites CAST(... AS REAL) to DOUBLE for MariaDB', () => {
    const { sql } = adaptSqlForMysql(
      `UPDATE material_pricing_sheet_rows SET gauge_customer_label = ?
       WHERE ABS(CAST(gauge_mm AS REAL) - ?) < 0.001`,
      ['0.35mm', 0.28]
    );
    expect(sql).toMatch(/CAST\(gauge_mm AS DOUBLE\)/i);
    expect(sql).not.toMatch(/AS REAL/i);
  });
});

describe('adaptSqlForMysql plan cache', () => {
  it('reuses the rewrite but never reuses bind values across calls', () => {
    clearAdaptSqlCache();
    const sql = 'SELECT * FROM quotations WHERE branch_id = ? LIMIT ?';
    const first = adaptSqlForMysql(sql, ['BR-KD', 600]);
    const second = adaptSqlForMysql(sql, ['BR-YL', 50]);
    expect(second.sql).toBe(first.sql);
    expect(first.args).toEqual(['BR-KD', 600]);
    expect(second.args).toEqual(['BR-YL', 50]);
    /* Callers mutate the returned array — each call must own its copy. */
    expect(second.args).not.toBe(first.args);
  });

  it('keeps SQL-derived args correct on a cache hit', () => {
    clearAdaptSqlCache();
    const cold = adaptSqlForMysql('PRAGMA table_info(quotations)', []);
    const warm = adaptSqlForMysql('PRAGMA table_info(quotations)', []);
    expect(cold.sql).toContain('INFORMATION_SCHEMA.COLUMNS');
    expect(warm.sql).toBe(cold.sql);
    expect(warm.args).toEqual(['quotations']);
    expect(warm.args).not.toBe(cold.args);
  });

  it('does not collide between different tables', () => {
    clearAdaptSqlCache();
    const a = adaptSqlForMysql('PRAGMA table_info(customers)', []);
    const b = adaptSqlForMysql('PRAGMA table_info(suppliers)', []);
    expect(a.args).toEqual(['customers']);
    expect(b.args).toEqual(['suppliers']);
  });

  it('produces identical output cached and uncached', () => {
    const samples = [
      "INSERT OR REPLACE INTO products (product_id, name) VALUES (?, ?)",
      "SELECT name FROM customers WHERE name = ? COLLATE NOCASE",
      "SELECT CAST(amount AS REAL) AS a FROM ledger_entries WHERE id = ?",
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_settings'",
    ];
    for (const s of samples) {
      clearAdaptSqlCache();
      const cold = adaptSqlForMysql(s, ['x', 'y']);
      const warm = adaptSqlForMysql(s, ['x', 'y']);
      expect(warm).toEqual(cold);
    }
  });
});
