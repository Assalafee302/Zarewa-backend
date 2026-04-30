import { expect } from '@playwright/test';
import { csrfHeader, signInViaApi, signOutViaApi } from './auth.js';

async function closeProductionForRefundEligibility(page, adminHeaders, { quotationId, customerID }) {
  const clRes = await page.request.post('/api/cutting-lists', {
    headers: adminHeaders,
    data: {
      quotationRef: quotationId,
      customerID,
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: new Date().toISOString().slice(0, 10),
      machineName: 'E2E-risk',
      operatorName: 'E2E',
      lines: [{ sheets: 1, lengthM: 5 }],
    },
  });
  expect(clRes.status(), await clRes.text()).toBe(201);
  const clBody = await clRes.json();
  const jobRes = await page.request.post('/api/production-jobs', {
    headers: adminHeaders,
    data: {
      cuttingListId: clBody.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    },
  });
  expect(jobRes.status(), await jobRes.text()).toBe(201);
  const jobBody = await jobRes.json();
  const cancelRes = await page.request.post(
    `/api/production-jobs/${encodeURIComponent(jobBody.jobID)}/cancel`,
    {
      headers: adminHeaders,
      data: { reason: 'E2E refund-risk — eligibility' },
    }
  );
  expect(cancelRes.status(), await cancelRes.text()).toBe(200);
}

/**
 * Customer + quotation (₦5,000 total) with ₦7,000 receipt → ₦2,000 overpayment for preview tests.
 * Closes production (cancel) so refund POST is allowed when tests need it.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ customerID: string; quotationId: string; customerName: string }>}
 */
export async function seedOverpaidQuotation(page) {
  const headers = await csrfHeader(page);
  const customerName = `E2E Overpay ${Date.now()}`;
  const phone = `081${String(Date.now()).slice(-8)}`;

  const bootRes = await page.request.get('/api/bootstrap');
  expect(bootRes.status()).toBe(200);
  const treasuryAccountId = (await bootRes.json()).treasuryAccounts[0].id;

  const custRes = await page.request.post('/api/customers', {
    headers,
    data: { name: customerName, phone, tier: 'Standard' },
  });
  expect(custRes.status(), await custRes.text()).toBe(201);
  const custBody = await custRes.json();
  const customerID = custBody.customerID;
  expect(customerID).toBeTruthy();

  const qRes = await page.request.post('/api/quotations', {
    headers,
    data: {
      customerID,
      projectName: 'E2E refund risk — overpay preview',
      dateISO: new Date().toISOString().slice(0, 10),
      lines: {
        products: [{ name: 'Roofing Sheet', qty: '1', unitPrice: '5000' }],
        accessories: [],
        services: [],
      },
    },
  });
  expect(qRes.status(), await qRes.text()).toBe(201);
  const { quotationId } = await qRes.json();
  expect(String(quotationId)).toMatch(/^QT-/);

  const rcRes = await page.request.post('/api/ledger/receipt', {
    headers,
    data: {
      customerID,
      quotationId,
      amountNgn: 7000,
      paymentMethod: 'Cash',
      dateISO: new Date().toISOString().slice(0, 10),
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 7000, reference: 'E2E-RISK-RCPT' }],
    },
  });
  expect(rcRes.status(), await rcRes.text()).toBe(201);

  await signOutViaApi(page);
  await signInViaApi(page, 'admin', 'Admin@123');
  const adminHeaders = await csrfHeader(page);
  await closeProductionForRefundEligibility(page, adminHeaders, { quotationId, customerID });
  await signOutViaApi(page);
  await signInViaApi(page, 'sales.staff', 'Sales@123');
  await csrfHeader(page);

  return { customerID, quotationId, customerName };
}
