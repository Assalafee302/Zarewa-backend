import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import {
  createAppUserRecord,
  ensureHrSelfServicePermissions,
  loginWithPassword,
  permissionsForRole,
} from './auth.js';

describe('ensureHrSelfServicePermissions', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
  });

  it('grants My Profile permissions when user has a linked HR staff profile', () => {
    const created = createAppUserRecord(db, {
      username: 'douglas.yakubu',
      displayName: 'Douglas Yakubu',
      password: 'Zarewa@123',
      roleKey: 'viewer',
    });
    expect(created.ok).toBe(true);
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title, self_service_eligible)
       VALUES (?, 'BR-KD', 'ZAPKD042', 'Production Officer', 0)`
    ).run(created.userId);

    const perms = permissionsForRole('viewer');
    expect(perms).not.toContain('hr.self');
    ensureHrSelfServicePermissions(perms, db, created.userId);
    expect(perms).toContain('hr.self');
    expect(perms).toContain('hr.my_payslip.view');
    expect(perms).toContain('hr.my_leave.request');
  });

  it('does not grant My Profile for separated staff', () => {
    const created = createAppUserRecord(db, {
      username: 'ex.staff',
      displayName: 'Ex Staff',
      password: 'Zarewa@123',
      roleKey: 'viewer',
    });
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title, self_service_eligible, profile_extra_json)
       VALUES (?, 'BR-KD', 'ZAPKD043', 'Former Staff', 0, ?)`
    ).run(
      created.userId,
      JSON.stringify({ lifecycle: { separation: { status: 'separated' } } })
    );

    const perms = permissionsForRole('viewer');
    ensureHrSelfServicePermissions(perms, db, created.userId);
    expect(perms).not.toContain('hr.self');
  });

  it('enriches session user on login for ops staff with HR profile', () => {
    const created = createAppUserRecord(db, {
      username: 'floor.staff',
      displayName: 'Floor Staff',
      password: 'Zarewa@123',
      roleKey: 'viewer',
    });
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title)
       VALUES (?, 'BR-KD', 'ZAPKD044', 'Store Keeper')`
    ).run(created.userId);

    const login = loginWithPassword(db, 'floor.staff', 'Zarewa@123');
    expect(login.ok).toBe(true);
    expect(login.session?.permissions).toContain('hr.self');
    expect(login.session?.permissions).toContain('hr.my_payslip.view');
  });
});
