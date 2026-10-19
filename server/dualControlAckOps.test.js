import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  acknowledgeDualControlWarning,
  listDualControlAcknowledgements,
  userMayAcknowledgeDualControl,
} from './dualControlAckOps.js';
import { buildPendingApprovalsReport } from './operationalReportsOps.js';
import { listMdAttentionInbox } from './mdAttentionOps.js';

describe('userMayAcknowledgeDualControl', () => {
  it('MD and CEO only', () => {
    expect(userMayAcknowledgeDualControl({ roleKey: 'md' })).toBe(true);
    expect(userMayAcknowledgeDualControl({ roleKey: 'CEO' })).toBe(true);
    for (const rk of ['admin', 'chairman', 'finance_manager', 'sales_manager', 'cashier', '']) {
      expect(userMayAcknowledgeDualControl({ roleKey: rk }), rk).toBe(false);
    }
    expect(userMayAcknowledgeDualControl(null)).toBe(false);
  });

  it('refuses before touching the database when the role or note is wrong', () => {
    const noDb = /** @type {any} */ ({});
    expect(acknowledgeDualControlWarning(noDb, { refundId: 'RF-1', kind: 'same_approver_payer', note: 'long enough note', user: { roleKey: 'admin' } }).status).toBe(403);
    expect(acknowledgeDualControlWarning(noDb, { refundId: 'RF-1', kind: 'same_approver_payer', note: 'short', user: { roleKey: 'md' } }).status).toBe(400);
    expect(acknowledgeDualControlWarning(noDb, { refundId: 'RF-1', kind: 'other', note: 'long enough note', user: { roleKey: 'md' } }).status).toBe(400);
  });
});

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('Acknowledge with note — DB', () => {
  /** @type {any} */
  let db;
  const prevFlag = process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
  const md = { roleKey: 'md', displayName: 'Test MD' };

  beforeAll(() => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '1';
  });
  afterAll(() => {
    if (prevFlag == null) delete process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
    else process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = prevFlag;
  });
  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.exec(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, paid_by, paid_at_iso, branch_id,
        requested_by_user_id, approved_by_user_id, paid_by_user_id
      ) VALUES (
        'RF-DC-1', 'CUS-1', 'Ade', 'QT-DC-1', '—', '["Overpayment"]', 'Overpaid',
        52000, 52000, 52000, 'Paid', 'Sales', '2026-10-15', '2026-10-16', 'Abdulrahman', 'Abdulrahman',
        '2026-10-16', '${DEFAULT_BRANCH_ID}', 'U-SALES', 'U-AR', 'U-AR'
      )
    `);
  });
  afterEach(() => {
    db?.close();
  });

  it('acknowledged warning leaves the list, stays on the record with who/when/note, and is audited', () => {
    const before = buildPendingApprovalsReport(db, 'ALL');
    expect(before.dualControlWarnings.map((w) => `${w.refundId}:${w.kind}`)).toEqual(['RF-DC-1:same_approver_payer']);
    expect(listMdAttentionInbox(db, 'ALL').items.some((i) => i.id === 'dual_control:RF-DC-1:same_approver_payer')).toBe(true);

    expect(
      acknowledgeDualControlWarning(db, { refundId: 'RF-DC-1', kind: 'same_requester_approver', note: 'Requester was sales, not the approver', user: md }).status
    ).toBe(409);

    const r = acknowledgeDualControlWarning(db, {
      refundId: 'RF-DC-1',
      kind: 'same_approver_payer',
      note: 'Only cashier on duty; payout checked against the bank alert.',
      user: md,
    });
    expect(r.ok).toBe(true);
    expect(r.acknowledgement).toMatchObject({
      refundId: 'RF-DC-1',
      kind: 'same_approver_payer',
      acknowledgedBy: 'Test MD',
      note: 'Only cashier on duty; payout checked against the bank alert.',
    });
    expect(r.acknowledgement.acknowledgedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const audit = db
      .prepare(`SELECT action, entity_kind, entity_id, note FROM audit_log WHERE entity_id = 'RF-DC-1'`)
      .all();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'refund.dual_control.acknowledged',
        entity_kind: 'customer_refund',
        note: 'Only cashier on duty; payout checked against the bank alert.',
      }),
    ]);

    const after = buildPendingApprovalsReport(db, 'ALL');
    expect(after.dualControlWarnings).toEqual([]);
    expect(after.dualControlAcknowledged).toHaveLength(1);
    expect(after.dualControlAcknowledged[0].acknowledgement.acknowledgedBy).toBe('Test MD');
    expect(listMdAttentionInbox(db, 'ALL').items.some((i) => i.id.startsWith('dual_control:RF-DC-1'))).toBe(false);
    expect([...listDualControlAcknowledgements(db, { refundIds: ['RF-DC-1'] }).values()]).toHaveLength(1);

    expect(
      acknowledgeDualControlWarning(db, { refundId: 'RF-DC-1', kind: 'same_approver_payer', note: 'second time around', user: md }).status
    ).toBe(409);
  });

  it('unknown refund is 404', () => {
    expect(
      acknowledgeDualControlWarning(db, { refundId: 'RF-NOPE', kind: 'same_approver_payer', note: 'long enough note', user: md }).status
    ).toBe(404);
  });
});
