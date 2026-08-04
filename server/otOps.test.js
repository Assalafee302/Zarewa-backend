import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  OT_STATUS,
  createOtRequest,
  updateOtRequest,
  submitOtRequest,
  approveOtRequest,
  rejectOtRequest,
  payOtRequest,
  getOtRequest,
  listOtRequests,
} from './otOps.js';

function dbOk() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

function tableExists(db, name) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.tables
           WHERE table_schema = DATABASE() AND table_name = ?`
        )
        .get(name)
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
    } catch {
      return false;
    }
  }
}

function actor(user, roleKey) {
  return {
    id: user.id,
    displayName: user.display_name || user.username,
    roleKey: roleKey || user.role_key,
  };
}

function seedOtFixture(db) {
  const branchId = db.prepare(`SELECT id FROM branches LIMIT 1`).get()?.id || 'BR-KD';
  const ops =
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE role_key = 'operations_officer' LIMIT 1`).get() ||
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users LIMIT 1`).get();
  const bm =
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE role_key = 'sales_manager' LIMIT 1`).get() ||
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE id != ? LIMIT 1`).get(ops.id);
  const cashier =
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE role_key = 'cashier' LIMIT 1`).get() ||
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE id NOT IN (?,?) LIMIT 1`).get(ops.id, bm.id);

  const staffA = ops;
  const staffB =
    db.prepare(`SELECT id, username, display_name, role_key FROM app_users WHERE id != ? LIMIT 1`).get(ops.id) || ops;

  // Ensure profiles exist for branch + job titles.
  for (const u of [staffA, staffB]) {
    const has = db.prepare(`SELECT user_id FROM hr_staff_profiles WHERE user_id = ?`).get(u.id);
    if (!has) {
      try {
        db.prepare(
          `INSERT INTO hr_staff_profiles (user_id, branch_id, job_title, employment_type, base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn)
           VALUES (?,?,?,?,0,0,0)`
        ).run(u.id, branchId, 'Operator', 'permanent');
      } catch {
        /* columns may vary */
      }
    } else {
      try {
        db.prepare(`UPDATE hr_staff_profiles SET branch_id = ?, job_title = COALESCE(NULLIF(job_title,''), 'Operator') WHERE user_id = ?`).run(
          branchId,
          u.id
        );
      } catch {
        /* ignore */
      }
    }
  }

  // Minimal quote + PO for link validation.
  const qid = `QT-TEST-OT-${Date.now().toString(36)}`;
  const cust = db.prepare(`SELECT customer_id, name FROM customers LIMIT 1`).get();
  if (cust) {
    try {
      db.prepare(
        `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(qid, cust.customer_id, cust.name, 100000, 0, 'Unpaid', 'Pending', '{}', '2026-08-04', branchId);
    } catch {
      /* may exist */
    }
  }

  let poId = db.prepare(`SELECT po_id FROM purchase_orders LIMIT 1`).get()?.po_id || null;
  if (!poId) {
    const supplier = db.prepare(`SELECT supplier_id, name FROM suppliers LIMIT 1`).get();
    if (supplier) {
      poId = `PO-TEST-OT-${Date.now().toString(36)}`;
      try {
        db.prepare(
          `INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, status, branch_id)
           VALUES (?,?,?,?,?)`
        ).run(poId, supplier.supplier_id, supplier.name, 'Approved', branchId);
      } catch {
        poId = null;
      }
    }
  }

  return { branchId, ops, bm, cashier, staffA, staffB, quotationId: cust ? qid : null, poId };
}

function baseProductionPayload(fx) {
  return {
    branchId: fx.branchId,
    dayIso: '2026-08-04',
    workType: 'production',
    reason: 'Night production run for customer order',
    quotationRef: fx.quotationId,
    approvalBeforeStart: true,
    staffLines: [
      {
        staffUserId: fx.staffA.id,
        roleLabel: 'Machine operator',
        startTime: '18:00',
        endTime: '22:00',
      },
      {
        staffUserId: fx.staffB.id,
        roleLabel: 'Helper',
        startTime: '18:00',
        endTime: '21:30',
      },
    ],
    workDetails: {
      materialType: 'Aluzinc 0.40',
      workDone: 'Roofing sheet production',
      quantity: 120,
      quantityUnit: 'm',
      machineArea: 'Line 2',
      actualCompletionTime: '22:15',
      factoryLockedBy: 'Night foreman',
    },
    paymentLine: {
      category: 'production_ot',
      quantity: 4,
      rateRequested: 2500,
      remarks: '4 staff-hours',
    },
  };
}

describe.skipIf(!dbOk())('otOps state machine', () => {
  let db;
  let fx;

  beforeEach(() => {
    db = createDatabase(':memory:');
    expect(tableExists(db, 'ot_requests')).toBe(true);
    fx = seedOtFixture(db);
    expect(fx.ops?.id).toBeTruthy();
    expect(fx.bm?.id).toBeTruthy();
  });

  afterEach(() => db?.close());

  it('creates draft with OT- human id and status history', () => {
    if (!fx.quotationId) return;
    const r = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    expect(r.ok).toBe(true);
    expect(r.request.status).toBe(OT_STATUS.DRAFT);
    expect(r.request.id).toMatch(/^OT-/);
    expect(r.staffLines).toHaveLength(2);
    expect(r.paymentLine.rateRequested).toBe(2500);
    expect(r.statusHistory.some((h) => h.toStatus === OT_STATUS.DRAFT)).toBe(true);
  });

  it('rejects free-text staff: non-roster staffUserId', () => {
    if (!fx.quotationId) return;
    const r = createOtRequest(db, actor(fx.ops, 'operations_officer'), {
      ...baseProductionPayload(fx),
      staffLines: [
        {
          staffUserId: 'USR-NOT-A-ROSTER-ID',
          roleLabel: 'Casual',
          startTime: '18:00',
          endTime: '20:00',
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OT_STAFF_NOT_ROSTER');
  });

  it('happy path: draft → submit → approve (rate change) → pay', () => {
    if (!fx.quotationId) return;
    const created = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    expect(created.ok).toBe(true);
    const id = created.request.id;

    const sub = submitOtRequest(db, actor(fx.ops, 'operations_officer'), id);
    expect(sub.ok).toBe(true);
    expect(sub.request.status).toBe(OT_STATUS.PENDING_BM);

    // Storekeeper cannot edit after submit
    const badEdit = updateOtRequest(db, actor(fx.ops, 'operations_officer'), id, baseProductionPayload(fx));
    expect(badEdit.ok).toBe(false);
    expect(badEdit.code).toBe('OT_EDIT_STATUS');

    // Approve without variance when same rate
    const noVarFail = approveOtRequest(
      db,
      actor(fx.bm, 'sales_manager'),
      id,
      { rateApproved: 3000 },
      { branchId: fx.branchId }
    );
    expect(noVarFail.ok).toBe(false);
    expect(noVarFail.code).toBe('OT_VARIANCE_REASON');

    const appr = approveOtRequest(
      db,
      actor(fx.bm, 'sales_manager'),
      id,
      { rateApproved: 3000, varianceReason: 'Market night rate for Line 2' },
      { branchId: fx.branchId }
    );
    expect(appr.ok).toBe(true);
    expect(appr.request.status).toBe(OT_STATUS.APPROVED);
    expect(appr.paymentLine.rateApproved).toBe(3000);
    expect(appr.paymentLine.amountNgn).toBe(4 * 3000);
    expect(appr.request.totalPayableNgn).toBe(12000);
    expect(appr.paymentLine.varianceReason).toMatch(/Market night rate/);
    const lockedPayable = appr.request.totalPayableNgn;
    const lockedRate = appr.paymentLine.rateApproved;
    const lockedAmount = appr.paymentLine.amountNgn;

    // Cashier mark-paid ignores forged amounts — payable stays approve-time lock
    const pay = payOtRequest(
      db,
      actor(fx.cashier || fx.bm, 'cashier'),
      id,
      {
        paymentMethod: 'Cash',
        paymentNote: 'Paid from petty cash',
        rateApproved: 1,
        amountNgn: 999999,
        totalPayableNgn: 1,
      },
      { branchId: fx.branchId }
    );
    expect(pay.ok).toBe(true);
    expect(pay.request.status).toBe(OT_STATUS.PAID);
    expect(pay.request.paidAtIso).toBeTruthy();
    expect(pay.request.totalPayableNgn).toBe(lockedPayable);
    expect(pay.paymentLine.rateApproved).toBe(lockedRate);
    expect(pay.paymentLine.amountNgn).toBe(lockedAmount);

    // No re-pay
    const repay = payOtRequest(db, actor(fx.cashier || fx.bm, 'cashier'), id, {}, { branchId: fx.branchId });
    expect(repay.ok).toBe(false);
    expect(repay.code).toBe('OT_PAY_STATUS');

    // History order
    const hist = getOtRequest(db, id).statusHistory.map((h) => h.toStatus);
    expect(hist).toEqual([
      OT_STATUS.DRAFT,
      OT_STATUS.PENDING_BM,
      OT_STATUS.APPROVED,
      OT_STATUS.PAID,
    ]);
  });

  it('reject is terminal (no reopen, cannot approve/pay/submit)', () => {
    if (!fx.quotationId) return;
    const created = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    const id = created.request.id;
    expect(submitOtRequest(db, actor(fx.ops, 'operations_officer'), id).ok).toBe(true);

    const rej = rejectOtRequest(
      db,
      actor(fx.bm, 'sales_manager'),
      id,
      { reason: 'Work not pre-authorised by BM' },
      { branchId: fx.branchId }
    );
    expect(rej.ok).toBe(true);
    expect(rej.request.status).toBe(OT_STATUS.REJECTED);
    expect(rej.request.rejectionReason).toMatch(/pre-authorised/i);

    expect(approveOtRequest(db, actor(fx.bm, 'sales_manager'), id, {}, { branchId: fx.branchId }).code).toBe(
      'OT_APPROVE_STATUS'
    );
    expect(payOtRequest(db, actor(fx.cashier || fx.bm, 'cashier'), id, {}, { branchId: fx.branchId }).code).toBe(
      'OT_PAY_STATUS'
    );
    expect(submitOtRequest(db, actor(fx.ops, 'operations_officer'), id).code).toBe('OT_SUBMIT_STATUS');
    expect(updateOtRequest(db, actor(fx.ops, 'operations_officer'), id, baseProductionPayload(fx)).code).toBe(
      'OT_EDIT_STATUS'
    );

    // Still visible in list history
    const listed = listOtRequests(db, { branchId: fx.branchId, status: OT_STATUS.REJECTED });
    expect(listed.some((r) => r.id === id)).toBe(true);
  });

  it('branch scope rejects approve/pay from other branch opts', () => {
    if (!fx.quotationId) return;
    const created = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    const id = created.request.id;
    submitOtRequest(db, actor(fx.ops, 'operations_officer'), id);

    const appr = approveOtRequest(db, actor(fx.bm, 'sales_manager'), id, {}, { branchId: 'BR-OTHER-SCOPE' });
    expect(appr.ok).toBe(false);
    expect(appr.code).toBe('OT_BRANCH_SCOPE');
  });

  it('submit requires quotation for production; po for offload', () => {
    const noQuote = createOtRequest(db, actor(fx.ops, 'operations_officer'), {
      ...baseProductionPayload(fx),
      quotationRef: null,
    });
    if (!noQuote.ok) return;
    const sub = submitOtRequest(db, actor(fx.ops, 'operations_officer'), noQuote.request.id);
    expect(sub.ok).toBe(false);
    expect(sub.code).toBe('OT_QUOTATION_REQUIRED');

    if (!fx.poId) return;
    const off = createOtRequest(db, actor(fx.ops, 'operations_officer'), {
      branchId: fx.branchId,
      dayIso: '2026-08-05',
      workType: 'offload',
      reason: 'Coil offload at yard after hours',
      poId: fx.poId,
      staffLines: [
        {
          staffUserId: fx.staffA.id,
          roleLabel: 'Store helper',
          startTime: '19:00',
          endTime: '21:00',
        },
      ],
      workDetails: { workDone: 'Offload coils from truck', quantity: 8, quantityUnit: 'coils' },
      paymentLine: { category: 'stone_coated_offload', quantity: 2, rateRequested: 1500 },
    });
    expect(off.ok).toBe(true);
    expect(off.request.quotationRef).toBeFalsy();
    expect(off.request.poId).toBe(fx.poId);
    const subOff = submitOtRequest(db, actor(fx.ops, 'operations_officer'), off.request.id);
    expect(subOff.ok).toBe(true);
    expect(subOff.request.status).toBe(OT_STATUS.PENDING_BM);
  });

  it('cannot skip steps: pay before approve', () => {
    if (!fx.quotationId) return;
    const created = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    const id = created.request.id;
    submitOtRequest(db, actor(fx.ops, 'operations_officer'), id);
    const pay = payOtRequest(db, actor(fx.cashier || fx.bm, 'cashier'), id, {}, { branchId: fx.branchId });
    expect(pay.ok).toBe(false);
    expect(pay.code).toBe('OT_PAY_STATUS');
  });

  it('only creator can edit draft', () => {
    if (!fx.quotationId) return;
    const created = createOtRequest(db, actor(fx.ops, 'operations_officer'), baseProductionPayload(fx));
    const id = created.request.id;
    const other = updateOtRequest(
      db,
      actor(fx.bm, 'operations_officer'),
      id,
      baseProductionPayload(fx)
    );
    expect(other.ok).toBe(false);
    expect(other.code).toBe('OT_EDIT_OWNER');
  });
});
