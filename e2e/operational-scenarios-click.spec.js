/**
 * Live click-through sampler for roofing / office / finance SOPs.
 * Maps to helpOperationalCatalog.js modules (sales, finance, procurement, operations, workspace, hr).
 * Requires MySQL E2E DB — same as smoke.spec.js (npm run test:e2e).
 */
import { test, expect } from '@playwright/test';
import { signInViaApi, signInViaUi } from './helpers/auth.js';

test.describe.configure({ timeout: 120_000 });

const MODULES_NAV = [
  { link: 'Workspace', url: /\//, heading: /desk|workspace|office/i },
  { link: 'Sales', url: /\/sales/, heading: /sales/i },
  { link: 'Procurement', url: /\/procurement/, heading: /procurement|purchase/i },
  { link: 'Operations', url: /\/operations/, heading: /operations/i },
  { link: 'Finance', url: /\/accounts/, heading: /finance|accounts/i },
];

test.describe('Operational scenario clicks (admin)', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
  });

  test('navigate all core modules from sidebar', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Modules' });
    for (const mod of MODULES_NAV) {
      await nav.getByRole('link', { name: mod.link }).click();
      await expect(page).toHaveURL(mod.url, { timeout: 20_000 });
    }
  });

  test('workspace desk: create wizard opens and closes', async ({ page }) => {
    await page.goto('/');
    const create = page.getByRole('button', { name: /create office record/i });
    await expect(create).toBeVisible({ timeout: 20_000 });
    await create.click();
    const dialog = page.getByRole('dialog', { name: /create office record/i });
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: /close/i }).first().click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  });

  test('workspace desk: official notices panel', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /official notices/i }).click({ timeout: 15_000 });
    await expect(page.getByText(/official|notice|no official/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('workspace desk: office forum panel', async ({ page }) => {
    await page.goto('/');
    const forum = page.getByRole('button', { name: /office forum/i });
    if (await forum.isVisible().catch(() => false)) {
      await forum.click();
      await expect(page.getByText(/forum posts are not official/i)).toBeVisible({ timeout: 15_000 });
    }
  });

  test('sales: quotations tab loads', async ({ page }) => {
    await page.goto('/sales');
    const tab = page.getByRole('tab', { name: /quotations/i }).or(page.getByRole('button', { name: /quotations/i }));
    if (await tab.first().isVisible().catch(() => false)) {
      await tab.first().click();
    }
    await expect(page.getByText(/quotation|quote|new/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('procurement: page shell', async ({ page }) => {
    await page.goto('/procurement');
    await expect(page.getByText(/procurement|purchase|supplier/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('operations: operations heading', async ({ page }) => {
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: /^Operations$/i })).toBeVisible({ timeout: 20_000 });
  });

  test('finance: accounts shell', async ({ page }) => {
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: /finance|accounts/i })).toBeVisible({ timeout: 20_000 });
  });

  test('reports module opens', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL(/\/reports/);
  });
});

test.describe('Operational scenario clicks (branch manager)', () => {
  test('branch desk endorsements section', async ({ page }) => {
    await signInViaApi(page, 'sales.manager', 'Sales@123');
    await page.goto('/');
    const endorse = page.getByRole('button', { name: /endorsements/i });
    if (await endorse.isVisible().catch(() => false)) {
      await endorse.click();
    }
    await expect(page.getByText(/endorse|request|office|task/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Operational scenario clicks (sales staff UI login)', () => {
  test('sales staff reaches workspace', async ({ page }) => {
    await signInViaUi(page, 'sales.staff', 'Sales@123');
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /create office record/i }).or(page.getByRole('heading', { name: /my desk/i }))
    ).toBeVisible({ timeout: 25_000 });
  });
});
