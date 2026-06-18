import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { createAppUserRecord, findAppUserByLoginIdentifier, loginWithPassword } from './auth.js';

describe('findAppUserByLoginIdentifier', () => {
  /** @type {import('./db.js').ZarewaDatabase} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, code, name) VALUES ('BR-KD', 'KD', 'Kaduna')`).run();
    const created = createAppUserRecord(db, {
      username: 'john.okoro',
      displayName: 'John Okoro',
      password: 'Zarewa@123',
      roleKey: 'sales_staff',
    });
    expect(created.ok).toBe(true);
    db.prepare(
      `INSERT INTO hr_staff_profiles (user_id, branch_id, employee_no, job_title)
       VALUES (?, 'BR-KD', 'ZAPKD099', 'Security Guard')`
    ).run(created.userId);
  });

  it('finds staff by legacy username or employee ID', () => {
    expect(findAppUserByLoginIdentifier(db, 'john.okoro')?.username).toBe('john.okoro');
    expect(findAppUserByLoginIdentifier(db, 'ZAPKD099')?.username).toBe('john.okoro');
    expect(findAppUserByLoginIdentifier(db, 'zapkd099')?.username).toBe('john.okoro');
  });

  it('signs in with either username or employee ID', () => {
    const byUsername = loginWithPassword(db, 'john.okoro', 'Zarewa@123');
    expect(byUsername.ok).toBe(true);

    const byEmployeeId = loginWithPassword(db, 'ZAPKD099', 'Zarewa@123');
    expect(byEmployeeId.ok).toBe(true);
    expect(byEmployeeId.session?.user?.username).toBe('john.okoro');
  });
});
