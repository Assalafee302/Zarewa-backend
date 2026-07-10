/**
 * Core Lifecycle 100 — E2E smoke subset (LC100-010, LC100-048, LC100-064, LC100-084, LC100-099).
 * Requires MySQL E2E DB. See docs/CORE_LIFECYCLE_100_SCENARIOS.md
 */
import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth';

test.describe.configure({ timeout: 90_000 });

test.describe('LC100 E2E smoke — linked module chain', () => {
  test('LC100-010: module chain Sales → Operations → Finance navigation', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    const modulesNav = page.getByRole('navigation', { name: 'Modules' });

    await modulesNav.getByRole('link', { name: 'Sales' }).click();
    await expect(page).toHaveURL(/\/sales$/);
    await expect(page.getByRole('heading', { name: /sales/i })).toBeVisible({ timeout: 20_000 });

    await modulesNav.getByRole('link', { name: 'Production' }).click();
    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByRole('heading', { name: /store & production/i })).toBeVisible();

    await modulesNav.getByRole('link', { name: 'Finance' }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible();
  });

  test('LC100-048: cutting list tab loads in Sales workspace', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/sales');
    await page.getByRole('tab', { name: /cutting/i }).click();
    await expect(page.getByText(/cutting list/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('LC100-064: production tab loads in Operations workspace', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/operations');
    await page.getByRole('tab', { name: /production/i }).click();
    await expect(page.getByText(/production/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('LC100-084: refund tab loads in Sales workspace', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/sales');
    await page.getByRole('tab', { name: /refund/i }).click();
    await expect(page.getByText(/refund/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('LC100-099: operations stock management tab accessible', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/operations');
    await page.getByRole('tab', { name: /stock|inventory/i }).click();
    await expect(page.getByText(/stock|inventory/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
