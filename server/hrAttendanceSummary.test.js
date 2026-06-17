/**
 * Employee self-service attendance summary — unit tests with mock DB (no MySQL).
 */
import { describe, expect, it } from 'vitest';
import { getHrAttendanceSummaryForUser } from './hrOps.js';

const USER = 'USR-STAFF';
const BRANCH = 'BR-KD';
const PERIOD = '202606';
const NOW = '2026-06-15T10:00:00.000Z';

function makeAttendanceDb(overrides = {}) {
  const profile = { branchId: BRANCH, base_salary_ngn: 220000 };
  const dailyRolls = overrides.dailyRolls || [];
  const uploads = overrides.uploads || [];
  const exceptions = overrides.exceptions || [];

  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master') || s.includes('hr_staff_profiles') && s.includes('COUNT')) {
        return { get: () => ({ 1: 1 }) };
      }
      return {
        get(...args) {
          if (s.includes('branch_id AS branchId FROM hr_staff_profiles')) {
            return profile;
          }
          if (s.includes('base_salary_ngn FROM hr_staff_profiles')) {
            return { base_salary_ngn: profile.base_salary_ngn };
          }
          if (s.includes('FROM hr_attendance_uploads') && s.includes('period_yyyymm')) {
            return uploads[0] || undefined;
          }
          return undefined;
        },
        all(...args) {
          if (s.includes('FROM hr_daily_roll_calls') && s.includes('day_iso')) {
            return dailyRolls;
          }
          if (s.includes('FROM hr_daily_roll_calls') && s.includes('substr')) {
            return dailyRolls.map((d) => ({ rows_json: d.rows_json }));
          }
          if (s.includes(`kind = 'attendance_exception'`) && s.includes('approved')) {
            return exceptions.filter((e) => e.status === 'approved');
          }
          if (s.includes(`kind = 'attendance_exception'`) && s.includes('ORDER BY')) {
            return exceptions;
          }
          if (s.includes('FROM hr_leave_requests') || s.includes('approved_leave')) {
            return [];
          }
          return [];
        },
      };
    },
  };
}

describe('getHrAttendanceSummaryForUser', () => {
  it('rejects unknown employee', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('sqlite_master')) return { get: () => ({ 1: 1 }) };
        return {
          get: () => undefined,
          all: () => [],
        };
      },
    };
    const r = getHrAttendanceSummaryForUser(db, USER, PERIOD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/employment record/i);
  });

  it('rejects invalid payroll period', () => {
    const db = makeAttendanceDb();
    const r = getHrAttendanceSummaryForUser(db, USER, 'bad-period');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YYYYMM/i);
  });

  it('aggregates daily roll, monthly upload, and payroll deduction', () => {
    const db = makeAttendanceDb({
      dailyRolls: [
        {
          dayIso: '2026-06-03',
          rows_json: JSON.stringify([{ userId: USER, status: 'late', remark: 'Traffic' }]),
        },
      ],
      uploads: [
        {
          rows_json: JSON.stringify([{ userId: USER, absentDays: 2 }]),
        },
      ],
    });

    const r = getHrAttendanceSummaryForUser(db, USER, PERIOD);
    expect(r.ok).toBe(true);
    expect(r.periodYyyymm).toBe(PERIOD);
    expect(r.lateDays).toBe(1);
    expect(r.absentDays).toBe(2);
    expect(r.monthlyAbsentDays).toBe(2);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].status).toBe('late');
    const daily = Math.round(220000 / 22);
    expect(r.deductionNgn).toBe((2 + 1) * daily);
  });

  it('approved attendance exception waives one late day from deduction', () => {
    const db = makeAttendanceDb({
      dailyRolls: [
        {
          dayIso: '2026-06-04',
          rows_json: JSON.stringify([{ userId: USER, status: 'late' }]),
        },
      ],
      exceptions: [
        {
          id: 'HRR-ATT-EX',
          status: 'approved',
          title: 'Late exception',
          createdAtIso: NOW,
          payload_json: JSON.stringify({ dayIso: '2026-06-04', type: 'late', reason: 'Official duty' }),
        },
      ],
    });

    const r = getHrAttendanceSummaryForUser(db, USER, PERIOD);
    expect(r.ok).toBe(true);
    expect(r.lateDays).toBe(1);
    expect(r.lateExceptions).toBe(1);
    expect(r.deductionNgn).toBe(0);
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0].type).toBe('late');
  });
});
