import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { nowIso } from './hrOps.js';
import { staffObligationTablesReady } from './staffObligationOps.js';
import {
  listStaffRecoveriesDueForCashier,
  recordStaffRecoveryCashierPayment,
} from './staffRecoveryCashierOps.js';
import { resolveObligationAccountIdForRecoverySchedule } from './staffRecoveryObligationOps.js';

describe.skipIf(!isMysqlAvailableForTests())('staffRecoveryCashierOps', () => {
  let db;
  let actor;
  let staffUserId;
  let scheduleId;
  let treasuryAccountId;
  let branchId;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    actor = resolveTestActor(db);
    const staff = db.prepare(`SELECT user_id, branch_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    branchId = staff?.branch_id || 'KD';
    expect(staffUserId).toBeTruthy();
    expect(staffObligationTablesReady(db)).toBe(true);
    expect(recoverySchedulesTableReady(db)).toBe(true);

    const ta = db
      .prepare(`SELECT id FROM treasury_accounts WHERE branch_id = ? OR branch_id IS NULL ORDER BY id LIMIT 1`)
      .get(branchId);
    treasuryAccountId = ta?.id;
    expect(treasuryAccountId).toBeTruthy();

    scheduleId = `HRRcv-CASH-${Date.now()}`;
    const caseId = `HRCase-CASH-${Date.now()}`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO hr_discipline_cases (id, case_number, user_id, branch_id, status, opened_at_iso)
       VALUES (?, ?, ?, ?, 'closed', ?)`
    ).run(caseId, `DC-CASH-${Date.now()}`, staffUserId, branchId, now);

    db.prepare(
      `INSERT INTO hr_incident_recovery_schedules (
        id, case_id, user_id, total_amount_ngn, installment_amount_ngn, duration_months,
        principal_outstanding_ngn, months_deducted, deductions_active, status,
        activated_at_iso, created_at_iso, created_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      scheduleId,
      caseId,
      staffUserId,
      50_000,
      10_000,
      5,
      50_000,
      0,
      1,
      'active',
      now,
      now,
      actor?.id || null
    );
  });

  it('lists active recoveries for cashier queue', () => {
    const rows = listStaffRecoveriesDueForCashier(db, branchId);
    expect(rows.some((r) => r.scheduleId === scheduleId)).toBe(true);
  });

  it('records cashier payment with treasury, schedule, and obligation ledger', () => {
    const beforeBal = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId)?.balance;
    const r = recordStaffRecoveryCashierPayment(db, actor, scheduleId, {
      treasuryAccountId,
      payInFull: true,
      paymentDateIso: new Date().toISOString().slice(0, 10),
      note: 'Cashier test payment',
      workspaceBranchId: branchId,
      workspaceViewAll: false,
    });
    expect(r.ok).toBe(true);
    expect(r.paidInFull).toBe(true);
    expect(r.principalOutstandingNgn).toBe(0);
    expect(r.treasuryMovementId).toBeTruthy();
    expect(r.obligationAccountId).toBeTruthy();

    const afterBal = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(treasuryAccountId)?.balance;
    expect(Math.round(Number(afterBal) || 0) - Math.round(Number(beforeBal) || 0)).toBe(50_000);

    const sched = db.prepare(`SELECT status, principal_outstanding_ngn FROM hr_incident_recovery_schedules WHERE id = ?`).get(scheduleId);
    expect(sched?.status).toBe('completed');
    expect(Number(sched?.principal_outstanding_ngn)).toBe(0);

    const obId = resolveObligationAccountIdForRecoverySchedule(db, scheduleId);
    expect(obId).toBe(r.obligationAccountId);
    const ob = db.prepare(`SELECT principal_outstanding_ngn FROM hr_staff_obligation_accounts WHERE id = ?`).get(obId);
    expect(Number(ob?.principal_outstanding_ngn)).toBe(0);
  });
});
