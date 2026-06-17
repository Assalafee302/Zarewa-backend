import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { bulkDeleteZeroAuditUsers, listZeroAuditUserCandidates } from './userZeroAuditCleanup.js';
import { USER_HR_SUBJECT_DELETE_SPECS, tableHasColumn } from './hrUserOperationalCleanup.js';
import { hrTableExists } from './hrTableChecks.js';

describe('userZeroAuditCleanup', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-YL', 'YL', 'Yola')`).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES ('admin-other', 'admin.other', 'Admin Other', 'hash', 'admin', 'active', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
       VALUES ('u-unused-1', 'unused.staff', 'Unused Staff', 'hash', 'sales_staff', 'active', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title)
       VALUES ('u-unused-1', 'BR-YL', 'ZAPYL099', 'Sales Officer')`
    ).run();
    db.prepare(
      `INSERT INTO hr_requests (id, user_id, branch_id, kind, status, title, created_at_iso)
       VALUES ('req-unused-1', 'u-unused-1', 'BR-YL', 'leave', 'pending', 'Leave', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO hr_request_leave (request_id, leave_type, start_date_iso, end_date_iso, days_requested)
       VALUES ('req-unused-1', 'annual', '2026-01-01', '2026-01-03', 3)`
    ).run();
    db.prepare(
      `INSERT INTO hr_leave_balances (user_id, leave_type, period_yyyymm, opening_days, accrued_days, used_days, adjusted_days, closing_days, updated_at_iso)
       VALUES ('u-unused-1', 'annual', '202601', 0, 14, 0, 0, 14, ?)`
    ).run(now);
  });

  it('lists and deletes unused login with HR profile and leave rows', () => {
    const scan = listZeroAuditUserCandidates(db, { actorUserId: 'admin-other' });
    expect(scan.ok).toBe(true);
    expect(scan.candidates.some((c) => c.userId === 'u-unused-1')).toBe(true);

    const del = bulkDeleteZeroAuditUsers(db, { id: 'admin-other', displayName: 'Admin' }, {
      confirmPhrase: 'DELETE UNUSED LOGINS',
      dryRun: false,
    });
    expect(del.ok).toBe(true);
    expect(del.deleted.some((d) => d.userId === 'u-unused-1')).toBe(true);
    expect(del.failed.length).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM app_users WHERE id = 'u-unused-1'`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE user_id = 'u-unused-1'`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_request_leave`).get().c).toBe(0);
  });

  it('USER_HR_SUBJECT_DELETE_SPECS only reference existing columns', () => {
    for (const { table, column } of USER_HR_SUBJECT_DELETE_SPECS) {
      if (!hrTableExists(db, table)) continue;
      expect(tableHasColumn(db, table, column)).toBe(true);
    }
  });
});
