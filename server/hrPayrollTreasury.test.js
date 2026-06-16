/**
 * Payroll treasury posting, policy default account, and salary reduction gates.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import { updateHrPolicyPayload } from './hrBusinessRules.js';
import {
  applyHrSalaryIncrement,
  patchPayrollRun,
  postPayrollRunTreasuryPayout,
} from './hrOps.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('HR payroll treasury and salary reduction', () => {
  let db;
  let actor;
  let staffUserId;
  let treasuryAccountId;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    actor = resolveTestActor(db);
    actor.permissions = ['*'];

    const staff = db.prepare(`SELECT user_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    expect(staffUserId).toBeTruthy();

    const treasury = db.prepare(`SELECT id FROM treasury_accounts ORDER BY id LIMIT 1`).get();
    treasuryAccountId = treasury?.id;
    expect(treasuryAccountId).toBeTruthy();
  });

  it('blocks salary reduction without MD or special increment approval', () => {
    db.prepare(
      `UPDATE hr_staff_profiles SET base_salary_ngn = 200000, housing_allowance_ngn = 0, transport_allowance_ngn = 0 WHERE user_id = ?`
    ).run(staffUserId);

    const hrActor = { id: actor.id, permissions: ['hr.staff.manage'] };
    const r = applyHrSalaryIncrement(
      db,
      actor.id,
      staffUserId,
      {
        reason: 'Temporary cut for discipline case review',
        baseSalaryNgn: 150000,
        housingAllowanceNgn: 0,
        transportAllowanceNgn: 0,
      },
      hrActor
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('salary_reduction_approval_required');
  });

  it('allows salary reduction with MD approval permission', () => {
    db.prepare(
      `UPDATE hr_staff_profiles SET base_salary_ngn = 200000, housing_allowance_ngn = 0, transport_allowance_ngn = 0 WHERE user_id = ?`
    ).run(staffUserId);

    const mdActor = { id: actor.id, permissions: ['hr.payroll.md_approve'] };
    const r = applyHrSalaryIncrement(
      db,
      actor.id,
      staffUserId,
      {
        reason: 'Acting allowance ended — revert to matrix pay package',
        baseSalaryNgn: 150000,
        housingAllowanceNgn: 0,
        transportAllowanceNgn: 0,
      },
      mdActor
    );
    expect(r.ok).toBe(true);
    const row = db.prepare(`SELECT base_salary_ngn FROM hr_staff_profiles WHERE user_id = ?`).get(staffUserId);
    expect(Number(row.base_salary_ngn)).toBe(150000);
  });

  it('persists payrollTreasuryAccountId in HR policy config', () => {
    const r = updateHrPolicyPayload(db, { payrollTreasuryAccountId: treasuryAccountId });
    expect(r.ok).toBe(true);
    expect(r.policy.payrollTreasuryAccountId).toBe(treasuryAccountId);

    const cleared = updateHrPolicyPayload(db, { payrollTreasuryAccountId: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.policy.payrollTreasuryAccountId).toBeNull();
  });

  it('posts treasury movement when payroll is marked paid (idempotent)', () => {
    const runId = 'HRP-TEST-TREAS';
    const now = new Date().toISOString();
    db.prepare(`DELETE FROM treasury_movements WHERE source_kind = 'HR_PAYROLL_RUN' AND source_id = ?`).run(runId);
    db.prepare(`DELETE FROM hr_payroll_lines WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM hr_payroll_runs WHERE id = ?`).run(runId);

    db.prepare(
      `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, created_at_iso, created_by_user_id)
       VALUES (?, ?, 'locked', 0, 8, ?, ?)`
    ).run(runId, '202607', now, actor.id);
    db.prepare(
      `INSERT INTO hr_payroll_lines (run_id, user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn)
       VALUES (?, ?, 60000, 0, 0, 0, 5000, 4800, 50200)`
    ).run(runId, staffUserId);

    const paid = patchPayrollRun(db, runId, { status: 'paid', treasuryAccountId }, actor);
    expect(paid.ok).toBe(true);
    expect(paid.treasury?.ok).toBe(true);
    expect(paid.treasury?.movementId).toBeTruthy();

    const mv = db
      .prepare(
        `SELECT amount_ngn, source_kind, source_id FROM treasury_movements
         WHERE source_kind = 'HR_PAYROLL_RUN' AND source_id = ? AND reverses_movement_id IS NULL`
      )
      .get(runId);
    expect(mv).toBeTruthy();
    expect(Number(mv.amount_ngn)).toBe(-50200);

    const again = postPayrollRunTreasuryPayout(db, runId, actor, { treasuryAccountId });
    expect(again.ok).toBe(true);
    expect(again.alreadyPosted).toBe(true);
  });
});
