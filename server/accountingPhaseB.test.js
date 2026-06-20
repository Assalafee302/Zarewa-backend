import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireIntegrationHarness,
  closeIntegrationHarness,
  isMysqlAvailableForTests,
  resolveTestActor,
} from './testIntegrationHarness.js';
import { ensureArchitecturalGlAccounts } from './accountingPostingOps.js';
import { createFixedAsset } from './accountingPhase2Ops.js';
import { previewDepreciationRun } from './depreciationRunOps.js';
import { buildMonthEndCloseChecklist } from './accountingCloseOps.js';
import {
  computePayrollRunGlAmounts,
  tryPostPayrollAccrualGlTx,
  payrollGlStatusForRun,
} from './payrollGlOps.js';

const mysqlOk = isMysqlAvailableForTests();

function seedPayrollRun(db, runId, periodYyyymm) {
  const admin = db.prepare(`SELECT id FROM app_users WHERE username = 'admin' LIMIT 1`).get();
  const userId = admin?.id || 'admin';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hr_payroll_runs (id, period_yyyymm, status, tax_percent, pension_percent, notes, created_at_iso, created_by_user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(runId, periodYyyymm, 'locked', 0, 8, null, now, userId);
  db.prepare(
    `INSERT INTO hr_payroll_lines (run_id, user_id, gross_ngn, bonus_ngn, attendance_deduction_ngn, other_deduction_ngn, tax_ngn, pension_ngn, net_ngn)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(runId, userId, 100_000, 0, 0, 0, 10_000, 8_000, 82_000);
  return { runId, userId };
}

describe.skipIf(!mysqlOk)('accounting Phase B', () => {
  let db;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    ensureArchitecturalGlAccounts(db);
  });

  afterAll(() => {
    closeIntegrationHarness();
  });

  it('computePayrollRunGlAmounts balances expense and credits', () => {
    const { runId } = seedPayrollRun(db, `PR-B-${Date.now()}`, '2026-08');
    const amounts = computePayrollRunGlAmounts(db, runId);
    expect(amounts.ok).toBe(true);
    expect(amounts.balanced).toBe(true);
    expect(amounts.expenseDr).toBe(100_000);
    expect(amounts.netCr).toBe(82_000);
  });

  it('tryPostPayrollAccrualGlTx posts Dr 6000 and liability credits', () => {
    const runId = `PR-GL-${Date.now()}`;
    seedPayrollRun(db, runId, '2026-09');
    const r = tryPostPayrollAccrualGlTx(db, runId, { createdByUserId: resolveTestActor(db).id });
    expect(r.ok).toBe(true);
    expect(r.journalId).toBeTruthy();
    const status = payrollGlStatusForRun(db, runId);
    expect(status.accrualPosted).toBe(true);
  });

  it('previewDepreciationRun excludes land category', () => {
    const suffix = Date.now();
    createFixedAsset(
      db,
      {
        name: `Plot ${suffix}`,
        category: 'land',
        branchId: 'BR-KD',
        acquisitionDateIso: '2024-01-01',
        costNgn: 50_000_000,
        usefulLifeMonths: 600,
      },
      resolveTestActor(db)
    );
    createFixedAsset(
      db,
      {
        name: `Press ${suffix}`,
        category: 'plant',
        branchId: 'BR-KD',
        acquisitionDateIso: '2024-01-01',
        costNgn: 12_000_000,
        salvageNgn: 0,
        usefulLifeMonths: 120,
      },
      resolveTestActor(db)
    );
    const pre = previewDepreciationRun(db, '2026-06', 'ALL');
    expect(pre.ok).toBe(true);
    const names = (pre.rows || []).map((r) => r.name);
    expect(names.some((n) => String(n).includes(`Press ${suffix}`))).toBe(true);
    expect(names.some((n) => String(n).includes(`Plot ${suffix}`))).toBe(false);
  });

  it('buildMonthEndCloseChecklist returns structured steps', () => {
    const checklist = buildMonthEndCloseChecklist(db, '2026-06', 'ALL', { trialExceptions: { exceptions: {} } });
    expect(checklist.ok).toBe(true);
    expect(Array.isArray(checklist.steps)).toBe(true);
    expect(checklist.steps.length).toBeGreaterThanOrEqual(5);
    const ids = checklist.steps.map((s) => s.id);
    expect(ids).toContain('opening_balance');
    expect(ids).toContain('statements');
  });
});
