/**
 * Payroll used to re-read the same attendance upload and daily roll for every
 * staff member on the run. The sheet cache answers those questions once per
 * branch/period, so these tests pin both the values and the query count.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createAttendanceSheetCache } from './hrOps.js';
import { resetSchemaCache } from './schemaCache.js';

function fakeDb({
  upload = { rows_json: JSON.stringify([{ userId: 'U1', absentDays: 3 }, { userId: 'U2', absentDays: 1 }]) },
  rolls = [
    { rows_json: JSON.stringify([{ userId: 'U1', status: 'late' }, { userId: 'U2', status: 'present' }]) },
    { rows_json: JSON.stringify([{ userId: 'U1', status: 'late' }]) },
  ],
  holidays = [{ day_iso: '2026-09-01' }],
} = {}) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      const record = (op, args) => {
        calls.push({ op, sql: norm, args });
        if (norm.includes('FROM hr_attendance_uploads')) return upload;
        if (norm.includes('FROM hr_daily_roll_calls')) return rolls;
        if (norm.includes('FROM hr_public_holidays')) return holidays;
        return null;
      };
      return {
        all: (...args) => {
          const v = record('all', args);
          return Array.isArray(v) ? v : [];
        },
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

const countMatching = (db, pattern) => db.calls.filter((c) => c.sql.includes(pattern)).length;

describe('createAttendanceSheetCache', () => {
  beforeEach(() => resetSchemaCache());

  it('indexes absent and late days per person', () => {
    const sheets = createAttendanceSheetCache(fakeDb());
    expect(sheets.absentDaysFor('BR1', '202609', 'U1')).toBe(3);
    expect(sheets.absentDaysFor('BR1', '202609', 'U2')).toBe(1);
    expect(sheets.absentDaysFor('BR1', '202609', 'U-NONE')).toBe(0);
    expect(sheets.lateDaysFor('BR1', '202609', 'U1')).toBe(2);
    expect(sheets.lateDaysFor('BR1', '202609', 'U2')).toBe(0);
  });

  it('reads each sheet once however many staff are asked about', () => {
    const db = fakeDb();
    const sheets = createAttendanceSheetCache(db);
    for (const uid of ['U1', 'U2', 'U3', 'U1']) {
      sheets.absentDaysFor('BR1', '202609', uid);
      sheets.lateDaysFor('BR1', '202609', uid);
    }
    expect(countMatching(db, 'FROM hr_attendance_uploads')).toBe(1);
    expect(countMatching(db, 'FROM hr_daily_roll_calls')).toBe(1);
  });

  it('reads public holidays once across many leave segments', () => {
    const db = fakeDb();
    const sheets = createAttendanceSheetCache(db);
    expect(sheets.holidays()).toEqual(new Set(['2026-09-01']));
    expect(sheets.holidays()).toEqual(new Set(['2026-09-01']));
    expect(countMatching(db, 'FROM hr_public_holidays')).toBe(1);
  });

  it('ignores a non-array attendance payload instead of walking object keys', () => {
    const db = fakeDb({
      upload: { rows_json: JSON.stringify({ userId: 'U1', absentDays: 9 }) },
      rolls: [{ rows_json: JSON.stringify({ userId: 'U1', status: 'late' }) }],
    });
    const sheets = createAttendanceSheetCache(db);
    expect(sheets.absentDaysFor('BR1', '202609', 'U1')).toBe(0);
    expect(sheets.lateDaysFor('BR1', '202609', 'U1')).toBe(0);
  });

  it('does not scan daily rolls for a malformed period', () => {
    const db = fakeDb();
    const sheets = createAttendanceSheetCache(db);
    expect(sheets.lateDaysFor('BR1', 'bad', 'U1')).toBe(0);
    expect(countMatching(db, 'FROM hr_daily_roll_calls')).toBe(0);
  });
});
