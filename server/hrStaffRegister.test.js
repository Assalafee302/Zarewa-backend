import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord } from './auth.js';
import { listHrUnlinkedAppUsers, payrollGroupForAppRole, registerExistingUserWithProfile, registerNewStaffWithProfile } from './hrOps.js';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';
import { BENEFICIARY_NO_LOGIN_ERROR, HR_PORTAL_ONLY_ROLE_KEY } from './hrStaffAccessPolicy.js';

describe('payrollGroupForAppRole', () => {
  it('maps portal-only logins to mining and other roles to branch staff', () => {
    expect(payrollGroupForAppRole(HR_PORTAL_ONLY_ROLE_KEY)).toBe(HR_PAYROLL_GROUPS.MINING);
    expect(payrollGroupForAppRole('sales_staff')).toBe(HR_PAYROLL_GROUPS.BRANCH_OPS);
    expect(payrollGroupForAppRole('admin')).toBe(HR_PAYROLL_GROUPS.BRANCH_OPS);
  });
});

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

describe('registerExistingUserWithProfile', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;
  let actorId;
  let loginUserId;

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
    const login = createAppUserRecord(db, {
      username: 'store.keeper',
      displayName: 'Store Keeper',
      password: 'User@123456!',
      roleKey: 'operations_officer',
    });
    loginUserId = login.userId;
  });

  it('lists active logins that have no HR profile', () => {
    const listed = listHrUnlinkedAppUsers(db, {});
    expect(listed.some((u) => u.userId === loginUserId)).toBe(true);
    expect(listed.some((u) => u.username === 'store.keeper')).toBe(true);
  });

  it('attaches an HR profile to the existing login without creating another user', () => {
    const before = db.prepare(`SELECT COUNT(*) AS c FROM app_users`).get();
    const r = registerExistingUserWithProfile(db, actorId, {
      existingUserId: loginUserId,
      displayName: 'Store Keeper',
      payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
      branchId: 'BR-KD',
      employeeNo: 'ZAPKD610',
      jobTitle: 'Store keeper',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(loginUserId);
    expect(r.attachedExisting).toBe(true);
    const after = db.prepare(`SELECT COUNT(*) AS c FROM app_users`).get();
    expect(after.c).toBe(before.c);
    const username = db.prepare(`SELECT username, role_key AS roleKey FROM app_users WHERE id = ?`).get(loginUserId);
    expect(username.username).toBe('store.keeper');
    expect(username.roleKey).toBe('operations_officer');
    const profile = db.prepare(`SELECT employee_no, job_title FROM hr_staff_profiles WHERE user_id = ?`).get(loginUserId);
    expect(profile.employee_no).toBe('ZAPKD610');
    expect(profile.job_title).toBe('Store keeper');
    expect(listHrUnlinkedAppUsers(db, {}).some((u) => u.userId === loginUserId)).toBe(false);
  });

  it('routes registerNewStaffWithProfile to attach when existingUserId is set', () => {
    const r = registerNewStaffWithProfile(db, actorId, {
      existingUserId: loginUserId,
      displayName: 'Store Keeper',
      payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
      branchId: 'BR-KD',
      jobTitle: 'Store keeper',
    });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(loginUserId);
    expect(r.attachedExisting).toBe(true);
  });

  it('rejects a second profile on the same login', () => {
    const first = registerExistingUserWithProfile(db, actorId, {
      existingUserId: loginUserId,
      payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
      branchId: 'BR-KD',
      jobTitle: 'Store keeper',
    });
    expect(first.ok).toBe(true);
    const second = registerExistingUserWithProfile(db, actorId, {
      existingUserId: loginUserId,
      payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
      branchId: 'BR-KD',
      jobTitle: 'Store keeper',
    });
    expect(second.ok).toBe(false);
    expect(second.code).toBe('HR_PROFILE_EXISTS');
  });

  it('rejects scholarship payroll group on an existing login', () => {
    const r = registerExistingUserWithProfile(db, actorId, {
      existingUserId: loginUserId,
      payrollGroup: HR_PAYROLL_GROUPS.SCHOLARSHIP,
      branchId: 'BR-KD',
      jobTitle: 'Student',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(BENEFICIARY_NO_LOGIN_ERROR);
  });
});
