import { test, expect } from '@playwright/test';
import { signInViaApi, csrfHeader } from './helpers/auth.js';
import { waitForProductionJobInBootstrap } from './helpers/waitProductionJobBootstrap.js';

/**
 * Exercises the production-register flow against the full Playwright stack (Vite + API + playwright.sqlite),
 * including CSRF-authenticated API calls — closer to real usage than Vitest supertest alone.
 *
 * Uses a fresh customer + quotation each run so the persistent E2E DB never hits "quotation already has a cutting list."
 */
test.describe.configure({ timeout: 120_000 });

test.describe('Production register — API on E2E stack', () => {
  test('cutting list + production job sets productionRegistered; conversion-preview rejects before start', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInViaApi(page, 'admin', 'Admin@123');
    const headers = await csrfHeader(page);

    const ts = Date.now();
    const custRes = await page.request.post('/api/customers', {
      headers,
      data: { name: `E2E ProdReg ${ts}`, phone: `080${String(ts).slice(-8)}`, tier: 'Standard' },
    });
    expect(custRes.status(), await custRes.text()).toBe(201);
    const { customerID } = await custRes.json();

    const qRes = await page.request.post('/api/quotations', {
      headers,
      data: {
        customerID,
        projectName: 'E2E production register',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '33', unitPrice: '4000' }],
          accessories: [],
          services: [],
        },
      },
    });
    expect(qRes.status(), await qRes.text()).toBe(201);
    const qBody = await qRes.json();
    const quotationId = qBody.quotationId;
    const totalNgn = Math.round(Number(qBody.quotation?.totalNgn) || 0);
    expect(totalNgn).toBeGreaterThan(0);

    const boot0 = await page.request.get('/api/bootstrap');
    expect(boot0.status()).toBe(200);
    const treasuryAccountId = (await boot0.json()).treasuryAccounts[0].id;

    const rcRes = await page.request.post('/api/ledger/receipt', {
      headers,
      data: {
        customerID,
        quotationId,
        amountNgn: totalNgn,
        paymentMethod: 'Transfer',
        dateISO: '2026-03-29',
        treasuryAccountId,
        paymentLines: [{ treasuryAccountId, amountNgn: totalNgn, reference: 'E2E-ProdReg' }],
      },
    });
    expect(rcRes.status(), await rcRes.text()).toBe(201);

    const clRes = await page.request.post('/api/cutting-lists', {
      headers,
      data: {
        quotationRef: quotationId,
        customerID,
        productID: 'FG-101',
        productName: 'Longspan thin',
        dateISO: '2026-03-29',
        machineName: 'E2E',
        operatorName: 'E2E',
        lines: [
          { sheets: 4, lengthM: 6 },
          { sheets: 2, lengthM: 4.5 },
        ],
      },
    });
    const clText = await clRes.text();
    expect(clRes.status(), clText).toBe(201);
    const clJson = JSON.parse(clText);
    const cuttingListId = clJson.id || clJson.cuttingList?.id;
    expect(cuttingListId).toBeTruthy();

    const jobRes = await page.request.post('/api/production-jobs', {
      headers,
      data: {
        cuttingListId,
        productID: 'FG-101',
        productName: 'Longspan thin',
        plannedMeters: 33,
        plannedSheets: 6,
      },
    });
    const jobText = await jobRes.text();
    expect(jobRes.status(), jobText).toBe(201);
    const jobJson = JSON.parse(jobText);
    const jobID = jobJson.jobID;
    expect(jobID).toBeTruthy();

    const boot = await page.request.get('/api/bootstrap');
    expect(boot.status()).toBe(200);
    const bootJson = await boot.json();
    const cl = bootJson.cuttingLists.find((row) => row.id === cuttingListId);
    expect(cl?.productionRegistered).toBe(true);
    expect(cl?.productionRegisterRef).toBe(jobID);

    const prev = await page.request.post(`/api/production-jobs/${encodeURIComponent(jobID)}/conversion-preview`, {
      headers,
      data: {
        allocations: [{ coilNo: 'INVALID-COIL-E2E', closingWeightKg: 1, metersProduced: 1 }],
      },
    });
    expect(prev.status()).toBe(400);

    await waitForProductionJobInBootstrap(page, jobID);
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: /store & production/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: 'Production line' }).click();
    /** LiveProductionMonitor (queue + test ids) lives in the trace modal, not the main list shell. */
    const activeRow = page.locator('li').filter({ hasText: cuttingListId }).first();
    await activeRow.getByRole('button', { name: 'Open trace' }).click();
    await expect(page.getByRole('heading', { name: 'Production traceability' })).toBeVisible({ timeout: 15_000 });
    /** Modal uses LiveProductionMonitor with hideJobSidebar — queue test ids are not rendered here. */
    const tracePanel = page.locator('.z-modal-panel');
    await expect(tracePanel.getByText(cuttingListId, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    /** Status chip (avoid matching hidden helper copy that also mentions "Planned"). */
    await expect(tracePanel.locator('span.font-bold.uppercase').filter({ hasText: /^Planned$/ }).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
