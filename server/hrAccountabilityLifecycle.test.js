/**
 * Full HR accountability lifecycle simulation — asset loss, responsibility, payroll recovery,
 * audit pack, memo escalation, edge cases, and positive performance routing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { acquireIntegrationHarness } from './testIntegrationHarness.js';
import { createIncident, escalateIncidentMemo } from './incidentOps.js';
import {
  upsertCaseResponsibility,
  assertCaseClosureReady,
  validateResponsibilityParties,
  normalizeDecisionType,
} from './hrAccountabilityOps.js';
import {
  applyDecisionActions,
  patchDisciplineCase,
  getDisciplineCase,
} from './hrDisciplineCasesOps.js';
import {
  listRecoverySchedulesForCase,
  listRecoverySchedulesForUser,
} from './hrIncidentRecoveryOps.js';
import { buildIncidentAuditPack } from './incidentAuditPackOps.js';
import {
  computePayrollRun,
  createPayrollRun,
  listPayrollLines,
  patchPayrollRun,
} from './hrOps.js';
import { recordAssetCustodyEvent, recordGatePassEvent } from './assetCustodyOps.js';

const ACTOR = { id: 'admin', displayName: 'Admin', username: 'admin' };
const LOSS_NGN = 700_000;
const ASSET_ID = 'PUMP-FACT-002';

function ensureStaffPool(db, min = 4) {
  const rows = db
    .prepare(
      `SELECT u.id FROM app_users u
       JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE u.status = 'active'
       ORDER BY u.username ASC
       LIMIT ?`
    )
    .all(min);
  const ids = rows.map((r) => r.id);
  let n = ids.length;
  while (n < min) {
    n += 1;
    const uid = `hr-test-staff-${n}`;
    const uname = `hr.test.staff${n}`;
    try {
      db.prepare(
        `INSERT INTO app_users (id, username, display_name, password_hash, role_key, status, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(uid, uname, `HR Test Staff ${n}`, 'x', 'sales_staff', 'active', new Date().toISOString());
    } catch {
      /* exists */
    }
    try {
      db.prepare(
        `INSERT INTO hr_staff_profiles (user_id, branch_id, base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, payroll_group)
         VALUES (?,?,?,?,?,?)`
      ).run(uid, 'KD', 120_000 + n * 10_000, 20_000, 10_000, 'branch_ops');
    } catch {
      db.prepare(
        `UPDATE hr_staff_profiles SET base_salary_ngn = ?, payroll_group = 'branch_ops' WHERE user_id = ?`
      ).run(120_000 + n * 10_000, uid);
    }
    ids.push(uid);
  }
  return ids.slice(0, min);
}

function fourPartyMap(staffIds) {
  const roles = ['custodian', 'supervisor', 'operator', 'security'];
  return staffIds.slice(0, 4).map((userId, i) => ({
    userId,
    role: roles[i],
    responsibilityWeight: 25,
    contributionType: 'negligence',
  }));
}

function uniquePeriod() {
  const d = new Date();
  const y = d.getFullYear();
  const m = ((d.getMonth() + Math.floor(Math.random() * 9) + 1) % 12) + 1;
  return `${y}${String(m).padStart(2, '0')}`;
}

describe('HR accountability full lifecycle simulation', () => {
  let app;
  let db;
  let staffIds;

  beforeAll(async () => {
    const harness = acquireIntegrationHarness();
    app = harness.app;
    db = harness.db;
    staffIds = ensureStaffPool(db, 4);
    await request(app).post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
  });

  describe('1 — Incident creation (asset loss / missing factory pump)', () => {
    it('registers operational incident, discipline case, registry, and loss metadata', () => {
      const r = createIncident(
        db,
        {
          incidentCategory: 'operational',
          incidentType: 'asset_loss',
          title: 'Missing factory pump',
          summary: 'Missing factory pump — PUMP-FACT-002 not found after night shift in factory store.',
          lossValueNgn: LOSS_NGN,
          location: 'factory store',
          assetId: ASSET_ID,
          severity: 'critical',
          userId: staffIds[0],
          shift: 'night shift',
          involvedStaffIds: staffIds,
        },
        ACTOR,
        {}
      );
      expect(r.ok).toBe(true);
      expect(r.registryId).toBeTruthy();
      expect(r.caseId).toBeTruthy();
      expect(r.caseRegistryId).toBeTruthy();

      const op = db.prepare(`SELECT * FROM operational_incidents WHERE id = ?`).get(r.id);
      expect(op?.asset_id).toBe(ASSET_ID);
      expect(Number(op?.loss_value_ngn)).toBe(LOSS_NGN);

      const reg = db.prepare(`SELECT * FROM incident_registry WHERE id = ?`).get(r.registryId);
      expect(reg?.incident_kind).toBe('operational');

      const c = getDisciplineCase(db, r.caseId);
      expect(c).toBeTruthy();
      expect(Number(c.lossValueNgn)).toBe(LOSS_NGN);
      expect(c.assetId).toBe(ASSET_ID);
      expect(c.registryId).toBeTruthy();
    });
  });

  describe('2 — Responsibility allocation (multi-party engine)', () => {
    it('accepts valid 100% map and rejects invalid totals', () => {
      const parties = fourPartyMap(staffIds);
      expect(validateResponsibilityParties(parties).ok).toBe(true);
      expect(validateResponsibilityParties([{ ...parties[0], responsibilityWeight: 50 }]).ok).toBe(false);

      const created = createIncident(
        db,
        {
          incidentCategory: 'hr',
          userId: staffIds[0],
          description: 'Responsibility map validation case for missing pump accountability test.',
          caseType: 'property_damage',
          lossValueNgn: LOSS_NGN,
          assetId: ASSET_ID,
        },
        ACTOR,
        {}
      );
      const c = created.caseId;

      const bad = upsertCaseResponsibility(db, ACTOR, c, [
        { userId: staffIds[0], role: 'custodian', responsibilityWeight: 40, contributionType: 'negligence' },
        { userId: staffIds[1], role: 'supervisor', responsibilityWeight: 40, contributionType: 'negligence' },
      ]);
      expect(bad.ok).toBe(false);

      const good = upsertCaseResponsibility(db, ACTOR, c, parties);
      expect(good.ok).toBe(true);
      const stored = db.prepare(`SELECT COUNT(*) AS c FROM incident_responsibility_map WHERE case_id = ?`).get(c);
      expect(stored.c).toBe(4);
    });
  });

  describe('3 — Management decision + sanction enforcement', () => {
    it('maps salary_deduction alias and creates recovery + letter events per party', () => {
      expect(normalizeDecisionType('salary_deduction')).toBe('deduction');

      const created = createIncident(
        db,
        {
          incidentCategory: 'hr',
          userId: staffIds[0],
          description: 'Management decision enforcement for missing factory pump recovery.',
          caseType: 'property_damage',
          lossValueNgn: LOSS_NGN,
          assetId: ASSET_ID,
        },
        ACTOR,
        {}
      );
      const c = created.caseId;

      upsertCaseResponsibility(db, ACTOR, c, fourPartyMap(staffIds));
      const decision = applyDecisionActions(db, ACTOR, c, 'salary_deduction', {
        sanction: `Recover full ${LOSS_NGN} split equally across responsible staff`,
      });
      expect(decision.ok).toBe(true);
      expect(decision.decisionType).toBe('deduction');

      const schedules = listRecoverySchedulesForCase(db, c);
      expect(schedules.length).toBe(4);
      for (const s of schedules) {
        expect(s.totalAmountNgn).toBe(175_000);
        expect(s.status).toBe('active');
      }

      const letterEvents = db
        .prepare(
          `SELECT COUNT(*) AS c FROM hr_discipline_case_events WHERE case_id = ? AND event_kind = 'letter_issued'`
        )
        .get(c);
      expect(letterEvents.c).toBeGreaterThanOrEqual(4);
    });
  });

  describe('4 — Payroll recovery validation', () => {
    it('applies monthly deductions with incident reference on payslip lines', () => {
      const created = createIncident(
        db,
        {
          incidentCategory: 'hr',
          userId: staffIds[0],
          description: 'Payroll recovery validation for pump accountability lifecycle test.',
          caseType: 'property_damage',
          lossValueNgn: LOSS_NGN,
          assetId: ASSET_ID,
        },
        ACTOR,
        {}
      );
      const c = created.caseId;

      upsertCaseResponsibility(db, ACTOR, c, fourPartyMap(staffIds));
      applyDecisionActions(db, ACTOR, c, 'deduction');

      const run = createPayrollRun(db, ACTOR, { periodYyyymm: uniquePeriod(), notes: 'Accountability lifecycle test' });
      expect(run.ok).toBe(true);

      const computed = computePayrollRun(db, run.id);
      expect(computed.ok).toBe(true);

      for (const uid of staffIds) {
        const line = listPayrollLines(db, run.id).find((l) => l.userId === uid);
        expect(line).toBeTruthy();
        expect(line.incidentRecoveryNgn).toBeGreaterThan(0);
        expect(line.incidentRecoveries?.length).toBeGreaterThan(0);
      }

      patchPayrollRun(db, run.id, { status: 'paid' }, ACTOR);
      for (const uid of staffIds) {
        const row = db
          .prepare(
            `SELECT principal_outstanding_ngn FROM hr_incident_recovery_schedules WHERE case_id = ? AND user_id = ?`
          )
          .get(c, uid);
        expect(Number(row?.principal_outstanding_ngn)).toBeLessThan(175_000);
      }
    });
  });

  describe('5 — Closure gate validation', () => {
    it('blocks closure until all requirements met, then allows close', () => {
      const created = createIncident(
        db,
        {
          incidentCategory: 'hr',
          userId: staffIds[0],
          description: 'Closure gate validation for accountability lifecycle simulation.',
          caseType: 'property_damage',
          lossValueNgn: LOSS_NGN,
        },
        ACTOR,
        {}
      );
      const c = created.caseId;

      const blocked = assertCaseClosureReady(db, c);
      expect(blocked.ok).toBe(false);
      expect(blocked.blockers.length).toBeGreaterThan(0);

      upsertCaseResponsibility(db, ACTOR, c, [
        { userId: staffIds[0], role: 'custodian', responsibilityWeight: 100, contributionType: 'negligence' },
      ]);
      applyDecisionActions(db, ACTOR, c, 'salary_deduction');

      expect(assertCaseClosureReady(db, c).ok).toBe(true);

      const closed = patchDisciplineCase(db, ACTOR, c, { action: 'close' });
      expect(closed.ok).toBe(true);
      expect(getDisciplineCase(db, c).status).toBe('closed');
    });
  });

  describe('6 — Full audit pack generation', () => {
    it('returns cross-module investigation payload', () => {
      const created = createIncident(
        db,
        {
          incidentCategory: 'operational',
          incidentType: 'asset_loss',
          title: 'Missing factory pump audit pack',
          summary: 'Missing factory pump audit pack test for cross-module traceability validation.',
          lossValueNgn: LOSS_NGN,
          assetId: ASSET_ID,
          userId: staffIds[0],
          location: 'factory store',
        },
        ACTOR,
        {}
      );
      const caseId = created.caseId;
      upsertCaseResponsibility(db, ACTOR, caseId, fourPartyMap(staffIds));
      applyDecisionActions(db, ACTOR, caseId, 'deduction');
      recordAssetCustodyEvent(db, ACTOR, {
        assetId: ASSET_ID,
        custodianUserId: staffIds[0],
        eventType: 'report_missing',
        note: 'Pump missing at night shift handover',
      });
      recordGatePassEvent(db, ACTOR, {
        passDateIso: new Date().toISOString().slice(0, 10),
        direction: 'out',
        personnelSummary: 'Night shift exit — pump area',
        notes: 'Security log for audit pack test',
      });

      const result = buildIncidentAuditPack(db, created.caseRegistryId || created.registryId);
      expect(result.ok).toBe(true);
      expect(result.pack.registry).toBeTruthy();
      expect(result.pack.responsibility?.length).toBe(4);
      expect(result.pack.recoverySchedules?.length).toBe(4);
    });
  });

  describe('7 — Incident memo escalation', () => {
    it('creates discipline case + registry without legacy profile JSON', () => {
      const memoId = `HRINC-lifecycle-${crypto.randomBytes(4).toString('hex')}`;
      db.prepare(
        `INSERT INTO hr_incident_memos (id, branch_id, user_id, reported_by_user_id, incident_date_iso, summary, status, created_at_iso, updated_at_iso)
         VALUES (?,?,?,?,?,?, 'open', datetime('now'), datetime('now'))`
      ).run(
        memoId,
        'KD',
        staffIds[0],
        ACTOR.id,
        new Date().toISOString().slice(0, 10),
        'Storekeeper failed to report missing pump during shift handover'
      );

      const esc = escalateIncidentMemo(db, memoId, ACTOR, {});
      expect(esc.ok).toBe(true);
      expect(esc.caseId).toBeTruthy();
      expect(esc.registryId).toBeTruthy();

      const memo = db.prepare(`SELECT * FROM hr_incident_memos WHERE id = ?`).get(memoId);
      expect(memo.discipline_case_id).toBe(esc.caseId);
      expect(memo.registry_id).toBe(esc.registryId);

      const prof = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(staffIds[0]);
      const extra = prof?.profile_extra_json ? JSON.parse(prof.profile_extra_json) : {};
      expect(Array.isArray(extra.disciplinaryEvents)).toBeFalsy();
    });
  });

  describe('8 — Edge case: incomplete theft/fraud incident', () => {
    it('rejects missing asset, staff, and location', () => {
      const r = createIncident(
        db,
        {
          incidentCategory: 'hr',
          description: 'Incomplete theft fraud case missing required accountability fields.',
          caseType: 'theft_fraud',
          severity: 'high',
        },
        ACTOR,
        {}
      );
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/required/i);
    });
  });

  describe('9 — Positive performance routing', () => {
    it('routes to recognition engine, not discipline', () => {
      const r = createIncident(
        db,
        {
          incidentCategory: 'performance',
          incidentType: 'performance_excellence',
          userId: staffIds[2],
          summary: 'Operator C achieved 40% above target output — excellence recognition record.',
          outputAboveTargetPct: 40,
        },
        ACTOR,
        {}
      );
      expect(r.ok).toBe(true);
      expect(r.routedTo).toBe('recognition');
      expect(r.bonusEligibilitySuggested).toBe(true);
      expect(r.disciplineCaseCreated).toBe(false);
      expect(r.registryId).toBeTruthy();

      const reg = db.prepare(`SELECT incident_kind FROM incident_registry WHERE id = ?`).get(r.registryId);
      expect(reg?.incident_kind).toBe('performance');
    });
  });

  describe('10 — End-to-end real case simulation (missing ₦700,000 pump)', () => {
    it('runs full lifecycle with traceability across modules', () => {
      const incidentDate = new Date().toISOString().slice(0, 10);

      const step1 = createIncident(
        db,
        {
          incidentCategory: 'operational',
          incidentType: 'asset_loss',
          title: 'Missing factory pump',
          summary: 'E2E: Factory pump PUMP-FACT-002 missing after night shift — value ₦700,000.',
          lossValueNgn: LOSS_NGN,
          assetId: ASSET_ID,
          location: 'factory store',
          shift: 'night shift',
          severity: 'critical',
          userId: staffIds[0],
          incidentDateIso: incidentDate,
          involvedStaffIds: staffIds,
        },
        ACTOR,
        {}
      );
      expect(step1.ok).toBe(true);
      const caseId = step1.caseId;
      const registryId = step1.caseRegistryId || step1.registryId;

      upsertCaseResponsibility(db, ACTOR, caseId, fourPartyMap(staffIds));

      recordAssetCustodyEvent(db, ACTOR, {
        assetId: ASSET_ID,
        custodianUserId: staffIds[0],
        eventType: 'assign',
        shiftDayIso: incidentDate,
        note: 'Pump assigned to storekeeper A',
      });
      recordAssetCustodyEvent(db, ACTOR, {
        assetId: ASSET_ID,
        eventType: 'report_missing',
        shiftDayIso: incidentDate,
        note: 'Pump reported missing at handover',
      });
      recordGatePassEvent(db, ACTOR, {
        passDateIso: incidentDate,
        direction: 'out',
        personnelSummary: 'Staff B,C,D — night shift exit',
        notes: 'Gate log E2E pump case',
      });

      expect(applyDecisionActions(db, ACTOR, caseId, 'salary_deduction').ok).toBe(true);

      const schedules = listRecoverySchedulesForCase(db, caseId);
      expect(schedules.length).toBe(4);
      expect(schedules.reduce((s, x) => s + x.totalAmountNgn, 0)).toBe(LOSS_NGN);

      const run = createPayrollRun(db, ACTOR, { periodYyyymm: uniquePeriod(), notes: 'E2E pump payroll' });
      expect(run.ok).toBe(true);
      computePayrollRun(db, run.id);

      for (const uid of staffIds) {
        const line = listPayrollLines(db, run.id).find((l) => l.userId === uid);
        expect(line?.incidentRecoveryNgn).toBeGreaterThan(0);
      }

      const audit = buildIncidentAuditPack(db, step1.caseRegistryId);
      expect(audit.ok).toBe(true);
      expect(audit.pack.responsibility.length).toBe(4);

      expect(assertCaseClosureReady(db, caseId).ok).toBe(true);
      expect(patchDisciplineCase(db, ACTOR, caseId, { action: 'close' }).ok).toBe(true);

      const orphanOps = db
        .prepare(`SELECT COUNT(*) AS c FROM operational_incidents WHERE id = ? AND registry_id IS NOT NULL`)
        .get(step1.id);
      expect(orphanOps.c).toBe(1);
    });
  });
});
