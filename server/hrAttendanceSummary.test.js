/**
 * Employee self-service attendance summary — roll, upload, exceptions, deductions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { getHrAttendanceSummaryForUser } from './hrOps.js';

const mysqlOk = isMysqlAvailableForTests();
const PERIOD = '202606';
const NOW = '2026-06-15T10:00:00.000Z';

describe.skipIf(!mysqlOk)('getHrAttendanceSummaryForUser', () => {
  let db;
  let userId;
  let branchId;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const staff = db
      .prepare(
        `SELECT u.id AS userId, p.branch_id AS branchId
         FROM app_users u
         INNER JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.username = 'sales.staff'
         LIMIT 1`
      )
      .get();
    expect(staff?.userId).toBeTruthy();
    userId = staff.userId;
    branchId = staff.branchId;
    db.prepare(`UPDATE hr_staff_profiles SET base_salary_ngn = 220000 WHERE user_id = ?`).run(userId);
  });

  afterEach(() => {
    db?.close();
  });

  it('rejects unknown employee', () => {
    const r = getHrAttendanceSummaryForUser(db, 'USR-NOPE', PERIOD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/employment record/i);
  });

  it('rejects invalid payroll period', () => {
    const r = getHrAttendanceSummaryForUser(db, userId, 'not-a-period');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YYYYMM/i);
  });

  it('aggregates daily roll, monthly upload, and payroll deduction', () => {
    db.prepare(
      `INSERT INTO hr_daily_roll_calls (id, branch_id, day_iso, rows_json, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'DRC-TEST-1',
      branchId,
      '2026-06-03',
      JSON.stringify([{ userId, status: 'late', remark: 'Traffic' }]),
      NOW,
      NOW
    );
    db.prepare(
      `INSERT INTO hr_attendance_uploads (id, branch_id, period_yyyymm, rows_json, created_at_iso)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      'ATT-UP-1',
      branchId,
      PERIOD,
      JSON.stringify([{ userId, absentDays: 2 }]),
      NOW
    );

    const r = getHrAttendanceSummaryForUser(db, userId, PERIOD);
    expect(r.ok).toBe(true);
    expect(r.periodYyyymm).toBe(PERIOD);
    expect(r.branchId).toBe(branchId);
    expect(r.lateDays).toBe(1);
    expect(r.absentDays).toBe(2);
    expect(r.monthlyAbsentDays).toBe(2);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].status).toBe('late');
    const daily = Math.round(220000 / 22);
    expect(r.deductionNgn).toBe((2 + 1) * daily);
  });

  it('approved attendance exception waives one late day from deduction', () => {
    db.prepare(
      `INSERT INTO hr_daily_roll_calls (id, branch_id, day_iso, rows_json, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'DRC-TEST-2',
      branchId,
      '2026-06-04',
      JSON.stringify([{ userId, status: 'late' }]),
      NOW,
      NOW
    );
    db.prepare(
      `INSERT INTO hr_requests (
        id, user_id, branch_id, kind, status, title, payload_json, created_at_iso
      ) VALUES (?, ?, ?, 'attendance_exception', 'approved', 'Late exception', ?, ?)`
    ).run(
      'HRR-ATT-EX',
      userId,
      branchId,
      JSON.stringify({ dayIso: '2026-06-04', type: 'late', reason: 'Official duty' }),
      NOW
    );

    const r = getHrAttendanceSummaryForUser(db, userId, PERIOD);
    expect(r.ok).toBe(true);
    expect(r.lateDays).toBe(1);
    expect(r.lateExceptions).toBe(1);
    expect(r.deductionNgn).toBe(0);
    expect(r.exceptions).toHaveLength(1);
    expect(r.exceptions[0].type).toBe('late');
  });

  it('GET /api/hr/me/attendance-summary works for sales staff self-service', async () => {
    const app = createApp(db);
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'sales.staff', password: 'Sales@123' });
    expect(login.status).toBe(200);

    const res = await agent.get(`/api/hr/me/attendance-summary?periodYyyymm=${PERIOD}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.periodYyyymm).toBe(PERIOD);
    expect(Array.isArray(res.body.days)).toBe(true);
  });
});
