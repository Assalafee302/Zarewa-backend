import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { resetHrBranchOperationalData } from './hrAdminDataResetOps.js';
import { runMigrations } from './migrate.js';

describe('hrAdminDataResetOps', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-YL', 'YL', 'Yola')`).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, role_key, status, created_at_iso)
       VALUES ('u-staff-1', 'staff.one', 'Staff One', 'sales_staff', 'active', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title)
       VALUES ('u-staff-1', 'BR-YL', 'ZAPYL001', 'Sales Officer')`
    ).run();
    db.prepare(
      `INSERT INTO hr_requests (id, user_id, branch_id, kind, status, title, created_at_iso)
       VALUES ('req-1', 'u-staff-1', 'BR-YL', 'leave', 'pending', 'Annual leave', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO hr_request_leave (request_id, leave_type, start_date_iso, end_date_iso, days_requested)
       VALUES ('req-1', 'annual', '2026-01-01', '2026-01-05', 5)`
    ).run();
  });

  it('clears hr_request_leave via request_id without unknown column errors', () => {
    const r = resetHrBranchOperationalData(db, 'BR-YL');
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_request_leave`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_requests`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE branch_id = 'BR-YL'`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM app_users WHERE id = 'u-staff-1'`).get().c).toBe(1);
  });
});
