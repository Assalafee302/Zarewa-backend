import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createOfficeThread } from './officeOps.js';
import {
  canBranchManagerEditOfficeRecord,
  patchOfficeRecordByBranchManager,
  enrichPayloadWithApprovalRoute,
} from './officeRecordOps.js';

describe('officeRecordOps (pure)', () => {
  it('enriches payload with approval route', () => {
    const p = enrichPayloadWithApprovalRoute({ smartMemo: { memoType: 'fuel_diesel' } }, {
      amountNgn: 50_000,
      requesterRoleKey: 'sales_staff',
    });
    expect(p.approvalRoute?.steps?.length).toBeGreaterThan(1);
  });
});

describe.skipIf(!process.env.ZAREWA_MYSQL_HOST && !process.env.ZAREWA_MYSQL_USER)('officeRecordOps (mysql)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('branch manager can edit submitted thread', () => {
    const admin = db.prepare(`SELECT id, username, role_key AS roleKey, display_name AS displayName FROM app_users WHERE username = 'admin'`).get();
    const mgr = db
      .prepare(`SELECT id, username, role_key AS roleKey, display_name AS displayName FROM app_users WHERE role_key = 'sales_manager' LIMIT 1`)
      .get();
    const actor = admin || { id: '1', username: 'admin', roleKey: 'admin', displayName: 'Admin' };
    const created = createOfficeThread(db, actor, DEFAULT_BRANCH_ID, {
      subject: 'Machine spoil',
      body: 'need mechanic',
      kind: 'memo',
    });
    expect(created.ok).toBe(true);
    db.prepare(`UPDATE office_threads SET status = 'submitted' WHERE id = ?`).run(created.thread.id);
    const thread = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(created.thread.id);
    expect(canBranchManagerEditOfficeRecord(thread, mgr || { roleKey: 'sales_manager' })).toBe(true);

    const patch = patchOfficeRecordByBranchManager(db, created.thread.id, mgr || { id: '2', roleKey: 'sales_manager', displayName: 'BM' }, {
      body: 'The cutting machine is faulty and requires mechanic inspection.',
    });
    expect(patch.ok).toBe(true);
    const updated = db.prepare(`SELECT body FROM office_threads WHERE id = ?`).get(created.thread.id);
    expect(updated.body).toContain('cutting machine');
  });
});
