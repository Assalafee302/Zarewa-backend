import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { createAppUserRecord } from './auth.js';
import { upsertHrDesignation } from './hrMasterData.js';
import { persistStaffRoleCompliance, recomputeAllStaffRoleCompliance } from './hrRoleComplianceOps.js';
import { runHrScheduledJobs, upsertHrStaffProfile } from './hrOps.js';

describe('hrRoleComplianceOps persist + tick', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;
  let actorId;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    const actor = createAppUserRecord(db, {
      username: 'hr.admin.comp',
      displayName: 'HR Admin',
      password: 'Hr@123456!',
      roleKey: 'hr_admin',
    });
    actorId = actor.userId;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it('computes needs_attention on save and designation change, not a static ok default', () => {
    const des = upsertHrDesignation(
      db,
      {
        id: 'desig_estimator',
        title: 'Estimator',
        staffBand: 'senior_staff',
        minQualificationRank: 4,
      },
      { id: actorId }
    );
    expect(des.ok).toBe(true);
    expect(des.designation.minQualificationRank).toBe(4);
    expect(des.designation.staffBand).toBe('senior_staff');

    const staff = createAppUserRecord(db, {
      username: 'est.one',
      displayName: 'Est One',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
    });

    const saved = upsertHrStaffProfile(db, actorId, {
      userId: staff.userId,
      branchId: 'BR-KD',
      jobTitle: 'Estimator',
      designationId: 'desig_estimator',
      dateJoinedIso: '2018-01-01',
      qualificationRank: 2,
      roleStartedAtIso: '2018-01-01',
    });
    expect(saved.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT compliance_status, compliance_reason, role_started_at_iso, qualification_rank, bank_verification_status
         FROM hr_staff_profiles WHERE user_id = ?`
      )
      .get(staff.userId);
    expect(row.compliance_status).toBe('needs_attention');
    expect(String(row.compliance_reason || '')).toMatch(/below minimum rank 4/);
    expect(String(row.role_started_at_iso || '').slice(0, 10)).toBe('2018-01-01');
    expect(Number(row.qualification_rank)).toBe(2);
    expect(row.bank_verification_status === 'unverified' || row.bank_verification_status == null).toBe(true);

    const raised = upsertHrStaffProfile(db, actorId, {
      userId: staff.userId,
      qualificationRank: 5,
    });
    expect(raised.ok).toBe(true);
    const afterRank = db
      .prepare(`SELECT compliance_status, compliance_reason FROM hr_staff_profiles WHERE user_id = ?`)
      .get(staff.userId);
    expect(afterRank.compliance_status).toBe('ok');

    const tenure = upsertHrDesignation(
      db,
      {
        id: 'desig_estimator',
        title: 'Estimator',
        maxTenureYears: 5,
      },
      { id: actorId }
    );
    expect(tenure.ok).toBe(true);
    expect(tenure.designation.minQualificationRank).toBe(4);
    expect(tenure.designation.staffBand).toBe('senior_staff');
    const afterTenure = db
      .prepare(`SELECT compliance_status, compliance_reason FROM hr_staff_profiles WHERE user_id = ?`)
      .get(staff.userId);
    expect(afterTenure.compliance_status).toBe('needs_attention');
    expect(String(afterTenure.compliance_reason || '')).toMatch(/maximum tenure is 5 years/);

    db.prepare(`UPDATE hr_staff_profiles SET compliance_status = 'ok', compliance_reason = NULL WHERE user_id = ?`).run(
      staff.userId
    );
    const tick = runHrScheduledJobs(db);
    expect(tick.ok).toBe(true);
    const afterTick = db
      .prepare(`SELECT compliance_status FROM hr_staff_profiles WHERE user_id = ?`)
      .get(staff.userId);
    expect(afterTick.compliance_status).toBe('needs_attention');
  });

  it('treats missing role start as needs_attention when max tenure is set', () => {
    upsertHrDesignation(
      db,
      { id: 'desig_sales', title: 'Sales Officer', maxTenureYears: 5, minQualificationRank: 1 },
      { id: actorId }
    );
    const staff = createAppUserRecord(db, {
      username: 'sales.one',
      displayName: 'Sales One',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
    });
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, job_title, designation_id, qualification_rank, compliance_status)
       VALUES (?, 'BR-KD', 'Sales Officer', 'desig_sales', 3, 'ok')`
    ).run(staff.userId);
    persistStaffRoleCompliance(db, staff.userId);
    const row = db
      .prepare(`SELECT compliance_status, compliance_reason FROM hr_staff_profiles WHERE user_id = ?`)
      .get(staff.userId);
    expect(row.compliance_status).toBe('needs_attention');
    expect(String(row.compliance_reason || '')).toMatch(/Role start date missing/);
  });

  it('does not invent a bank verification action — status stays unverified unless written elsewhere', () => {
    const staff = createAppUserRecord(db, {
      username: 'bank.one',
      displayName: 'Bank One',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
    });
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, job_title, bank_verification_status)
       VALUES (?, 'BR-KD', 'Clerk', 'unverified')`
    ).run(staff.userId);
    recomputeAllStaffRoleCompliance(db);
    const row = db
      .prepare(`SELECT bank_verification_status, compliance_status FROM hr_staff_profiles WHERE user_id = ?`)
      .get(staff.userId);
    expect(row.bank_verification_status).toBe('unverified');
    expect(row.compliance_status).toBe('ok');
  });
});
