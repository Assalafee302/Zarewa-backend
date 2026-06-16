import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor, isoNow } from './testIntegrationHarness.js';
import { createHrIncidentMemo } from './hrOps.js';
import { createDisciplineCase } from './hrDisciplineCasesOps.js';
import { createIncident, escalateIncidentMemo } from './incidentOps.js';
import {
  upsertCaseResponsibility,
  assertCaseClosureReady,
  validateResponsibilityParties,
} from './hrAccountabilityOps.js';
import { createRecoverySchedulesFromCase } from './hrIncidentRecoveryOps.js';
import { applyDecisionActions, getDisciplineCase, patchDisciplineCase, fileDisciplineCaseAppeal } from './hrDisciplineCasesOps.js';

describe.skipIf(!isMysqlAvailableForTests())('hrAccountability integration', () => {
  let app;
  let db;
  let adminCookie;
  let staffUserId;
  let actor;

  beforeAll(async () => {
    const harness = acquireIntegrationHarness();
    app = harness.app;
    db = harness.db;
    actor = resolveTestActor(db);
    const login = await request(app).post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    adminCookie = login.headers['set-cookie'];
    const staff = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.staff' LIMIT 1`).get();
    staffUserId = staff?.id || db.prepare(`SELECT id FROM app_users LIMIT 1`).get()?.id;
  });

  it('validateResponsibilityParties requires 100% total', () => {
    expect(validateResponsibilityParties([]).ok).toBe(false);
    expect(
      validateResponsibilityParties([
        { userId: 'u1', role: 'custodian', responsibilityWeight: 50, contributionType: 'negligence' },
      ]).ok
    ).toBe(false);
    expect(
      validateResponsibilityParties([
        { userId: 'u1', role: 'custodian', responsibilityWeight: 100, contributionType: 'negligence' },
      ]).ok
    ).toBe(true);
  });

  it('createIncident hr discipline registers in incident_registry', () => {
    const r = createIncident(
      db,
      {
        incidentCategory: 'hr',
        userId: staffUserId,
        description: 'Test accountability incident for registry sync validation.',
        caseType: 'negligence',
        severity: 'high',
      },
      { id: actor.id, displayName: actor.displayName },
      {}
    );
    expect(r.ok).toBe(true);
    expect(r.registryId).toBeTruthy();
    const reg = db.prepare(`SELECT * FROM incident_registry WHERE id = ?`).get(r.registryId);
    expect(reg?.incident_kind).toBe('hr_discipline');
  });

  it('createHrIncidentMemo notifies HR reviewers', () => {
    const now = isoNow();
    const day = now.slice(0, 10);
    const before = db.prepare(`SELECT COUNT(*) AS c FROM hr_notifications WHERE entity_kind = 'hr_incident_memo'`).get()?.c || 0;
    const r = createHrIncidentMemo(db, actor.id, {
      userId: staffUserId,
      incidentDateIso: day,
      summary: 'Notification test memo for HR queue.',
    });
    expect(r.ok).toBe(true);
    const after = db.prepare(`SELECT COUNT(*) AS c FROM hr_notifications WHERE entity_kind = 'hr_incident_memo'`).get()?.c || 0;
    expect(after).toBeGreaterThan(before);
  });

  it('escalateIncidentMemo creates discipline case not legacy JSON', () => {
    const now = isoNow();
    const day = now.slice(0, 10);
    db.prepare(
      `INSERT INTO hr_incident_memos (id, branch_id, user_id, reported_by_user_id, incident_date_iso, summary, status, created_at_iso, updated_at_iso)
       VALUES ('HRINC-test1','KD',?,?,?,?, 'open', ?, ?)`
    ).run(staffUserId, actor.id, day, 'Test memo escalate', now, now);
    const esc = escalateIncidentMemo(db, 'HRINC-test1', actor, {});
    expect(esc.ok).toBe(true);
    expect(esc.caseId).toBeTruthy();
    const row = db.prepare(`SELECT discipline_case_id FROM hr_incident_memos WHERE id = 'HRINC-test1'`).get();
    expect(row?.discipline_case_id).toBe(esc.caseId);
  });

  it('pump-case style: 4-party responsibility and recovery schedules', () => {
    const c = createDisciplineCase(db, actor, {
      userId: staffUserId,
      description: 'Missing factory pump shared negligence test case.',
      caseType: 'property_damage',
      severity: 'critical',
      lossValueNgn: 700000,
    });
    expect(c.ok).toBe(true);
    const users = db.prepare(`SELECT id FROM app_users WHERE status = 'active' LIMIT 4`).all();
    expect(users.length).toBeGreaterThanOrEqual(1);
    const parties = users.slice(0, Math.min(4, users.length)).map((u, i) => ({
      userId: u.id,
      role: ['custodian', 'supervisor', 'security', 'operator'][i] || 'other',
      responsibilityWeight: users.length >= 4 ? 25 : 100 / users.length,
      contributionType: 'negligence',
    }));
    if (users.length < 4) {
      parties[0].responsibilityWeight = 100;
    }
    const sum = parties.reduce((s, p) => s + p.responsibilityWeight, 0);
    if (Math.abs(sum - 100) > 0.01 && parties.length >= 4) {
      parties.forEach((p) => {
        p.responsibilityWeight = 25;
      });
    }
    const resp = upsertCaseResponsibility(db, actor, c.id, parties);
    expect(resp.ok).toBe(true);
    const caseRow = db.prepare(`SELECT loss_value_ngn FROM hr_discipline_cases WHERE id = ?`).get(c.id);
    expect(Number(caseRow?.loss_value_ngn)).toBe(700000);
    const sched = createRecoverySchedulesFromCase(db, actor, c.id, { activate: true, durationMonths: 12 });
    expect(sched.ok).toBe(true);
    expect(sched.schedules.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/incidents requires auth', async () => {
    const res = await request(app).get('/api/incidents');
    expect(res.status).toBe(401);
  });

  it('GET /api/incidents lists registry when authed', async () => {
    const res = await request(app).get('/api/incidents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.incidents)).toBe(true);
  });

  it('assertCaseClosureReady blocks until decision and recovery rules met', () => {
    const c = createDisciplineCase(db, actor, {
      userId: staffUserId,
      description: 'Closure gate validation for pump-style accountability case.',
      caseType: 'property_damage',
      severity: 'high',
      lossValueNgn: 500000,
    });
    expect(c.ok).toBe(true);
    const blocked = assertCaseClosureReady(db, c.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.length).toBeGreaterThan(0);

    upsertCaseResponsibility(db, actor, c.id, [
      {
        userId: staffUserId,
        role: 'custodian',
        responsibilityWeight: 100,
        contributionType: 'negligence',
      },
    ]);
    db.prepare(`UPDATE hr_discipline_cases SET decision_type = 'deduction' WHERE id = ?`).run(c.id);
    const stillBlocked = assertCaseClosureReady(db, c.id);
    expect(stillBlocked.ok).toBe(false);

    createRecoverySchedulesFromCase(db, actor, c.id, { activate: true, durationMonths: 6 });
    const needsLetters = assertCaseClosureReady(db, c.id);
    expect(needsLetters.ok).toBe(false);
    expect(needsLetters.blockers.some((b) => /letter/i.test(b))).toBe(true);

    const decision = applyDecisionActions(db, actor, c.id, 'deduction');
    expect(decision.ok).toBe(true);
    const needsIssued = assertCaseClosureReady(db, c.id);
    expect(needsIssued.ok).toBe(false);
    expect(needsIssued.blockers.some((b) => /issued/i.test(b))).toBe(true);

    const detail = getDisciplineCase(db, c.id);
    for (const letterId of detail?.relatedLetterIds || []) {
      db.prepare(`UPDATE hr_employment_letters SET status = 'issued', reference_number = ? WHERE id = ?`).run(
        `REF-${letterId}`,
        letterId
      );
    }
    const ready = assertCaseClosureReady(db, c.id);
    expect(ready.ok).toBe(true);
  });

  it('resolve_appeal notifies employee of outcome', () => {
    const c = createDisciplineCase(db, actor, {
      userId: staffUserId,
      description: 'Appeal notification test case for employee inbox.',
      caseType: 'query',
      severity: 'medium',
    });
    expect(c.ok).toBe(true);
    fileDisciplineCaseAppeal(db, { id: staffUserId }, c.id, {
      grounds: 'I disagree with the findings and request a review of the evidence presented.',
    });
    const before = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'discipline_appeal_rejected'`
      )
      .get(staffUserId)?.c || 0;
    const resolved = patchDisciplineCase(db, actor, c.id, { action: 'resolve_appeal', appealOutcome: 'rejected' });
    expect(resolved.ok).toBe(true);
    const after = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hr_notifications WHERE user_id = ? AND kind = 'discipline_appeal_rejected'`
      )
      .get(staffUserId)?.c || 0;
    expect(after).toBeGreaterThan(before);
  });
});
