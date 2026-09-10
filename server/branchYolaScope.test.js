import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { detectNearestBranch, haversineDistanceKm, DEFAULT_BRANCH_GEO } from './branchLocationDetect.js';
import { listManagementItems } from './readModel.js';
import { assertPaymentRequestIdInWorkspace } from './workspaceBranchGuards.js';

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

describe('branch location detection (pure)', () => {
  it('haversine is ~0 for same point and large for KD→YL', () => {
    const kd = DEFAULT_BRANCH_GEO['BR-KD'];
    const yl = DEFAULT_BRANCH_GEO['BR-YL'];
    expect(haversineDistanceKm(kd.latitude, kd.longitude, kd.latitude, kd.longitude)).toBeLessThan(0.01);
    const dist = haversineDistanceKm(kd.latitude, kd.longitude, yl.latitude, yl.longitude);
    expect(dist).toBeGreaterThan(400);
  });
});

describe.skipIf(!mysqlOk)('branch location detection (db)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('detects Yola when coords are near Yola', () => {
    const yl = DEFAULT_BRANCH_GEO['BR-YL'];
    const r = detectNearestBranch(db, yl.latitude + 0.01, yl.longitude - 0.01);
    expect(r.ok).toBe(true);
    expect(r.detectedBranchId).toBe('BR-YL');
    expect(r.withinRadius).toBe(true);
    expect(['high', 'medium']).toContain(r.confidence);
  });

  it('detects Kaduna near HQ and does not pick Yola', () => {
    const kd = DEFAULT_BRANCH_GEO['BR-KD'];
    const r = detectNearestBranch(db, kd.latitude, kd.longitude);
    expect(r.ok).toBe(true);
    expect(r.detectedBranchId).toBe('BR-KD');
  });

  it('returns no branch when far from all sites', () => {
    const r = detectNearestBranch(db, 0, 0, { maxRadiusKm: 75 });
    expect(r.ok).toBe(true);
    expect(r.detectedBranchId).toBeNull();
    expect(r.withinRadius).toBe(false);
  });
});

describe.skipIf(!mysqlOk)('management pending expenses are branch-scoped', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('Yola management/items excludes Kaduna pending payment requests', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    await agent.patch('/api/session/workspace').send({ currentBranchId: 'BR-KD', viewAllBranches: false });
    const kdReq = await agent.post('/api/payment-requests').send({
      requestDate: '2026-09-10',
      expenseCategory: 'Maintenance',
      description: 'Kaduna fuel',
      lineItems: [{ description: 'Fuel', quantity: 1, unitPriceNgn: 25000 }],
    });
    expect(kdReq.status).toBe(201);
    expect(kdReq.body.requestID).toBeTruthy();

    await agent.patch('/api/session/workspace').send({ currentBranchId: 'BR-YL', viewAllBranches: false });
    const ylReq = await agent.post('/api/payment-requests').send({
      requestDate: '2026-09-10',
      expenseCategory: 'Office expenses',
      description: 'Yola stationery',
      lineItems: [{ description: 'Stationery', quantity: 1, unitPriceNgn: 15000 }],
    });
    expect(ylReq.status).toBe(201);

    const items = await agent.get('/api/management/items');
    expect(items.status).toBe(200);
    const pendingIds = (items.body.pendingExpenses || []).map((p) => p.request_id);
    expect(pendingIds).toContain(ylReq.body.requestID);
    expect(pendingIds).not.toContain(kdReq.body.requestID);

    const scoped = listManagementItems(db, 'BR-YL');
    expect(scoped.pendingExpenses.map((p) => p.request_id)).not.toContain(kdReq.body.requestID);
    expect(scoped.pendingExpenses.map((p) => p.request_id)).toContain(ylReq.body.requestID);

    const all = listManagementItems(db, 'ALL');
    const allIds = all.pendingExpenses.map((p) => p.request_id);
    expect(allIds).toContain(kdReq.body.requestID);
    expect(allIds).toContain(ylReq.body.requestID);
  });

  it('branch manager without cross-branch post cannot act on another branch PR', async () => {
    const agent = request.agent(app);
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    await agent.patch('/api/session/workspace').send({ currentBranchId: 'BR-KD', viewAllBranches: false });
    const kdReq = await agent.post('/api/payment-requests').send({
      requestDate: '2026-09-10',
      expenseCategory: 'Maintenance',
      description: 'Kaduna only',
      lineItems: [{ description: 'Fuel', quantity: 1, unitPriceNgn: 12000 }],
    });
    expect(kdReq.status).toBe(201);

    const bmUser = {
      id: 'USR-BM-YL',
      roleKey: 'sales_manager',
      permissions: ['sales.manage', 'expenses.create'],
    };
    const gate = assertPaymentRequestIdInWorkspace(
      db,
      { user: bmUser, workspaceBranchId: 'BR-YL', workspaceViewAll: false },
      kdReq.body.requestID
    );
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe(403);
  });

  it('POST /api/session/detect-location returns Yola near Yola coords', async () => {
    const agent = request.agent(app);
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    const yl = DEFAULT_BRANCH_GEO['BR-YL'];
    const res = await agent.post('/api/session/detect-location').send({
      latitude: yl.latitude,
      longitude: yl.longitude,
      apply: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.detectedBranchId).toBe('BR-YL');
    expect(res.body.applied).toBe(true);
    expect(res.body.currentBranchId).toBe('BR-YL');
  });
});
