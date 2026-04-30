import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth';

test.describe.configure({ timeout: 90_000 });

test.describe('Stone / accessory receipts (Procurement)', () => {
  test('admin posts stone metre receipt from modal', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Purchase' }).click();
    await expect(page).toHaveURL(/\/procurement$/);

    await page.getByRole('button', { name: /stone \/ accessory receipt/i }).click();
    await expect(page.getByRole('heading', { name: /non-coil receipts/i })).toBeVisible();

    await page.getByLabel(/^metres received$/i).fill('5.5');
    await page.getByRole('button', { name: /^post stone receipt$/i }).click();

    await expect(page.getByRole('status').filter({ hasText: /receipt posted/i })).toBeVisible({
      timeout: 20_000,
    });
  });
});
