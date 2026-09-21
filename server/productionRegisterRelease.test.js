import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

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

describe.skipIf(!mysqlOk).sequential('production register cancel vs return-to-waiting', () => {
  let app;
  let agent;
  let db;

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }

  async function registerPlannedJob() {
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(job.status).toBe(201);
    return { cuttingListId: cutting.body.id, jobID: job.body.jobID };
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('cancel marks not produced and does not unlock Sales to edit or re-queue', async () => {
    const { cuttingListId, jobID } = await registerPlannedJob();
    const cancel = await agent.post(`/api/production-jobs/${encodeURIComponent(jobID)}/cancel`).send({
      reason: 'Customer changed mind — will not produce this order.',
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.outcome).toBe('cancelled_not_produced');
    expect(cancel.body.productionJob?.status).toBe('Cancelled');
    expect(cancel.body.cuttingList?.status).toBe('Cancelled');
    expect(cancel.body.cuttingList?.productionRegistered).toBe(true);
    expect(cancel.body.cuttingList?.productionCancelledNotProduced).toBe(true);

    const clPatch = await agent.patch(`/api/cutting-lists/${encodeURIComponent(cuttingListId)}`).send({
      lines: [{ sheets: 2, lengthM: 5 }],
    });
    expect(clPatch.status).toBe(400);
    expect(String(clPatch.body.error || '')).toMatch(/cancelled|change of mind|not produced/i);

    const q = await agent.get(`/api/quotations/${encodeURIComponent('QT-2026-005')}`);
    expect(q.status).toBe(200);
    const lines = q.body.quotation?.quotationLines;
    expect(lines).toBeTruthy();
    const qPatch = await agent.patch(`/api/quotations/${encodeURIComponent('QT-2026-005')}`).send({
      lines,
      materialTypeId: q.body.quotation?.materialTypeId,
      materialGauge: q.body.quotation?.materialGauge,
      materialColor: q.body.quotation?.materialColor,
      materialDesign: q.body.quotation?.materialDesign,
    });
    expect(qPatch.status).toBe(409);
    expect(qPatch.body.code).toBe('PRODUCTION_CANCELLED_NOT_PRODUCED');

    const requeue = await agent.post('/api/production-jobs').send({
      cuttingListId,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(requeue.status).toBe(400);
  });

  it('admin may edit quotation while still on the production register', async () => {
    await registerPlannedJob();
    const qBefore = await agent.get(`/api/quotations/${encodeURIComponent('QT-2026-005')}`);
    expect(qBefore.status).toBe(200);
    const qPatch = await agent.patch(`/api/quotations/${encodeURIComponent('QT-2026-005')}`).send({
      lines: qBefore.body.quotation?.quotationLines,
      materialTypeId: qBefore.body.quotation?.materialTypeId,
      materialGauge: qBefore.body.quotation?.materialGauge,
      materialColor: qBefore.body.quotation?.materialColor,
      materialDesign: qBefore.body.quotation?.materialDesign,
    });
    expect(qPatch.status).toBe(200);
  });

  it('return-to-waiting unlocks the cutting list and quotation for Sales, then allows re-register', async () => {
    const { cuttingListId, jobID } = await registerPlannedJob();

    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const qBefore = await salesAgent.get(`/api/quotations/${encodeURIComponent('QT-2026-005')}`);
    expect(qBefore.status).toBe(200);
    const blockedWhileRegistered = await salesAgent
      .patch(`/api/quotations/${encodeURIComponent('QT-2026-005')}`)
      .send({
        lines: qBefore.body.quotation?.quotationLines,
        materialTypeId: qBefore.body.quotation?.materialTypeId,
        materialGauge: qBefore.body.quotation?.materialGauge,
        materialColor: qBefore.body.quotation?.materialColor,
        materialDesign: qBefore.body.quotation?.materialDesign,
      });
    expect(blockedWhileRegistered.status).toBe(409);
    expect(blockedWhileRegistered.body.code).toBe('PRODUCTION_RETURN_TO_WAITING_REQUIRED');

    const released = await agent
      .post(`/api/production-jobs/${encodeURIComponent(jobID)}/return-to-waiting`)
      .send({ reason: 'Sales must revise lengths on the quotation before we produce.' });
    expect(released.status).toBe(200);
    expect(released.body.outcome).toBe('returned_to_waiting');
    expect(released.body.productionJob?.status).toBe('Returned');
    expect(released.body.cuttingList?.status).toBe('Waiting');
    expect(released.body.cuttingList?.productionRegistered).toBe(false);
    expect(String(released.body.cuttingList?.productionRegisterRef || '')).toBe('');

    const clPatch = await agent.patch(`/api/cutting-lists/${encodeURIComponent(cuttingListId)}`).send({
      lines: [{ sheets: 1, lengthM: 5, lineType: 'Roof' }],
    });
    expect(clPatch.status).toBe(200);

    const q = await salesAgent.get(`/api/quotations/${encodeURIComponent('QT-2026-005')}`);
    expect(q.status).toBe(200);
    const lines = q.body.quotation?.quotationLines;
    const qPatch = await salesAgent.patch(`/api/quotations/${encodeURIComponent('QT-2026-005')}`).send({
      lines,
      materialTypeId: q.body.quotation?.materialTypeId,
      materialGauge: q.body.quotation?.materialGauge,
      materialColor: q.body.quotation?.materialColor,
      materialDesign: q.body.quotation?.materialDesign,
    });
    expect(qPatch.status).toBe(200);

    const requeue = await agent.post('/api/production-jobs').send({
      cuttingListId,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(requeue.status).toBe(201);
    expect(requeue.body.productionJob?.status).toBe('Planned');
  });
});
