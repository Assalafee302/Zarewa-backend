import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createOfficeThread } from './officeOps.js';
import { allocateFilingNumber, fileOfficeThread } from './filingNumberOps.js';

describe.skipIf(!process.env.ZAREWA_MYSQL_HOST && !process.env.ZAREWA_MYSQL_USER)('filingNumberOps (mysql)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('allocates filing number with prefix', () => {
    const no = allocateFilingNumber(db, { branchId: DEFAULT_BRANCH_ID, category: 'fuel_diesel' });
    expect(no).toMatch(/^FUEL-/);
  });

  it('files office thread', () => {
    const row = db.prepare(`SELECT id, username, role_key AS roleKey, display_name AS displayName FROM app_users WHERE username = 'admin'`).get();
    const actor = { id: row.id, username: row.username, roleKey: row.roleKey, displayName: row.displayName };
    const created = createOfficeThread(db, actor, DEFAULT_BRANCH_ID, {
      subject: 'Diesel request',
      body: 'Need fuel',
    });
    const r = fileOfficeThread(db, created.thread.id, actor, { category: 'fuel' });
    expect(r.ok).toBe(true);
    expect(r.filingNo).toMatch(/^FUEL-[A-Z]{2,4}-\d{2}-\d{4}$/);
  });
});
