import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { changePassword, completeUserTraining, createAppUserRecord } from './auth.js';

function dbAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dbAvailable())('migrate must_change_password', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:', { seed: false });
    runMigrations(db);
  });

  afterAll(() => {
    db?.close();
  });

  it('does not re-flag must_change_password on every migration run', () => {
    const r = createAppUserRecord(db, {
      username: `migrate.loop.${Date.now()}`,
      displayName: 'Migrate Loop',
      password: 'TempPass@999!',
      roleKey: 'sales_staff',
    });
    expect(r.ok).toBe(true);
    const ch = changePassword(db, r.userId, 'TempPass@999!', 'NewSecure@999!');
    expect(ch.ok).toBe(true);
    const tr = completeUserTraining(db, r.userId);
    expect(tr.ok).toBe(true);

    let row = db.prepare(`SELECT must_change_password FROM app_users WHERE id = ?`).get(r.userId);
    expect(Number(row.must_change_password)).toBe(0);

    runMigrations(db);

    row = db.prepare(`SELECT must_change_password FROM app_users WHERE id = ?`).get(r.userId);
    expect(Number(row.must_change_password)).toBe(0);
  });
});
