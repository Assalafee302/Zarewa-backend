import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import {
  changePassword,
  completeUserTraining,
  createAppUserRecord,
  publicUserFromRow,
} from './auth.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mysqlAvailable())('user onboarding', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
  });

  afterAll(() => {
    db?.close();
  });

  it('flags new users for password change and training', () => {
    const r = createAppUserRecord(db, {
      username: `onboard.${Date.now()}.a`,
      displayName: 'Onboard Test',
      password: 'TempPass@999!',
      roleKey: 'sales_staff',
    });
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(r.userId);
    const pub = publicUserFromRow(row);
    expect(pub.mustChangePassword).toBe(true);
    expect(pub.trainingCompleted).toBe(false);
  });

  it('clears mustChangePassword and completes training', () => {
    const r = createAppUserRecord(db, {
      username: `onboard.${Date.now()}.b`,
      displayName: 'PW Test',
      password: 'TempPass@999!',
      roleKey: 'cashier',
    });
    const ch = changePassword(db, r.userId, 'TempPass@999!', 'NewSecure@999!');
    expect(ch.ok).toBe(true);
    expect(ch.user?.mustChangePassword).toBe(false);
    const tr = completeUserTraining(db, r.userId);
    expect(tr.ok).toBe(true);
    expect(tr.user?.trainingCompleted).toBe(true);
  });
});
