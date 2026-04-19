import { test, expect } from '@playwright/test';
import { signInViaApi } from './helpers/auth';

test.describe.configure({ timeout: 90_000 });

test.describe('Role-based access (API + UI)', () => {
  test('viewer: customers API forbidden; reports summary allowed', async ({ page }) => {
    await signInViaApi(page, 'viewer', 'Viewer@123456!');
    const customers = await page.request.get('/api/customers');
    expect(customers.status()).toBe(403);
    const body = await customers.json();
    expect(body.code).toBe('FORBIDDEN');

    const summary = await page.request.get('/api/reports/summary');
    expect(summary.status()).toBe(200);
    const sumJson = await summary.json();
    expect(sumJson.ok).toBe(true);
    expect(sumJson.counts).toBeTruthy();
    expect(typeof sumJson.counts.customersTotal).toBe('number');
  });

  test('viewer: Reports shows count-only overview', async ({ page }) => {
    await signInViaApi(page, 'viewer', 'Viewer@123456!');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: /count-only overview/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('procurement: customers forbidden; suppliers allowed', async ({ page }) => {
    await signInViaApi(page, 'procurement', 'Procure@123');
    const customers = await page.request.get('/api/customers');
    expect(customers.status()).toBe(403);

    const suppliers = await page.request.get('/api/suppliers');
    expect(suppliers.status()).toBe(200);
    const body = await suppliers.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.suppliers)).toBe(true);
  });

  test('procurement: ledger endpoint forbidden', async ({ page }) => {
    await signInViaApi(page, 'procurement', 'Procure@123');
    // Use in-page fetch so the session cookie is always sent (page.request can miss cookies after policy reload).
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/ledger', { credentials: 'include' });
      return r.status;
    });
    expect(status).toBe(403);
  });

  test('CEO: executive summary allowed; line-level customers API forbidden', async ({ page }) => {
    await signInViaApi(page, 'ceo', 'Ceo@1234567890!');
    const execRes = await page.request.get('/api/exec/summary');
    expect(execRes.status()).toBe(200);
    const execJson = await execRes.json();
    expect(execJson.ok).toBe(true);
    expect(execJson.counts).toBeTruthy();

    const cust = await page.request.get('/api/customers');
    expect(cust.status()).toBe(403);

    const search = await page.request.get('/api/workspace/search?q=QT');
    expect(search.status()).toBe(403);
    const sJson = await search.json();
    expect(sJson.ok).toBe(false);
  });

  test('CEO: executive dashboard UI loads', async ({ page }) => {
    await signInViaApi(page, 'ceo', 'Ceo@1234567890!');
    await page.goto('/exec');
    await expect(page.getByRole('heading', { name: /company overview/i })).toBeVisible({ timeout: 20_000 });
  });

  test('CEO: home route lands on executive dashboard', async ({ page }) => {
    await signInViaApi(page, 'ceo', 'Ceo@1234567890!');
    await page.goto('/');
    await expect(page).toHaveURL(/\/exec$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /company overview/i })).toBeVisible({ timeout: 15_000 });
  });

  test('MD: customers API allowed; workspace search returns structured results', async ({ page }) => {
    await signInViaApi(page, 'md', 'Md@1234567890!');
    const cust = await page.request.get('/api/customers');
    expect(cust.status()).toBe(200);
    const search = await page.request.get('/api/workspace/search?q=QT');
    expect(search.status()).toBe(200);
    const sJson = await search.json();
    expect(sJson.ok).toBe(true);
    expect(Array.isArray(sJson.results)).toBe(true);
  });

  test('MD: home route lands on manager dashboard', async ({ page }) => {
    await signInViaApi(page, 'md', 'Md@1234567890!');
    await page.goto('/');
    await expect(page).toHaveURL(/\/manager$/, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /stock note/i })).toBeVisible({ timeout: 15_000 });
  });

  test('branch manager: refunds list readable (approval lane)', async ({ page }) => {
    await signInViaApi(page, 'sales.manager', 'Sales@123');
    const refunds = await page.request.get('/api/refunds');
    expect(refunds.status()).toBe(200);
    const body = await refunds.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.refunds)).toBe(true);
  });

});
