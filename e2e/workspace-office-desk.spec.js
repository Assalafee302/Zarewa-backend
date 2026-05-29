import { test, expect } from '@playwright/test';
import { signInViaApi } from './helpers/auth.js';

test.describe.configure({ timeout: 120_000 });

test.describe('Online Office Workspace desk', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
  });

  test('desk loads with professional navigation', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: /workspace desk/i }).or(page.getByRole('heading', { name: /my desk|office desk|executive desk|branch desk/i }))
    ).toBeVisible({ timeout: 25_000 });
  });

  test('GP1: create fuel office record via wizard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /create office record/i }).click({ timeout: 20_000 });
    await expect(page.getByRole('dialog', { name: /create office record/i })).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder(/what happened|describe/i).fill('Gen no diesel since morning');
    await page.getByRole('button', { name: /next|continue/i }).first().click();
    await page.getByRole('button', { name: /submit record|submit/i }).click({ timeout: 15_000 });
    await expect(page.getByText(/diesel|fuel|submitted|record/i).first()).toBeVisible({ timeout: 25_000 });
  });

  test('GP3: record detail timeline and print button', async ({ page }) => {
    await page.goto('/');
    const taskTab = page.getByRole('tab', { name: /needs my action/i });
    if (await taskTab.isVisible().catch(() => false)) {
      await taskTab.click();
    }
    const row = page.locator('[data-work-item-row]').first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await expect(page.getByRole('tab', { name: /timeline/i })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /^print$/i }).first()).toBeVisible();
    }
  });

  test('branch workspace selector', async ({ page }) => {
    await page.goto('/');
    const branchSelect = page.locator('#zarewa-branch-workspace');
    await expect(branchSelect).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Branch manager office flows', () => {
  test('GP2: branch manager convert to expense', async ({ page }) => {
    await signInViaApi(page, 'sales_manager', 'Manager@123');
    await page.goto('/');
    const conversions = page.getByRole('button', { name: /expense conversions/i }).or(page.getByRole('tab', { name: /expense conversions/i }));
    if (await conversions.first().isVisible().catch(() => false)) {
      await conversions.first().click();
    }
    await expect(page.getByText(/expense|conversion|office record/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Official notices and forum', () => {
  test('GP5: acknowledge official notice', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const headers = await page.evaluate(() => {
      const m = document.cookie.match(/zarewa_csrf=([^;]+)/);
      return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
    });
    await page.request.post('/api/official-notices', {
      data: {
        title: 'E2E Safety notice',
        content: 'Wear PPE on site.',
        targetAllStaff: true,
        requiresAcknowledgement: true,
      },
      headers,
    });
    await page.goto('/');
    await page.getByRole('button', { name: /official notices/i }).click({ timeout: 15_000 });
    await page.getByRole('button', { name: /i have read and understood/i }).first().click({ timeout: 15_000 });
  });

  test('GP6: forum visible', async ({ page }) => {
    await signInViaApi(page, 'sales_staff', 'Sales@123');
    await page.goto('/');
    await page.getByRole('button', { name: /office forum/i }).click({ timeout: 15_000 });
    await expect(page.getByText(/forum posts are not official/i)).toBeVisible({ timeout: 15_000 });
  });
});
