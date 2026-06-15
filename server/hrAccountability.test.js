import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness } from './testIntegrationHarness.js';
import { createDisciplineCase } from './hrDisciplineCasesOps.js';
import { createIncident, escalateIncidentMemo } from './incidentOps.js';
import {
  upsertCaseResponsibility,
  assertCaseClosureReady,
  validateResponsibilityParties,
} from './hrAccountabilityOps.js';
import { createRecoverySchedulesFromCase } from './hrIncidentRecoveryOps.js';
import { applyDecisionActions } from './hrDisciplineCasesOps.js';

describe('hrAccountability integration', () => {
  let app;
  let db;
  let adminCookie;
  let staffUserId;

  beforeAll(async () => {
    const harness = acquireIntegrationHarness();
    app = harness.app;
    db = harness.db;
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
      { id: 'admin', displayName: 'Admin' },
      {}
    );
    expect(r.ok).toBe(true);
    expect(r.registryId).toBeTruthy();
    const reg = db.prepare(`SELECT * FROM incident_registry WHERE id = ?`).get(r.registryId);
    expect(reg?.incident_kind).toBe('hr_discipline');
  });

  it('escalateIncidentMemo creates discipline case not legacy JSON', () => {
    const memo = db
      .prepare(
        `INSERT INTO hr_incident_memos (id, branch_id, user_id, reported_by_user_id, incident_date_iso, summary, status, created_at_iso, updated_at_iso)
         VALUES ('HRINC-test1','KD',?,'admin',date('now'),'Test memo escalate', 'open', datetime('now'), datetime('now'))`
      )
      .run(staffUserId);
    expect(memo.changes).toBe(1);
    const esc = escalateIncidentMemo(db, 'HRINC-test1', { id: 'admin' }, {});
    expect(esc.ok).toBe(true);
    expect(esc.caseId).toBeTruthy();
    const row = db.prepare(`SELECT discipline_case_id FROM hr_incident_memos WHERE id = 'HRINC-test1'`).get();
    expect(row?.discipline_case_id).toBe(esc.caseId);
  });

  it('pump-case style: 4-party responsibility and recovery schedules', () => {
    const c = createDisciplineCase(db, { id: 'admin' }, {
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
    const resp = upsertCaseResponsibility(db, { id: 'admin' }, c.id, parties);
    expect(resp.ok).toBe(true);
    const caseRow = db.prepare(`SELECT loss_value_ngn FROM hr_discipline_cases WHERE id = ?`).get(c.id);
    expect(Number(caseRow?.loss_value_ngn)).toBe(700000);
    const sched = createRecoverySchedulesFromCase(db, { id: 'admin' }, c.id, { activate: true, durationMonths: 12 });
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
    const c = createDisciplineCase(db, { id: 'admin' }, {
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

    upsertCaseResponsibility(db, { id: 'admin' }, c.id, [
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

    createRecoverySchedulesFromCase(db, { id: 'admin' }, c.id, { activate: true, durationMonths: 6 });
    const ready = assertCaseClosureReady(db, c.id);
    expect(ready.ok).toBe(true);
  });
});
