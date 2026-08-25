import { describe, expect, it, beforeEach } from 'vitest';
import { createDatabase } from '../db.js';
import { runMigrations } from '../migrate.js';
import { createAppUserRecord } from '../auth.js';
import { registerNewStaffWithProfile, upsertHrStaffProfile } from '../hrOps.js';
import { scanHrStaffDuplicates } from '../hrStaffDuplicateCleanup.js';
import { HR_PAYROLL_GROUPS } from '../../shared/lib/hrStaffCohorts.js';
import { encryptBankAccount } from '../hrBankCrypto.js';

describe('staff identity uniqueness', () => {
  /** @type {import('../db.js').ZarewaDatabase} */
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

  function register(suffix, extra = {}) {
    return registerNewStaffWithProfile(
      db,
      actorId,
      {
        username: `staff.${suffix}`,
        displayName: extra.displayName || `Staff ${suffix}`,
        password: 'Zarewa@123',
        roleKey: 'sales_staff',
        payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
        branchId: 'BR-KD',
        employeeNo: extra.employeeNo || `ZAPKD${suffix}`,
        jobTitle: 'Sales Officer',
        ...extra,
      },
      { skipProfileFetch: true }
    );
  }

  it('rejects a second staff with the same NIN, phone, email, BVN, or account', () => {
    const first = register('801', {
      ninNumber: '12345678901',
      bvnNumber: '22233344455',
      phone: '08031234567',
      personalEmail: 'ada@zarewa.ng',
      bankAccountNo: '0123456789',
    });
    expect(first.ok).toBe(true);

    const nin = register('802', { ninNumber: '12345678901' });
    expect(nin.ok).toBe(false);
    expect(nin.code).toBe('DUPLICATE_IDENTITY');
    expect(nin.field).toBe('nin');

    const phone = register('803', { phone: '+2348031234567' });
    expect(phone.ok).toBe(false);
    expect(phone.field).toBe('phone');

    const email = register('804', { personalEmail: 'Ada@Zarewa.ng' });
    expect(email.ok).toBe(false);
    expect(email.field).toBe('email');

    const bvn = register('805', { bvnNumber: '22233344455' });
    expect(bvn.ok).toBe(false);
    expect(bvn.field).toBe('bvn');

    const acct = register('806', { bankAccountNo: '0123456789' });
    expect(acct.ok).toBe(false);
    expect(acct.field).toBe('account');
  });

  it('lets HR update the same staff without treating their own NIN as a clash', () => {
    const first = register('807', { ninNumber: '99988877766' });
    expect(first.ok).toBe(true);
    const r = upsertHrStaffProfile(db, actorId, {
      userId: first.userId,
      ninNumber: '99988877766',
      jobTitle: 'Senior Sales Officer',
    });
    expect(r.ok).toBe(true);
  });

  it('scans identity duplicates and similar names', () => {
    const a = register('808', { displayName: 'Musa Ibrahim', phone: '08035550001' });
    const b = register('809', { displayName: 'Ibrahim Musa' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    db.prepare(`UPDATE hr_staff_profiles SET nin_number = ? WHERE user_id = ?`).run('11122233344', a.userId);
    db.prepare(`UPDATE hr_staff_profiles SET nin_number = ? WHERE user_id = ?`).run('11122233344', b.userId);
    db.prepare(
      `UPDATE hr_staff_profiles SET bank_account_no = ?, bank_account_no_masked = ? WHERE user_id = ?`
    ).run(encryptBankAccount('9876543210'), '******3210', b.userId);

    const scan = scanHrStaffDuplicates(db);
    expect(scan.ok).toBe(true);
    expect(scan.identityGroups.some((g) => g.field === 'nin' && g.members.length >= 2)).toBe(true);
    expect(scan.nameSuspicions.some((g) => g.reason === 'same_tokens')).toBe(true);
  });
});
