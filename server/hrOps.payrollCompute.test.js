/**
 * `computePayrollRun` writes one line per staff member against a schema whose
 * optional columns depend on which migrations have run. It used to discover
 * that by attempting an UPDATE per staff member and swallowing the failure;
 * now the columns are probed once and folded into the INSERT, so these tests
 * pin the statement shape on both a migrated and a legacy schema.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computePayrollRun } from './hrOps.js';
import { resetSchemaCache } from './schemaCache.js';

const OPTIONAL_LINE_COLUMNS = [
  'salary_version_id',
  'loan_deduction_ngn',
  'disciplinary_deduction_ngn',
  'pension_employer_ngn',
  'pay_hold',
  'hold_reason',
];

const PAID = {
  user_id: 'U-PAID',
  branch_id: 'BR1',
  designation_id: null,
  base_salary_ngn: 100_000,
  housing_allowance_ngn: 0,
  transport_allowance_ngn: 0,
  paye_tax_ngn: 5_000,
  payroll_group: 'branch_ops',
  profile_extra_json: '{}',
};

const HELD = {
  ...PAID,
  user_id: 'U-HELD',
  base_salary_ngn: 80_000,
  paye_tax_ngn: 0,
  profile_extra_json: JSON.stringify({
    employmentMeta: { salaryStatus: 'held', payrollHoldReason: 'Under query' },
  }),
};

/**
 * @param {{ lineColumns: string[], recoveriesTable: boolean }} schema
 */
function runWithSchema(schema) {
  const calls = [];
  const answer = (sql, args) => {
    if (/^SELECT 1 FROM sqlite_master WHERE type='table' AND name=\?$/.test(sql)) {
      if (args[0] === 'hr_payroll_line_recoveries') return schema.recoveriesTable ? { 1: 1 } : undefined;
      return { 1: 1 };
    }
    if (sql.startsWith('SELECT 1 FROM sqlite_master')) return { 1: 1 };
    if (sql.startsWith('PRAGMA table_info(hr_payroll_lines)')) {
      return schema.lineColumns.map((name) => ({ name }));
    }
    if (sql.startsWith('PRAGMA table_info(hr_payroll_line_loans)')) return [{ name: 'obligation_account_id' }];
    if (sql.startsWith('PRAGMA table_info')) return [];
    if (sql.includes('FROM hr_payroll_runs WHERE id')) {
      return { id: 'RUN1', status: 'draft', period_yyyymm: '202609' };
    }
    if (sql.includes('FROM hr_staff_profiles p JOIN app_users u')) return [PAID, HELD];
    return [];
  };
  const db = {
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      const record = (op, args) => {
        calls.push({ op, sql: norm, args });
        return answer(norm, args);
      };
      return {
        all: (...args) => {
          const v = record('all', args);
          return Array.isArray(v) ? v : [];
        },
        get: (...args) => {
          const v = record('get', args);
          return Array.isArray(v) ? undefined : v;
        },
        run: (...args) => {
          record('run', args);
          return { changes: 1 };
        },
      };
    },
  };
  const result = computePayrollRun(db, 'RUN1');
  const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO hr_payroll_lines'));
  const columns = inserts.length ? inserts[0].sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim()) : [];
  const valueOf = (insert, column) => insert.args[columns.indexOf(column)];
  return { result, calls, inserts, columns, valueOf };
}

describe('computePayrollRun on a fully migrated schema', () => {
  beforeEach(() => resetSchemaCache());

  it('writes one INSERT per staff member and no follow-up UPDATE', () => {
    const { result, calls, inserts } = runWithSchema({
      lineColumns: OPTIONAL_LINE_COLUMNS,
      recoveriesTable: true,
    });
    expect(result.ok).toBe(true);
    expect(result.headcount).toBe(2);
    expect(inserts).toHaveLength(2);
    expect(calls.filter((c) => c.sql.startsWith('UPDATE hr_payroll_lines'))).toHaveLength(0);
  });

  it('binds exactly as many values as it names columns', () => {
    const { inserts, columns } = runWithSchema({
      lineColumns: OPTIONAL_LINE_COLUMNS,
      recoveriesTable: true,
    });
    for (const insert of inserts) expect(insert.args).toHaveLength(columns.length);
    expect(columns.slice(9)).toEqual(OPTIONAL_LINE_COLUMNS);
  });

  it('zeroes net pay for held salary and records the reason', () => {
    const { inserts, valueOf } = runWithSchema({
      lineColumns: OPTIONAL_LINE_COLUMNS,
      recoveriesTable: true,
    });
    const [paid, held] = inserts;
    expect(valueOf(held, 'net_ngn')).toBe(0);
    expect(valueOf(held, 'pay_hold')).toBe(1);
    expect(valueOf(held, 'hold_reason')).toBe('Under query');
    expect(valueOf(paid, 'pay_hold')).toBe(0);
    expect(valueOf(paid, 'hold_reason')).toBeNull();
  });

  it('carries the earnings and statutory figures onto the line', () => {
    const { inserts, valueOf } = runWithSchema({
      lineColumns: OPTIONAL_LINE_COLUMNS,
      recoveriesTable: true,
    });
    const [paid] = inserts;
    expect(valueOf(paid, 'gross_ngn')).toBe(100_000);
    expect(valueOf(paid, 'tax_ngn')).toBe(5_000);
    expect(valueOf(paid, 'pension_ngn')).toBe(8_000);
    expect(valueOf(paid, 'pension_employer_ngn')).toBe(10_000);
    expect(valueOf(paid, 'net_ngn')).toBe(100_000 - 5_000 - 8_000);
  });
});

describe('computePayrollRun on a legacy schema', () => {
  beforeEach(() => resetSchemaCache());

  it('names only the columns that exist', () => {
    const { result, inserts, columns } = runWithSchema({ lineColumns: [], recoveriesTable: false });
    expect(result.ok).toBe(true);
    expect(columns).toEqual([
      'run_id',
      'user_id',
      'gross_ngn',
      'bonus_ngn',
      'attendance_deduction_ngn',
      'other_deduction_ngn',
      'tax_ngn',
      'pension_ngn',
      'net_ngn',
    ]);
    for (const insert of inserts) expect(insert.args).toHaveLength(columns.length);
  });

  it('keeps the computed net when there is no pay_hold column to honour', () => {
    const { inserts, valueOf } = runWithSchema({ lineColumns: [], recoveriesTable: false });
    const held = inserts[1];
    expect(valueOf(held, 'net_ngn')).toBe(80_000 - 0 - 6_400);
  });

  it('touches the recoveries table only when it exists', () => {
    const { calls } = runWithSchema({ lineColumns: [], recoveriesTable: false });
    const writes = calls.filter((c) => c.op !== 'get' && c.sql.includes('hr_payroll_line_recoveries'));
    expect(writes).toEqual([]);
  });
});

describe('computePayrollRun guards', () => {
  beforeEach(() => resetSchemaCache());

  it('refuses a run that is not a draft', () => {
    const db = {
      prepare: (sql) => ({
        all: () => [],
        get: () =>
          String(sql).includes('hr_payroll_runs')
            ? { id: 'RUN1', status: 'locked', period_yyyymm: '202609' }
            : { 1: 1 },
        run: () => ({ changes: 0 }),
      }),
    };
    expect(computePayrollRun(db, 'RUN1')).toEqual({
      ok: false,
      error: 'Only draft runs can be recomputed.',
    });
  });
});
