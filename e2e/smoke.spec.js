import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth';

test.describe.configure({ timeout: 60_000 });

test.describe('Authenticated app flows', () => {
  test('dashboard loads after sign-in with active user identity', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/operations');
    await expect(page.getByRole('heading', { name: /store & production/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /signed in as zarewa admin/i })).toBeVisible();
  });

  test('sidebar navigates through protected modules', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');

    const modulesNav = page.getByRole('navigation', { name: 'Modules' });

    await modulesNav.getByRole('link', { name: 'Sales' }).click();
    await expect(page).toHaveURL(/\/sales$/);

    await modulesNav.getByRole('link', { name: 'Purchase' }).click();
    await expect(page).toHaveURL(/\/procurement$/);

    await modulesNav.getByRole('link', { name: 'Production' }).click();
    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByRole('heading', { name: /store & production/i })).toBeVisible();

    await modulesNav.getByRole('link', { name: 'Finance' }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible();

    await modulesNav.getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL(/\/reports$/);

    await modulesNav.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\//);
  });

  test('settings exposes profile and period lock controls', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/settings/profile');
    const main = page.locator('#main-content');
    await expect(main.getByText(/your profile/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(main.getByRole('textbox').first()).toHaveValue(/zarewa admin/i);
    await expect(main.getByText(/^administrator$/i).first()).toBeVisible();

    await page.getByRole('tab', { name: /governance/i }).click();
    await page.locator('input[type="month"]').fill('2099-12');
    await page.getByPlaceholder(/month-end close completed/i).fill('Playwright period lock');
    await page.getByRole('button', { name: /lock period/i }).click();
    await expect(main.getByText('2099-12', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /unlock/i }).click();
  });

  test('procurement role hides finance navigation', async ({ page }) => {
    await signInViaUi(page, 'procurement', 'Procure@123');
    await expect(page.getByRole('button', { name: /procurement officer/i })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Finance' })
    ).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Purchase' }).click();
    await expect(page).toHaveURL(/\/procurement$/);
  });

  test('invalid credentials stay on sign-in screen', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: /enter workspace/i }).click();
    await expect(page.getByText(/invalid username or password/i)).toBeVisible();
  });

  test('settings master data workspace can add a colour', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/settings/data');
    await expect(page).toHaveURL(/\/settings\/data/);
    const openCatalog = page.getByRole('button', { name: /open catalog/i }).first();
    await expect(openCatalog).toBeVisible({ timeout: 25_000 });
    await openCatalog.scrollIntoViewIfNeeded();
    await openCatalog.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByLabel(/filter catalog rows/i)).toBeVisible();
    const colourName = `Playwright colour ${Date.now()}`;
    const coloursForm = dialog.locator('form').filter({ has: page.getByText('Colour name', { exact: true }) });
    await coloursForm.getByText('Colour name', { exact: true }).locator('..').getByRole('textbox').first().fill(colourName);
    await coloursForm.getByPlaceholder(/HMB \/ IV \/ TB/i).fill('PW');
    await coloursForm.getByRole('button', { name: /^save$/i }).click();
    await expect(dialog.getByRole('row').filter({ hasText: colourName }).filter({ hasText: 'PW' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('sales refunds tab opens create modal, loads eligible quotations, shows intelligence', async ({ page }) => {
    test.setTimeout(120_000);
    await signInViaUi(page, 'sales.staff', 'Sales@123');
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Sales' }).click();
    await expect(page).toHaveURL(/\/sales$/);
    await page.getByRole('tab', { name: 'Refunds' }).click();
    await page.getByRole('button', { name: /new refund/i }).click();
    await expect(page.getByRole('heading', { name: /create refund/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/must be linked to a finished quotation/i)).toBeVisible();
    await page.getByRole('button', { name: /show how refunds work/i }).click();
    await expect(page.getByText(/quotation-linked workflow/i)).toBeVisible({ timeout: 10_000 });
    // Eligible quotations load from GET /api/refunds/eligible-quotations — spinner must clear.
    await expect(page.getByText('Loading active quotes...')).toBeHidden({ timeout: 25_000 });
    await expect(page.getByText('Transaction Intelligence')).toBeVisible();
    const quoteSelect = page.locator('select').filter({ hasText: /Select a finished quotation/i });
    const optionCount = await quoteSelect.locator('option').count();
    if (optionCount > 1) {
      await quoteSelect.selectOption({ index: 1 });
      await expect(page.getByText('Quote Total', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Payment History')).toBeVisible();
    }
  });
});
