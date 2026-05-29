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
});
