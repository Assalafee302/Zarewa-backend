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
      page
        .getByRole('navigation', { name: /workspace desk/i })
        .or(page.getByRole('heading', { name: /my desk|office desk|executive desk|branch desk/i }))
        .first()
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

  test('GP3: record detail action bar with print', async ({ page }) => {
    await page.goto('/');
    const taskTab = page.getByRole('tab', { name: /needs my action/i });
    if (await taskTab.isVisible().catch(() => false)) {
      await taskTab.click();
    }
    const row = page.locator('[data-work-item-row]').first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      const toolbar = page.locator('[data-office-record-action-bar]');
      await expect(toolbar).toBeVisible({ timeout: 15_000 });
      await expect(toolbar.getByRole('button', { name: /^print$/i })).toBeVisible();
      await expect(page.getByRole('tab', { name: /timeline/i })).toBeVisible();
    }
  });

  test('branch workspace selector', async ({ page }) => {
    await page.goto('/');
    const branchSelect = page.locator('#main-content #zarewa-branch-workspace').first();
    await expect(branchSelect).toBeVisible({ timeout: 15_000 });
  });

  test('HQ roll-up blocks create office record', async ({ page }) => {
    await page.goto('/');
    const branchSelect = page.locator('#main-content #zarewa-branch-workspace').first();
    await expect(branchSelect).toBeVisible({ timeout: 15_000 });
    const allBranchesOption = branchSelect.locator('option[value="__ALL__"]');
    if (!(await allBranchesOption.count())) {
      test.skip();
      return;
    }
    await branchSelect.selectOption('__ALL__');
    const createBtn = page.getByRole('button', { name: /create office record/i });
    await expect(createBtn).toBeDisabled({ timeout: 15_000 });
    const branches = await branchSelect.locator('option:not([value="__ALL__"])').all();
    if (branches.length > 0) {
      const firstVal = await branches[0].getAttribute('value');
      if (firstVal) {
        await branchSelect.selectOption(firstVal);
        await expect(createBtn).toBeEnabled({ timeout: 15_000 });
      }
    }
  });
});

test.describe('Branch manager office flows', () => {
  test('GP2: branch manager convert to expense', async ({ page }) => {
    await signInViaApi(page, 'sales.manager', 'Sales@123');
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

  test('GP6: forum topic opens create wizard pre-filled', async ({ page }) => {
    await signInViaApi(page, 'sales.manager', 'Sales@123');
    const headers = await page.evaluate(() => {
      const m = document.cookie.match(/zarewa_csrf=([^;]+)/);
      return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
    });
    await page.request.post('/api/forum/topics', {
      data: {
        scope: 'branch',
        title: 'Gen no diesel since morning',
        body: 'Branch forum E2E — need fuel urgently.',
      },
      headers,
    });
    await page.goto('/office');
    await expect(page.getByRole('heading', { name: /branch desk/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^branch forum$/i }).click({ timeout: 15_000 });
    await page.getByRole('button', { name: /turn into office record/i }).first().click({ timeout: 15_000 });
    await expect(page.getByRole('dialog', { name: /create office record/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder(/subject/i)).toHaveValue(/.+/, { timeout: 10_000 });
  });
});
