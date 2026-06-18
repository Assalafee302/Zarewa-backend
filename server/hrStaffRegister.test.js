import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord } from './auth.js';
import { registerNewStaffWithProfile } from './hrOps.js';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';
import { BENEFICIARY_NO_LOGIN_ERROR } from './hrStaffAccessPolicy.js';

describe('registerNewStaffWithProfile beneficiary policy', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;
  let actorId;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    const actor = createAppUserRecord(db, {
      username: 'hr.admin',
      displayName: 'HR Admin',
      password: 'Hr@123456!',
      roleKey: 'hr_admin',
    });
    actorId = actor.userId;
  });

  it('rejects registration for scholarship payroll group', () => {
    const r = registerNewStaffWithProfile(db, actorId, {
      username: 'child.one',
      displayName: 'Child One',
      password: 'Zarewa@123',
      roleKey: 'hr_portal_only',
      payrollGroup: HR_PAYROLL_GROUPS.SCHOLARSHIP,
      employeeNo: 'ZAPKD501',
      jobTitle: 'Student',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(BENEFICIARY_NO_LOGIN_ERROR);
  });

  it('rejects registration for domestic payroll group', () => {
    const r = registerNewStaffWithProfile(db, actorId, {
      username: 'driver.home',
      displayName: 'Home Driver',
      password: 'Zarewa@123',
      payrollGroup: HR_PAYROLL_GROUPS.DOMESTIC,
      employeeNo: 'ZAPKD502',
      jobTitle: 'Driver',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(BENEFICIARY_NO_LOGIN_ERROR);
  });

  it('allows branch staff registration', () => {
    const r = registerNewStaffWithProfile(db, actorId, {
      username: 'staff.new',
      displayName: 'New Staff',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
      payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
      branchId: 'BR-KD',
      employeeNo: 'ZAPKD503',
      jobTitle: 'Sales Officer',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBeTruthy();
  });
});
