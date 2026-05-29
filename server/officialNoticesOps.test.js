import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { createOfficialNotice, listOfficialNoticesForUser, acknowledgeOfficialNotice } from './officialNoticesOps.js';

describe.skipIf(!process.env.ZAREWA_MYSQL_HOST && !process.env.ZAREWA_MYSQL_USER)('officialNoticesOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('creates and lists notices', () => {
    const admin = db.prepare(`SELECT id, role_key AS roleKey FROM app_users WHERE username = 'admin'`).get();
    const r = createOfficialNotice(db, admin, {
      title: 'Holiday',
      content: 'Office closed Monday',
      targetAllStaff: true,
      requiresAcknowledgement: true,
    });
    expect(r.ok).toBe(true);
    const list = listOfficialNoticesForUser(db, { id: 'USR-STAFF', roleKey: 'sales_staff' }, { branchId: 'BR-KD' });
    expect(list.length).toBeGreaterThan(0);
    const ack = acknowledgeOfficialNotice(db, r.notice.id, { id: 'USR-STAFF' });
    expect(ack.ok).toBe(true);
  });
});
