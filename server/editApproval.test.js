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
  it('blocks finance_manager PO status PATCH without token; approves and consumes single-use token', async () => {
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
    res = await proc.post('/api/session/login').send({ username: 'finance.manager', password: 'Finance@123' });
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
    expect(aid).toMatch(/^\d{6}$/);

    const dup = await proc.post('/api/edit-approvals/request').send({
      entityKind: 'purchase_order',
      entityId: poId,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.ok).toBe(false);
    expect(dup.body.code).toBe('EDIT_APPROVAL_ALREADY_PENDING');
    expect(dup.body.existingApprovalId).toBe(aid);

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

  it('sales staff may PATCH quotation without token when no receipts exist', async () => {
    const db = createDatabase(':memory:');
    openDbs.push(db);
    const app = createApp(db);
    const staff = request.agent(app);
    await staff.post('/api/session/login').send({ username: 'sales.staff', password: 'Sales@123' });

    const created = await staff.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'No receipt edit',
      dateISO: '2026-04-01',
      lines: {
        products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '5000' }],
        accessories: [],
        services: [],
      },
    });
    expect(created.status).toBe(201);
    const qid = created.body.quotationId;

    const patch = await staff.patch(`/api/quotations/${encodeURIComponent(qid)}`).send({
      customerFeedback: 'Updated before payment',
      status: 'Approved',
    });
    expect(patch.status).toBe(200);
    expect(patch.body?.ok).toBe(true);
    expect(patch.body?.quotation?.customerFeedback).toBe('Updated before payment');
  });

  it('sales staff PATCH quotation requires token once a receipt is posted', async () => {
    const db = createDatabase(':memory:');
    openDbs.push(db);
    const app = createApp(db);
    const admin = request.agent(app);
    await admin.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    const before = await admin.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;

    const staff = request.agent(app);
    await staff.post('/api/session/login').send({ username: 'sales.staff', password: 'Sales@123' });

    const created = await staff.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Receipt gated edit',
      dateISO: '2026-04-01',
      lines: {
        products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '5000' }],
        accessories: [],
        services: [],
      },
    });
    expect(created.status).toBe(201);
    const qid = created.body.quotationId;

    const receipt = await admin.post('/api/ledger/receipt').send({
      customerID: 'CUS-001',
      quotationId: qid,
      amountNgn: 10_000,
      paymentMethod: 'Cash',
      bankReference: 'RCP-GATE-TEST',
      dateISO: '2026-04-01',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 10_000, reference: 'RCP-GATE-TEST' }],
    });
    expect(receipt.status).toBe(201);

    const blocked = await staff.patch(`/api/quotations/${encodeURIComponent(qid)}`).send({
      customerFeedback: 'Should need approval',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body?.code).toBe('EDIT_APPROVAL_REQUIRED');
    expect(String(blocked.body?.error || '')).toMatch(/receipts on file/i);
  });
});
