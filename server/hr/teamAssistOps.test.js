import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../db.js';
import { runMigrations } from '../migrate.js';
import { createAppUserRecord, permissionsForRole } from '../auth.js';
import { createHrRequest, getHrMeProfile, getHrStaffOne } from '../hrOps.js';
import { HR_PAYROLL_GROUPS } from '../../shared/lib/hrStaffCohorts.js';
import {
  assertActorMayAssistStaff,
  createHrRequestForStaff,
  submitHrRequestForStaff,
  submitTeamStaffProfile,
  teamHrAssistCapabilities,
  updateTeamStaffProfile,
  userCanAssistTeamHr,
} from './teamAssistOps.js';

function insertStaff(db, { username, displayName, roleKey, branchId = 'BR-KD', employeeNo }) {
  const created = createAppUserRecord(db, {
    username,
    displayName,
    password: 'Zarewa@123',
    roleKey,
  });
  expect(created.ok).toBe(true);
  db.prepare(
    `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title, payroll_group, self_service_eligible)
     VALUES (?, ?, ?, 'Clerk', ?, 1)`
  ).run(created.userId, branchId, employeeNo, HR_PAYROLL_GROUPS.BRANCH_OPS);
  return { ...created, userId: created.userId };
}

describe('team HR assist', () => {
  /** @type {import('../db.js').ZarewaDatabase} */
  let db;
  let bm;
  let staff;
  let otherBranchStaff;
  let bmActor;
  let scope;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-YL', 'YL', 'Yola')`).run();
    bm = insertStaff(db, {
      username: 'bm.kaduna',
      displayName: 'Branch Manager',
      roleKey: 'sales_manager',
      employeeNo: 'ZAPKD100',
    });
    staff = insertStaff(db, {
      username: 'clerk.kd',
      displayName: 'Clerk Kaduna',
      roleKey: 'sales_staff',
      employeeNo: 'ZAPKD101',
    });
    otherBranchStaff = insertStaff(db, {
      username: 'clerk.yl',
      displayName: 'Clerk Yola',
      roleKey: 'sales_staff',
      branchId: 'BR-YL',
      employeeNo: 'ZAPYL201',
    });
    bmActor = {
      id: bm.userId,
      roleKey: 'sales_manager',
      permissions: permissionsForRole('sales_manager'),
    };
    scope = { viewAll: false, branchId: 'BR-KD', scopeMode: 'branch', actorUserId: bm.userId };
  });

  it('gives branch managers team assist without full HR', () => {
    expect(userCanAssistTeamHr(bmActor)).toBe(true);
    const caps = teamHrAssistCapabilities(bmActor);
    expect(caps.canAssistTeam).toBe(true);
    expect(caps.canUpdateTeamProfiles).toBe(true);
    expect(caps.canCreateTeamRequests).toBe(true);
    expect(caps.canMarkAttendance).toBe(true);
  });

  it('lets a branch manager update a branch staff profile', () => {
    const r = updateTeamStaffProfile(
      db,
      bmActor,
      staff.userId,
      {
        firstName: 'Amina',
        surname: 'Bello',
        phone: '08012345678',
        ninNumber: '12345678901',
        nextOfKinName: 'Musa Bello',
        nextOfKinPhone: '08087654321',
        nextOfKinRelationship: 'Spouse',
      },
      scope
    );
    expect(r.ok).toBe(true);
    const { hr } = getHrMeProfile(db, staff.userId);
    expect(hr?.profileExtra?.personal?.firstName).toBe('Amina');
    expect(hr?.ninNumber).toBe('12345678901');
    expect(hr?.nextOfKin?.name).toBe('Musa Bello');
    expect(hr).not.toHaveProperty('bvnNumber');
  });

  it('ignores salary fields on team assist updates', () => {
    const r = updateTeamStaffProfile(
      db,
      bmActor,
      staff.userId,
      { firstName: 'Amina', surname: 'Bello', baseSalaryNgn: 900000 },
      scope
    );
    expect(r.ok).toBe(true);
    const one = getHrStaffOne(db, staff.userId);
    expect(one?.baseSalaryNgn == null || Number(one.baseSalaryNgn) === 0).toBe(true);
  });

  it('rejects assist on another branch', () => {
    const gate = assertActorMayAssistStaff(db, bmActor, otherBranchStaff.userId, scope);
    expect(gate.ok).toBe(false);
    const r = updateTeamStaffProfile(db, bmActor, otherBranchStaff.userId, { firstName: 'No' }, scope);
    expect(r.ok).toBe(false);
  });

  it('lets a branch manager create and submit a request for staff', () => {
    const created = createHrRequestForStaff(
      db,
      bmActor,
      staff.userId,
      { kind: 'other', title: 'Uniform replacement', body: 'Staff cannot use the portal.' },
      scope
    );
    expect(created.ok).toBe(true);
    expect(created.request?.userId).toBe(staff.userId);

    const submitted = submitHrRequestForStaff(db, created.request.id, bmActor, scope);
    expect(submitted.ok).toBe(true);
  });

  it('does not let staff submit a teammate request without assist permission', () => {
    const clerkActor = {
      id: staff.userId,
      roleKey: 'sales_staff',
      permissions: permissionsForRole('sales_staff'),
    };
    const created = createHrRequest(db, otherBranchStaff.userId, {
      kind: 'other',
      title: 'Should stay private',
    });
    expect(created.ok).toBe(true);
    const r = submitHrRequestForStaff(db, created.request.id, clerkActor, scope);
    expect(r.ok).toBe(false);
  });

  it('submits a completed profile on behalf of staff', () => {
    const filled = updateTeamStaffProfile(
      db,
      bmActor,
      staff.userId,
      {
        firstName: 'Amina',
        surname: 'Bello',
        phone: '08012345678',
        gender: 'female',
        dateOfBirthIso: '1992-04-01',
        ninNumber: '12345678901',
        residentialAddress: '12 Kaduna Road',
        minimumQualification: 'NCE',
        nextOfKinName: 'Musa Bello',
        nextOfKinPhone: '08087654321',
        nextOfKinRelationship: 'Spouse',
      },
      scope
    );
    expect(filled.ok).toBe(true);
    const r = submitTeamStaffProfile(db, bmActor, staff.userId, scope);
    expect(r.ok).toBe(true);
    const { hr } = getHrMeProfile(db, staff.userId);
    expect(hr?.profileLocked).toBe(true);
  });
});
