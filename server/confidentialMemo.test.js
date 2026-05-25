import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  createOfficeThread,
  listOfficeThreads,
  officeTablesReady,
} from './officeOps.js';
import { listUnifiedWorkItems, userCanSeePersistedWorkItem, ensureWorkItemForOfficeThread } from './workItems.js';
import { workspaceQuickSearch } from './workspaceSearchOps.js';

describe('confidential memo redaction', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('excludes confidential threads from MD HQ roll-up when not on distribution', () => {
    expect(officeTablesReady(db)).toBe(true);
    const staff = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.staff'`).get();
    const mgr = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.manager'`).get();
    const md = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'md'`).get();
    expect(staff?.id && mgr?.id && md?.id).toBeTruthy();

    const created = createOfficeThread(db, { id: staff.id, username: 'sales.staff', roleKey: 'sales_staff' }, DEFAULT_BRANCH_ID, {
      subject: 'Confidential salary review',
      body: 'Restricted compensation discussion.',
      toUserIds: [mgr.id],
      kind: 'memo',
      payload: { confidentiality: 'confidential' },
    });
    expect(created.ok).toBe(true);

    const hqScope = { viewAll: true, branchId: DEFAULT_BRANCH_ID };
    const mdUser = { id: md.id, username: md.username, roleKey: md.roleKey, permissions: [] };
    const listed = listOfficeThreads(db, hqScope, mdUser, {});
    expect(listed.some((t) => t.id === created.thread.id)).toBe(false);

    const mgrUser = { id: mgr.id, username: 'sales.manager', roleKey: 'sales_manager', permissions: [] };
    const forMgr = listOfficeThreads(db, { viewAll: false, branchId: DEFAULT_BRANCH_ID }, mgrUser, {});
    expect(forMgr.some((t) => t.id === created.thread.id)).toBe(true);
  });

  it('does not expose confidential work items to MD via unified list', () => {
    const staff = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'sales.staff'`).get();
    const mgr = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.manager'`).get();
    const md = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'md'`).get();

    createOfficeThread(db, { id: staff.id, username: staff.username, roleKey: staff.roleKey }, DEFAULT_BRANCH_ID, {
      subject: 'Secret procurement terms',
      body: 'Vendor pricing is confidential.',
      toUserIds: [mgr.id],
      kind: 'memo',
      payload: { confidentiality: 'confidential' },
    });
    const thread = db.prepare(`SELECT id FROM office_threads WHERE subject = ?`).get('Secret procurement terms');
    if (thread?.id) {
      ensureWorkItemForOfficeThread(db, thread.id, { id: staff.id, username: staff.username, roleKey: staff.roleKey });
    }

    const hqScope = { viewAll: true, branchId: DEFAULT_BRANCH_ID };
    const mdUser = { id: md.id, username: md.username, roleKey: md.roleKey, permissions: ['office.use'] };
    const items = listUnifiedWorkItems(db, hqScope, mdUser, { limit: 200 });
    expect(items.some((i) => String(i.title || '').includes('Secret procurement'))).toBe(false);
  });

  it('redacts confidential titles from workspace search for unauthorized users', () => {
    const staff = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'sales.staff'`).get();
    const mgr = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.manager'`).get();
    const md = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'md'`).get();

    const created = createOfficeThread(db, { id: staff.id, username: staff.username, roleKey: staff.roleKey }, DEFAULT_BRANCH_ID, {
      subject: 'UniqueXSecretFuelMemo',
      body: 'Need diesel urgently.',
      toUserIds: [mgr.id],
      kind: 'memo',
      payload: { confidentiality: 'confidential' },
    });
    ensureWorkItemForOfficeThread(db, created.thread.id, { id: staff.id, username: staff.username, roleKey: staff.roleKey });

    const row = db.prepare(`SELECT * FROM work_items WHERE title LIKE ?`).get('%UniqueXSecretFuelMemo%');
    expect(row?.id).toBeTruthy();

    const mdReq = {
      user: { id: md.id, username: md.username, roleKey: md.roleKey, permissions: ['office.use'] },
      workspaceBranchId: DEFAULT_BRANCH_ID,
      workspaceViewAll: true,
    };
    const hits = workspaceQuickSearch(db, mdReq, 'UniqueXSecretFuelMemo', 20);
    expect(hits.some((h) => String(h.label || '').includes('UniqueXSecretFuelMemo'))).toBe(false);

    const mgrUser = { id: mgr.id, username: 'sales.manager', roleKey: 'sales_manager', permissions: ['office.use'] };
    expect(
      userCanSeePersistedWorkItem(db, { viewAll: false, branchId: DEFAULT_BRANCH_ID }, mgrUser, row)
    ).toBe(true);
    expect(
      userCanSeePersistedWorkItem(db, { viewAll: true, branchId: DEFAULT_BRANCH_ID }, mdReq.user, row)
    ).toBe(false);
  });
});
