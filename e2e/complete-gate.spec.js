import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth';

test.describe.configure({ timeout: 90_000 });

test.describe('Complete gate — module shells by role', () => {
  test('finance manager: Finance page and treasury tab', async ({ page }) => {
    await signInViaUi(page, 'finance.manager', 'Finance@123');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Finance' }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible();
    await page.getByRole('tab', { name: /^treasury$/i }).click();
    await expect(page.getByText(/total liquidity/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('operations: Store & production shell', async ({ page }) => {
    await signInViaUi(page, 'operations', 'Ops@123');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Production' }).click();
    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByRole('heading', { name: /store & production/i })).toBeVisible();
  });

  test('admin: Procurement purchases shell', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Purchase' }).click();
    await expect(page).toHaveURL(/\/procurement$/);
    await expect(page.locator('h1').filter({ hasText: /^Purchases$/i })).toBeVisible();
  });

  test('admin: removed HR and accounting routes redirect safely', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/hr/my-profile');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/accounting/overview');
    await expect(page).toHaveURL(/\/accounts$/);
  });

  test('admin: branch workspace selector when live API lists branches', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    const branchSelect = page.locator('#zarewa-branch-workspace');
    await expect(branchSelect).toBeVisible({ timeout: 15_000 });
    await expect(branchSelect.locator('option').first()).toBeAttached();
  });
});
