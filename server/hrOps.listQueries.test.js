/**
 * Query-shape cover for the HR read paths that fan out over a staff list.
 * These used to scale with the number of staff on screen — one salary-matrix
 * query per row, plus a full `hr_requests` materialisation per list — so the
 * assertions here are about how many queries run, not just the values returned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { enrichHrStaffListRows } from './hrOps.js';
import { resetSchemaCache } from './schemaCache.js';

/** Minimal db stand-in: answers by pattern and records every statement. */
function fakeDb(answers = {}) {
  const calls = [];
  const answer = (sql) => {
    for (const [pattern, value] of Object.entries(answers)) {
      if (sql.includes(pattern)) return value;
    }
    return null;
  };
  const db = {
    calls,
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      const record = (op, args) => {
        calls.push({ op, sql: norm, args });
        return answer(norm);
      };
      return {
        all: (...args) => record('all', args) ?? [],
        get: (...args) => {
          const v = record('get', args);
          return Array.isArray(v) ? v[0] : v;
        },
        run: (...args) => {
          record('run', args);
          return { changes: 1 };
        },
      };
    },
  };
  return db;
}

const MATRIX_ROW = {
  payrollGroup: 'branch_ops',
  salaryLevel: 3,
  salaryStep: 1,
  baseSalaryNgn: 100_000,
  housingAllowanceNgn: 20_000,
  transportAllowanceNgn: 10_000,
};

function staffRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    userId: `U${i}`,
    displayName: `Staff ${i}`,
    branchId: 'BR1',
    payrollGroup: 'branch_ops',
    salaryLevel: 3,
    salaryStep: 1,
    baseSalaryNgn: 150_000,
    employeeNo: `E${i}`,
    dateJoinedIso: '2020-01-01',
    jobTitle: 'Officer',
    department: 'Ops',
  }));
}

function build(overrides = {}) {
  return fakeDb({
    "SELECT 1 FROM sqlite_master": { 1: 1 },
    'FROM hr_policy_acknowledgements': [],
    'FROM hr_requests': [],
    'FROM hr_salary_matrix': [MATRIX_ROW],
    'FROM app_users WHERE id IN': [],
    ...overrides,
  });
}

const countMatching = (db, pattern) => db.calls.filter((c) => c.sql.includes(pattern)).length;

describe('enrichHrStaffListRows query shape', () => {
  beforeEach(() => resetSchemaCache());

  it('reads the salary matrix once however many staff are listed', () => {
    const db = build();
    enrichHrStaffListRows(db, staffRows(50));
    expect(countMatching(db, 'FROM hr_salary_matrix')).toBe(1);
  });

  it('asks for overdue requests once, scoped to the listed staff', () => {
    const db = build();
    enrichHrStaffListRows(db, staffRows(3));
    const requestCalls = db.calls.filter((c) => c.sql.includes('FROM hr_requests'));
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0].sql).toContain('SELECT DISTINCT user_id');
    /* No join and no payload column: the old version built every request object. */
    expect(requestCalls[0].sql).not.toContain('JOIN app_users');
    expect(requestCalls[0].sql).not.toContain('payload_json');
    expect(requestCalls[0].args).toEqual(expect.arrayContaining(['U0', 'U1', 'U2']));
  });

  it('flags the staff whose request has been pending past the SLA', () => {
    const db = build({ 'FROM hr_requests': [{ user_id: 'U1' }] });
    const out = enrichHrStaffListRows(db, staffRows(3));
    expect(out.map((s) => s.complianceBadges.overdueReview)).toEqual([false, true, false]);
  });

  it('marks handbook acknowledgement per staff member', () => {
    const db = build({
      'FROM hr_policy_acknowledgements': [{ user_id: 'U2', accepted_at_iso: '2026-01-01T00:00:00.000Z' }],
    });
    const out = enrichHrStaffListRows(db, staffRows(3));
    expect(out.map((s) => s.complianceBadges.handbookAcknowledged)).toEqual([false, false, true]);
  });

  it('resolves compensation against the preloaded matrix row', () => {
    const db = build();
    const [first] = enrichHrStaffListRows(db, staffRows(1));
    expect(first.compensation.matrixTotalNgn).toBe(130_000);
    expect(first.compensation.actualBaseNgn).toBe(150_000);
    expect(first.compensation.aboveMatrix).toBe(true);
  });

  it('skips the enrichment queries entirely for an empty list', () => {
    const db = build();
    expect(enrichHrStaffListRows(db, [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('leaves the request and matrix reads out of the lightweight directory path', () => {
    const db = build();
    enrichHrStaffListRows(db, staffRows(20), { lightweight: true });
    expect(countMatching(db, 'FROM hr_requests')).toBe(0);
    expect(countMatching(db, 'FROM hr_salary_matrix')).toBe(0);
  });
});
