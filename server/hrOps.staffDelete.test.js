import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord } from './auth.js';
import { bulkDeleteHrStaffAccounts, deleteHrStaffAccount, registerNewStaffWithProfile } from './hrOps.js';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';

describe('staff permanent delete', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;
  let actor;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    const created = createAppUserRecord(db, {
      username: 'hr.admin',
      displayName: 'HR Admin',
      password: 'Hr@123456!',
      roleKey: 'hr_admin',
    });
    actor = { id: created.userId, displayName: 'HR Admin', username: 'hr.admin' };
  });

  function registerStaff(suffix) {
    return registerNewStaffWithProfile(
      db,
      actor.id,
      {
        username: `staff.${suffix}`,
        displayName: `Staff ${suffix}`,
        password: 'Zarewa@123',
        roleKey: 'sales_staff',
        payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
        branchId: 'BR-KD',
        employeeNo: `ZAPKD${suffix}`,
        jobTitle: 'Sales Officer',
      },
      { skipProfileFetch: true }
    );
  }

  it('deletes one staff when the username is typed', () => {
    const created = registerStaff('701');
    expect(created.ok).toBe(true);
    const username = db.prepare(`SELECT username FROM app_users WHERE id = ?`).get(created.userId).username;
    const r = deleteHrStaffAccount(db, actor, created.userId, {
      reason: 'Registered in error',
      confirmUsername: username,
    });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(created.userId)).toBeUndefined();
  });

  it('refuses single delete without the username confirmation', () => {
    const created = registerStaff('702');
    expect(created.ok).toBe(true);
    const r = deleteHrStaffAccount(db, actor, created.userId, {
      reason: 'Registered in error',
      confirmUsername: 'wrong',
    });
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(created.userId)).toBeTruthy();
  });

  it('deletes several staff when DELETE is typed', () => {
    const a = registerStaff('703');
    const b = registerStaff('704');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const r = bulkDeleteHrStaffAccounts(db, actor, {
      userIds: [a.userId, b.userId],
      reason: 'Test logins',
      confirmPhrase: 'DELETE',
    });
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(2);
    expect(r.failed).toBe(0);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(a.userId)).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(b.userId)).toBeUndefined();
  });

  it('refuses bulk delete without typing DELETE', () => {
    const created = registerStaff('705');
    const r = bulkDeleteHrStaffAccounts(db, actor, {
      userIds: [created.userId],
      reason: 'Test logins',
      confirmPhrase: 'remove',
    });
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(created.userId)).toBeTruthy();
  });

  it('does not remove a protected admin and still deletes the rest', () => {
    const admin = createAppUserRecord(db, {
      username: 'sys.admin',
      displayName: 'System Admin',
      password: 'Admin@123456!',
      roleKey: 'admin',
    });
    const staff = registerStaff('706');
    const r = bulkDeleteHrStaffAccounts(db, actor, {
      userIds: [admin.userId, staff.userId],
      reason: 'Cleanup',
      confirmPhrase: 'delete',
    });
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0].error).toMatch(/protected/i);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(admin.userId)).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(staff.userId)).toBeUndefined();
  });

  it('blocks deleting someone who still has direct reports', () => {
    const manager = registerStaff('707');
    const report = registerStaff('708');
    expect(manager.ok).toBe(true);
    expect(report.ok).toBe(true);
    db.prepare(`UPDATE hr_staff_profiles SET line_manager_user_id = ? WHERE user_id = ?`).run(
      manager.userId,
      report.userId
    );
    const r = bulkDeleteHrStaffAccounts(db, actor, {
      userIds: [manager.userId],
      reason: 'Cleanup',
      confirmPhrase: 'DELETE',
    });
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.errors[0].error).toMatch(/report/i);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(manager.userId)).toBeTruthy();
  });
});
