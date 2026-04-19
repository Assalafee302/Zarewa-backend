import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const openDbs = [];

afterAll(() => {
  for (const d of openDbs) {
    try {
      d.close();
    } catch {
      /* ignore */
    }
  }
});

describe('Edit approval (second-party token)', () => {
  it('blocks procurement_officer PO status PATCH without token; approves and consumes single-use token', async () => {
    const db = createDatabase(':memory:');
    openDbs.push(db);
    const app = createApp(db);
    const admin = request.agent(app);
    let res = await admin.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(200);

    const po = await admin.post('/api/purchase-orders').send({
      supplierID: 'SUP-001',
      supplierName: 'Test',
      orderDateISO: '2026-04-01',
      expectedDeliveryISO: '',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Alu',
          qtyOrdered: 100,
          unitPriceNgn: 100,
        },
      ],
      status: 'Pending',
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    expect(poId).toBeTruthy();

    const proc = request.agent(app);
    res = await proc.post('/api/session/login').send({ username: 'procurement', password: 'Procure@123' });
    expect(res.status).toBe(200);

    const denied = await proc
      .patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`)
      .send({ status: 'Approved' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('EDIT_APPROVAL_REQUIRED');

    const reqApproval = await proc.post('/api/edit-approvals/request').send({
      entityKind: 'purchase_order',
      entityId: poId,
    });
    expect(reqApproval.status).toBe(200);
    expect(reqApproval.body.ok).toBe(true);
    const aid = reqApproval.body.approvalId;
    expect(aid).toBeTruthy();

    const approve = await admin.post(`/api/edit-approvals/${encodeURIComponent(aid)}/approve`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);

    const ok1 = await proc.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`).send({
      status: 'Approved',
      editApprovalId: aid,
    });
    expect(ok1.status).toBe(200);
    expect(ok1.body.ok).toBe(true);

    const denied2 = await proc
      .patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`)
      .send({ status: 'Rejected' });
    expect(denied2.status).toBe(403);
  });

  it('admin may PATCH without editApprovalId', async () => {
    const db = createDatabase(':memory:');
    openDbs.push(db);
    const app = createApp(db);
    const admin = request.agent(app);
    await admin.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });

    const po = await admin.post('/api/purchase-orders').send({
      supplierID: 'SUP-001',
      supplierName: 'Test',
      orderDateISO: '2026-04-01',
      expectedDeliveryISO: '',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Alu',
          qtyOrdered: 50,
          unitPriceNgn: 100,
        },
      ],
      status: 'Pending',
    });
    const poId = po.body.poID;

    const r = await admin
      .patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`)
      .send({ status: 'Approved' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
