import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import { nowIso } from './hrOps.js';
import { staffObligationTablesReady } from './staffObligationOps.js';
import {
  backfillRecoveryObligationsFromSchedules,
  openRecoveryObligationFromSchedule,
  recoveryScheduleIdColumnReady,
  resolveObligationAccountIdForRecoverySchedule,
} from './staffRecoveryObligationOps.js';

describe.skipIf(!isMysqlAvailableForTests())('staffRecoveryObligationOps', () => {
  let db;
  let actor;
  let staffUserId;
  let scheduleId;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    actor = resolveTestActor(db);
    const staff = db.prepare(`SELECT user_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    expect(staffUserId).toBeTruthy();
    expect(staffObligationTablesReady(db)).toBe(true);
    expect(recoverySchedulesTableReady(db)).toBe(true);
    expect(recoveryScheduleIdColumnReady(db)).toBe(true);

    scheduleId = `HRRcv-TEST-${Date.now()}`;
    const caseId = `HRCase-TEST-${Date.now()}`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO hr_discipline_cases (id, case_number, user_id, branch_id, status, opened_at_iso)
       VALUES (?, ?, ?, 'KD', 'closed', ?)`
    ).run(caseId, `DC-TEST-${Date.now()}`, staffUserId, now);

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
      120_000,
      20_000,
      6,
      120_000,
      0,
      1,
      'active',
      now,
      now,
      actor?.id || null
    );
  });

  it('opens recovery obligation from schedule', () => {
    const r = openRecoveryObligationFromSchedule(db, scheduleId, actor);
    expect(r.ok).toBe(true);
    expect(r.account?.kind).toBe('recovery');
    expect(r.account?.principalOutstandingNgn).toBe(120_000);

    const linked = resolveObligationAccountIdForRecoverySchedule(db, scheduleId);
    expect(linked).toBe(r.account.id);
  });

  it('backfill is idempotent for linked schedules', () => {
    const first = backfillRecoveryObligationsFromSchedules(db);
    expect(first.ok).toBe(true);
    expect(first.skipped).toBeGreaterThanOrEqual(1);

    const second = backfillRecoveryObligationsFromSchedules(db);
    expect(second.ok).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });
});
