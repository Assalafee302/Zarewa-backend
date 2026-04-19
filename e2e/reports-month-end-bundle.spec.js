import { test, expect } from '@playwright/test';
import { signInViaApi } from './helpers/auth';

test.describe.configure({ timeout: 120_000 });

test.describe('Reports month-end bundle', () => {
  test('finance user sees month-end bundle control', async ({ page }) => {
    await signInViaApi(page, 'finance.manager', 'Finance@123');
    await page.goto('/reports');
    await expect(page.getByRole('button', { name: /download month-end bundle/i })).toBeVisible({ timeout: 25_000 });
  });
});
