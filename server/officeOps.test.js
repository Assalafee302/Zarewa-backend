import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  createOfficeThread,
  convertOfficeThreadToPaymentRequest,
  listOfficeThreads,
  officeTablesReady,
} from './officeOps.js';

describe('officeOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('creates a thread and converts it to a payment request row', () => {
    expect(officeTablesReady(db)).toBe(true);

    const row = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'admin'`).get();
    expect(row?.id).toBeTruthy();
    const actor = { id: row.id, username: row.username, roleKey: row.roleKey };

    const scope = { viewAll: false, branchId: DEFAULT_BRANCH_ID };

    const created = createOfficeThread(db, actor, DEFAULT_BRANCH_ID, {
      subject: 'Fuel for site visit',
      body: 'Need approval for logistics',
      kind: 'memo',
    });
    expect(created.ok).toBe(true);
    const tid = created.thread.id;

    const conv = convertOfficeThreadToPaymentRequest(db, scope, actor, DEFAULT_BRANCH_ID, tid, {
      expenseCategory: 'Logistics & haulage',
      lineItems: [{ item: 'Diesel', unit: 1, unitPriceNgn: 5000 }],
      requestDate: '2026-04-09',
      description: 'Diesel refill',
      requestReference: 'OFFICE-TEST',
    });
    expect(conv.ok).toBe(true);
    expect(conv.requestID).toBeTruthy();

    const threadRow = db.prepare(`SELECT status, related_payment_request_id FROM office_threads WHERE id = ?`).get(tid);
    expect(threadRow.status).toBe('converted');
    expect(threadRow.related_payment_request_id).toBe(conv.requestID);

    const pr = db
      .prepare(`SELECT request_id, approval_status, amount_requested_ngn FROM payment_requests WHERE request_id = ?`)
      .get(conv.requestID);
    expect(pr).toBeTruthy();
    expect(Number(pr.amount_requested_ngn)).toBe(5000);
  });

  it('hides confidential threads from HQ roll-up when executive is not on distribution', () => {
    expect(officeTablesReady(db)).toBe(true);
    const staff = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'sales.staff'`).get();
    const mgr = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.manager'`).get();
    const md = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'md'`).get();
    expect(staff?.id && mgr?.id && md?.id).toBeTruthy();

    const created = createOfficeThread(db, staff, DEFAULT_BRANCH_ID, {
      subject: 'Confidential comp discussion',
      body: 'Limited distribution.',
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
});
