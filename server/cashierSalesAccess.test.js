import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { withTestQuotationMaterial } from './testQuotationFixtures.js';

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

describe.skipIf(!mysqlOk)('cashier sales desk access', () => {
  let db;
  let app;

  async function loginAs(agent, username, password) {
    const res = await agent.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    app = undefined;
  });

  it('lets cashier create a quotation, receipt, and cutting list', async () => {
    const cashier = request.agent(app);
    const login = await loginAs(cashier, 'cashier', 'Cashier@12345!');
    const perms = login.body.user?.permissions || login.body.permissions || [];
    expect(perms).toEqual(expect.arrayContaining(['sales.view', 'quotations.manage', 'receipts.post', 'customers.manage']));

    const boot = await cashier.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const treasuryAccountId = boot.body.treasuryAccounts?.[0]?.id;
    expect(treasuryAccountId).toBeTruthy();

    const quote = await cashier.post('/api/quotations').send(
      withTestQuotationMaterial({
        customerID: 'CUS-001',
        projectName: `Cashier quote ${Date.now()}`,
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '5000' }],
          accessories: [],
          services: [],
        },
      })
    );
    expect(quote.status).toBe(201);
    const quotationId =
      quote.body.quotationId || quote.body.quotation?.id || quote.body.quotation?.quotationID;
    expect(String(quotationId || '')).toMatch(/^QT-/);

    const receipt = await cashier.post('/api/ledger/receipt').send({
      customerID: 'CUS-001',
      quotationId,
      amountNgn: 5000,
      paymentMethod: 'Cash',
      dateISO: '2026-03-29',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 5000, reference: 'CASHIER-SALES' }],
    });
    expect(receipt.status).toBe(201);

    const cutting = await cashier.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      operatorName: 'Cashier',
      lines: [
        { sheets: 1, lengthM: 6 },
        { sheets: 1, lengthM: 4.5 },
      ],
    });
    expect(cutting.status).toBe(201);
    expect(cutting.body.id || cutting.body.cuttingList?.id).toBeTruthy();
  });
});
