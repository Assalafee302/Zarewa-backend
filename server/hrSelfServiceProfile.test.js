import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord } from './auth.js';
import { getHrMeProfile, updateMyHrStaffProfile } from './hrOps.js';

describe('updateMyHrStaffProfile next of kin', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;
  /** @type {string} */
  let userId;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    const created = createAppUserRecord(db, {
      username: 'staff.nok',
      displayName: 'Staff NOK',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
    });
    expect(created.ok).toBe(true);
    userId = created.userId;
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title, self_service_eligible)
       VALUES (?, 'BR-KD', 'ZAPKD501', 'Clerk', 1)`
    ).run(userId);
  });

  it('persists next of kin from flat self-service fields', () => {
    const r = updateMyHrStaffProfile(db, userId, {
      nextOfKinName: 'Jane Yakubu',
      nextOfKinPhone: '08012345678',
      nextOfKinRelationship: 'Spouse',
      nextOfKinAddress: '12 Kaduna Road',
      nextOfKinAltPhone: '08087654321',
    });
    expect(r.ok).toBe(true);

    const { hr } = getHrMeProfile(db, userId);
    expect(hr?.nextOfKin).toMatchObject({
      name: 'Jane Yakubu',
      phone: '08012345678',
      relationship: 'Spouse',
      address: '12 Kaduna Road',
      altPhone: '08087654321',
    });
  });

  it('persists next of kin from nextOfKin object', () => {
    const r = updateMyHrStaffProfile(db, userId, {
      nextOfKin: {
        name: 'John Doe',
        phone: '08011112222',
        relationship: 'Brother',
      },
    });
    expect(r.ok).toBe(true);

    const { hr } = getHrMeProfile(db, userId);
    expect(hr?.nextOfKin?.name).toBe('John Doe');
    expect(hr?.nextOfKin?.phone).toBe('08011112222');
  });
});
