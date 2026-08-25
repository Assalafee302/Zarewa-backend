import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord } from './auth.js';
import { registerNewStaffWithProfile } from './hrOps.js';
import { mergeHrStaffUserInto } from './hrStaffDuplicateCleanup.js';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';

describe('merge named staff into admin login', () => {
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

  function registerNamed(suffix) {
    return registerNewStaffWithProfile(
      db,
      actor.id,
      {
        username: `person.${suffix}`,
        displayName: `Amina ${suffix}`,
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

  it('absorbs a named staff file into the admin login and copies the real name', () => {
    const admin = createAppUserRecord(db, {
      username: 'admin',
      displayName: 'admin',
      password: 'Admin@12345',
      roleKey: 'admin',
    });
    expect(admin.ok).toBe(true);
    const named = registerNamed('881');
    expect(named.ok).toBe(true);

    const r = mergeHrStaffUserInto(db, named.userId, admin.userId, admin.userId);
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(named.userId)).toBeUndefined();
    const kept = db
      .prepare(`SELECT username, display_name AS displayName, role_key AS roleKey FROM app_users WHERE id = ?`)
      .get(admin.userId);
    expect(kept.username).toBe('admin');
    expect(kept.roleKey).toBe('admin');
    expect(kept.displayName).toBe('Amina 881');
    const profile = db
      .prepare(`SELECT user_id AS userId, employee_no AS employeeNo, job_title AS jobTitle FROM hr_staff_profiles WHERE user_id = ?`)
      .get(admin.userId);
    expect(profile?.employeeNo).toBe('ZAPKD881');
    expect(profile?.jobTitle).toBe('Sales Officer');
  });

  it('refuses to absorb the admin login into a named staff file', () => {
    const admin = createAppUserRecord(db, {
      username: 'admin.keep',
      displayName: 'admin',
      password: 'Admin@12345',
      roleKey: 'admin',
    });
    const named = registerNamed('882');
    expect(admin.ok).toBe(true);
    expect(named.ok).toBe(true);
    const r = mergeHrStaffUserInto(db, admin.userId, named.userId, admin.userId);
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(admin.userId)).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM app_users WHERE id = ?`).get(named.userId)).toBeTruthy();
  });

  it('refuses to absorb the login you are signed in as', () => {
    const named = registerNamed('883');
    const other = registerNamed('884');
    expect(named.ok).toBe(true);
    expect(other.ok).toBe(true);
    const r = mergeHrStaffUserInto(db, named.userId, other.userId, named.userId);
    expect(r.ok).toBe(false);
  });
});
