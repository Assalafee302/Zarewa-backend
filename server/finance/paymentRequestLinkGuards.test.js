import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { insertPaymentRequest, PAYMENT_REQUEST_PLACEHOLDER_EXPENSE_TYPE } from '../controlOps.js';
import { deletePaymentRequestRolloutDup } from '../writeOps.js';

function mysqlAvailable() {
  try {
    const probe = createDatabase(':memory:', { seed: false });
    probe.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

function adminActor(db) {
  const row = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE username = 'admin'`).get();
  return {
    id: row.id,
    username: row.username,
    roleKey: row.roleKey,
    displayName: 'Zarewa Admin',
    permissions: ['*'],
  };
}

describe.skipIf(!mysqlOk)('payment request linked-expense guards', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('validates category policy on a linked expense and blocks Others without justification', () => {
    const actor = adminActor(db);
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-OTH-1', 'Sundry', 12000, '2026-04-01', 'Others', 'Pending', 'MEMO-OTH', ?)`
    ).run(DEFAULT_BRANCH_ID);

    const denied = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-OTH-1',
        amountRequestedNgn: 12_000,
        requestDate: '2026-04-01',
        description: 'short',
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(denied.ok).toBe(false);
    expect(String(denied.error || '')).toMatch(/justification|attach|Others/i);

    const allowed = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-OTH-1',
        amountRequestedNgn: 12_000,
        requestDate: '2026-04-01',
        description: 'Unclassified sundry that needs an exception path',
        categoryJustification: 'Supplier invoice is missing a matching standard category after review with accounts.',
        attachment: { name: 'note.pdf', mime: 'application/pdf', dataBase64: 'dGVzdA==' },
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(allowed.ok).toBe(true);
  });

  it('blocks linking an expense that already has treasury', () => {
    const actor = adminActor(db);
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-TREAS-1', 'Direct paid', 8000, '2026-04-01', 'Office expenses', 'Cash', 'PAID-1', ?)`
    ).run(DEFAULT_BRANCH_ID);
    const account = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    db.prepare(
      `INSERT INTO treasury_movements (id, posted_at_iso, type, treasury_account_id, amount_ngn, source_kind, source_id)
       VALUES ('TM-LINK-1', '2026-04-01', 'EXPENSE', ?, -8000, 'EXPENSE', 'EXP-TREAS-1')`
    ).run(account.id);

    const r = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-TREAS-1',
        amountRequestedNgn: 8_000,
        requestDate: '2026-04-01',
        description: 'Should not double pay',
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toMatch(/already has a treasury posting/i);
  });

  it('blocks a second open payment request on the same expense', () => {
    const actor = adminActor(db);
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-OPEN-1', 'Memo', 5000, '2026-04-01', 'Office expenses', 'Pending', 'MEMO-2', ?)`
    ).run(DEFAULT_BRANCH_ID);

    const first = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-OPEN-1',
        amountRequestedNgn: 5_000,
        requestDate: '2026-04-01',
        description: 'First request',
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(first.ok).toBe(true);

    const second = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-OPEN-1',
        amountRequestedNgn: 5_000,
        requestDate: '2026-04-01',
        description: 'Duplicate request',
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(second.ok).toBe(false);
    expect(String(second.error || '')).toMatch(/already has payment request/i);
  });

  it('rollout-dup deletes placeholder expenses but keeps a pre-existing linked expense', () => {
    const actor = adminActor(db);
    const created = insertPaymentRequest(
      db,
      {
        requestDate: '2026-04-01',
        expenseCategory: 'Office expenses',
        description: 'Placeholder path',
        lineItems: [{ description: 'Paper', quantity: 1, unitPriceNgn: 3_000 }],
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(created.ok).toBe(true);
    const placeholderExp = db
      .prepare(`SELECT expense_id, expense_type FROM expenses e JOIN payment_requests pr ON pr.expense_id = e.expense_id WHERE pr.request_id = ?`)
      .get(created.requestID);
    expect(placeholderExp.expense_type).toBe(PAYMENT_REQUEST_PLACEHOLDER_EXPENSE_TYPE);

    const delPlaceholder = deletePaymentRequestRolloutDup(db, created.requestID, actor);
    expect(delPlaceholder.ok).toBe(true);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(placeholderExp.expense_id)).toBeFalsy();

    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES ('EXP-KEEP-1', 'Imported memo', 7000, '2026-04-01', 'Office expenses', 'Pending', 'KEEP', ?)`
    ).run(DEFAULT_BRANCH_ID);
    const linked = insertPaymentRequest(
      db,
      {
        expenseID: 'EXP-KEEP-1',
        amountRequestedNgn: 7_000,
        requestDate: '2026-04-01',
        description: 'Keep the original expense',
        workspaceBranchId: DEFAULT_BRANCH_ID,
      },
      actor
    );
    expect(linked.ok).toBe(true);
    const delLinked = deletePaymentRequestRolloutDup(db, linked.requestID, actor);
    expect(delLinked.ok).toBe(true);
    expect(db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = 'EXP-KEEP-1'`).get()).toBeTruthy();
  });
});
