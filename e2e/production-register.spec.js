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
    await expect(page.getByRole('heading', { name: /^Operations$/i })).toBeVisible({ timeout: 20_000 });
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

  test('mixed completion: coil metres plus offcutInventoryMeters on POST /complete', async ({ page }) => {
    test.setTimeout(120_000);
    await signInViaApi(page, 'admin', 'Admin@123');
    const headers = await csrfHeader(page);
    const ts = Date.now();

    const supRes = await page.request.post('/api/suppliers', {
      headers,
      data: { name: `E2E MixedCoil ${ts}`, city: 'Kano' },
    });
    expect(supRes.status(), await supRes.text()).toBe(201);
    const { supplierID } = await supRes.json();

    const poRes = await page.request.post('/api/purchase-orders', {
      headers,
      data: {
        supplierID,
        supplierName: `E2E MixedCoil ${ts}`,
        orderDateISO: '2026-03-29',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey: 'L-MIX',
            productID: 'COIL-ALU',
            productName: 'Aluminium coil (kg)',
            color: 'IV',
            gauge: '0.24',
            metersOffered: 1327,
            conversionKgPerM: 3000 / 1327,
            qtyOrdered: 6000,
            unitPricePerKgNgn: 100,
            unitPriceNgn: 100,
            qtyReceived: 0,
          },
        ],
      },
    });
    expect(poRes.status(), await poRes.text()).toBe(201);
    const { poID } = await poRes.json();
    const coilNo = `CL-E2E-MIX-${ts}`;

    const grnRes = await page.request.post(`/api/purchase-orders/${encodeURIComponent(poID)}/grn`, {
      headers,
      data: {
        entries: [
          {
            lineKey: 'L-MIX',
            productID: 'COIL-ALU',
            qtyReceived: 3000,
            weightKg: 3000,
            coilNo,
            location: 'Bay 1',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 1327,
            supplierConversionKgPerM: 3000 / 1327,
          },
        ],
        supplierID,
        supplierName: `E2E MixedCoil ${ts}`,
      },
    });
    expect(grnRes.status(), await grnRes.text()).toBe(200);

    const custRes = await page.request.post('/api/customers', {
      headers,
      data: { name: `E2E Mixed ${ts}`, phone: `081${String(ts).slice(-8)}`, tier: 'Standard' },
    });
    expect(custRes.status(), await custRes.text()).toBe(201);
    const { customerID } = await custRes.json();

    const qRes = await page.request.post('/api/quotations', {
      headers,
      data: {
        customerID,
        projectName: 'E2E mixed coil + offcut stock',
        dateISO: '2026-03-29',
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '120', unitPrice: '4000' }],
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
        paymentLines: [{ treasuryAccountId, amountNgn: totalNgn, reference: 'E2E-Mixed' }],
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
        lines: [{ sheets: 1, lengthM: 120 }],
      },
    });
    expect(clRes.status(), await clRes.text()).toBe(201);
    const clJson = await clRes.json();
    const cuttingListId = clJson.id || clJson.cuttingList?.id;
    expect(cuttingListId).toBeTruthy();

    const jobRes = await page.request.post('/api/production-jobs', {
      headers,
      data: {
        cuttingListId,
        productID: 'FG-101',
        productName: 'Longspan thin',
        plannedMeters: 120,
        plannedSheets: 1,
      },
    });
    expect(jobRes.status(), await jobRes.text()).toBe(201);
    const { jobID } = await jobRes.json();

    const allocRes = await page.request.post(`/api/production-jobs/${encodeURIComponent(jobID)}/allocations`, {
      headers,
      data: { allocations: [{ coilNo, openingWeightKg: 800 }] },
    });
    expect(allocRes.status(), await allocRes.text()).toBe(200);
    const allocJson = await allocRes.json();
    const allocationId = allocJson.allocations[0].id;

    const startRes = await page.request.post(`/api/production-jobs/${encodeURIComponent(jobID)}/start`, {
      headers,
      data: { startedAtISO: '2026-03-29' },
    });
    expect(startRes.status(), await startRes.text()).toBe(200);

    const prevRes = await page.request.post(`/api/production-jobs/${encodeURIComponent(jobID)}/conversion-preview`, {
      headers,
      data: {
        allocations: [
          {
            allocationId,
            coilNo,
            closingWeightKg: 400,
            metersProduced: 100,
            finishCoil: false,
          },
        ],
        offcutInventoryMeters: 2,
      },
    });
    expect(prevRes.status(), await prevRes.text()).toBe(200);
    const prevJson = await prevRes.json();
    expect(prevJson.totalOutputMeters).toBeCloseTo(102, 2);

    const boot1 = await page.request.get('/api/bootstrap');
    expect(boot1.status()).toBe(200);
    const boot1Json = await boot1.json();
    const fgBefore = Number(boot1Json.products.find((p) => p.productID === 'FG-101')?.stockLevel ?? 0);

    const doneRes = await page.request.post(`/api/production-jobs/${encodeURIComponent(jobID)}/complete`, {
      headers,
      data: {
        completedAtISO: '2026-03-29',
        allocations: [
          {
            allocationId,
            coilNo,
            closingWeightKg: 400,
            metersProduced: 100,
            finishCoil: false,
          },
        ],
        offcutInventoryMeters: 2,
      },
    });
    expect(doneRes.status(), await doneRes.text()).toBe(200);
    const doneJson = await doneRes.json();
    expect(doneJson.actualMeters).toBeCloseTo(102, 2);

    const boot2 = await page.request.get('/api/bootstrap');
    expect(boot2.status()).toBe(200);
    const boot2Json = await boot2.json();
    const pj = boot2Json.productionJobs.find((j) => j.jobID === jobID);
    expect(pj?.status).toBe('Completed');
    expect(pj.actualMeters).toBeCloseTo(102, 2);
    expect(pj.offcutInventoryMeters).toBeCloseTo(2, 2);
    const fgAfter = Number(boot2Json.products.find((p) => p.productID === 'FG-101')?.stockLevel ?? 0);
    expect(fgAfter).toBeCloseTo(fgBefore + 102, 2);
  });
});
