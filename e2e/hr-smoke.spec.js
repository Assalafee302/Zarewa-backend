import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth.js';

test.describe.configure({ timeout: 120_000 });

test.describe('HR UI smoke', () => {
  test('admin can open HR dashboard and settings', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/hr/dashboard');
    await expect(page.getByRole('heading', { name: /human resources/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/active staff|pending|payroll/i).first()).toBeVisible({ timeout: 15_000 });

    await page.goto('/hr/settings');
    await expect(page.getByText(/salary matrix/i)).toBeVisible({ timeout: 15_000 });

    await page.goto('/hr/letters');
    await expect(page.getByText(/employment confirmation|generate letter/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('HR hub pages load', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');

    await page.goto('/hr/employees');
    await expect(page.getByRole('heading', { name: /employees/i })).toBeVisible({ timeout: 20_000 });

    await page.goto('/hr/documents?tab=reports');
    await expect(page.getByText(/reports hub|operational readiness/i).first()).toBeVisible({ timeout: 15_000 });

    await page.goto('/hr/discipline-exit?tab=transfers');
    await expect(page.getByText(/transfer/i).first()).toBeVisible({ timeout: 15_000 });

    await page.goto('/hr/analytics');
    await expect(page.getByText(/hr analytics|workforce/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('staff registration modal opens from employees directory', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/hr/employees?register=1');
    await expect(page.getByText(/register staff|login account/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('payroll export controls render for admin', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/hr/payroll');
    await expect(page.getByText(/payroll/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/bank|export|run/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('My Profile smoke', () => {
  test('employee my profile overview loads', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/my-profile/overview');
    await expect(page.getByRole('heading', { name: /my profile/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/apply leave|leave balances|quick/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
