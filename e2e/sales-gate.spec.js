import { test, expect } from '@playwright/test';
import { csrfHeader, signInViaApi } from './helpers/auth';

async function openSales(page) {
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Sales' }).click();
  await expect(page).toHaveURL(/\/sales$/);
  await expect(page.getByRole('heading', { name: /^sales$/i })).toBeVisible();
}

test.describe.configure({ timeout: 90_000 });

test.describe('Sales gate (auth → customer → receipt)', () => {
  test('sales staff can add customer and see posted receipt', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const csrf = await csrfHeader(page);

    await openSales(page);

    // --- Customer: add and open profile ---
    await page.getByRole('tab', { name: 'Customers' }).click();
    await page.getByRole('button', { name: /add customer/i }).click();

    const customerName = `Playwright Customer ${Date.now()}`;
    const phone = `080${Math.floor(10000000 + Math.random() * 89999999)}`;

    await expect(page.getByRole('heading', { name: 'New customer' })).toBeVisible();
    const modal = page.locator('.z-modal-panel');
    const nameInput = modal.locator('label:has-text("Full name")').locator('..').locator('input');
    const phoneInput = modal.locator('label:has-text("Phone")').locator('..').locator('input');
    const saveBtn = modal.getByRole('button', { name: 'Save customer' });

    await nameInput.fill(customerName);

    // Retry in case of duplicate/validation preventing the POST.
    let saved = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      const uniquePhone = `080${String(Date.now() + attempt).slice(-8)}`;
      await phoneInput.fill(uniquePhone);

      const waitPost = page.waitForResponse(
        (r) => r.url().includes('/api/customers') && r.request().method() === 'POST',
        { timeout: 20_000 }
      );

      // Use Promise.all so we never miss a fast response.
      await Promise.all([saveBtn.click(), waitPost.then((r) => (saved = r)).catch(() => null)]);
    }

    expect(saved, 'Expected POST /api/customers to occur').toBeTruthy();
    const savedText = await saved.text();
    expect(saved.status(), savedText).toBe(201);
    await expect(page.getByRole('heading', { name: 'New customer' })).toBeHidden({ timeout: 15_000 });

    // Customer should be in the list; open profile route.
    await page.getByPlaceholder(/search name, phone, id, tier/i).fill(customerName);
    await page.getByRole('link', { name: customerName }).click();
    await expect(page).toHaveURL(/\/customers\//);
    await expect(page.getByRole('heading', { name: /customer/i })).toBeVisible({ timeout: 15_000 });

    // --- Receipt: post via API (reliable), then verify it appears in UI ---
    const customersRes = await page.request.get('/api/customers');
    expect(customersRes.status()).toBe(200);
    const customersBody = await customersRes.json();
    const created = (customersBody.customers || []).find((c) => c?.name === customerName);
    expect(created?.customerID).toBeTruthy();

    const quotationRes = await page.request.post('/api/quotations', {
      headers: csrf,
      data: {
        customerID: created.customerID,
        projectName: 'Playwright sales gate',
        dateISO: new Date().toISOString().slice(0, 10),
        lines: {
          products: [{ name: 'Roofing Sheet', qty: '2', unitPrice: '5000' }],
          accessories: [],
          services: [],
        },
      },
    });
    const quotationText = await quotationRes.text();
    expect(quotationRes.status(), quotationText).toBe(201);
    const quotationBody = JSON.parse(quotationText);
    const quotationId = quotationBody.quotationId;
    expect(String(quotationId)).toMatch(/^QT-/);

    const receiptAmount = 10_000;
    const receiptRes = await page.request.post('/api/ledger/receipt', {
      headers: csrf,
      data: {
        customerID: created.customerID,
        quotationId,
        amountNgn: receiptAmount,
        paymentMethod: 'Cash',
        dateISO: new Date().toISOString().slice(0, 10),
      },
    });
    const receiptText = await receiptRes.text();
    expect(receiptRes.status(), receiptText).toBe(201);
    const receiptBody = JSON.parse(receiptText);
    const receiptId = receiptBody.receipt?.id || receiptBody.overpay?.id;
    expect(String(receiptId)).toMatch(/^[A-Z]+-/);

    // Reload to force a fresh bootstrap snapshot so the new ledger receipt appears in the Sales UI.
    await page.goto('/sales');
    await page.reload();
    await expect(page).toHaveURL(/\/sales$/);
    await page.getByRole('tab', { name: 'Receipts' }).click();
    await page.getByPlaceholder(/search receipt id, customer, quotation, date/i).fill(String(receiptId));
    await expect(page.getByText(String(receiptId), { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });
});

