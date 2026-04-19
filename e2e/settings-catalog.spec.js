import { test, expect } from '@playwright/test';
import { signInViaUi } from './helpers/auth';

test.describe.configure({ timeout: 60_000 });

test.describe('Settings data catalog', () => {
  test('modal filter narrows tables and resets when reopening', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/settings/data');
    await expect(page).toHaveURL(/\/settings\/data/);
    await expect(page.getByText(/master lists/i).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /open catalog/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    const filter = dialog.getByLabel(/filter catalog rows/i);
    await expect(filter).toBeVisible();
    await filter.fill('zzzzzzzz-no-match-zzzzzzzz');
    await expect(dialog.getByText(/no rows match your filter/i).first()).toBeVisible({ timeout: 10_000 });

    await filter.fill('');
    await expect(dialog.getByText(/no rows match your filter/i)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await page.getByRole('button', { name: /open catalog/i }).nth(1).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByLabel(/filter catalog rows/i)).toHaveValue('');
  });

  test('price book catalog opens from second group', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/settings/data');
    await expect(page).toHaveURL(/\/settings\/data/);
    const openBtn = page.getByRole('button', { name: /open catalog/i }).nth(1);
    await openBtn.scrollIntoViewIfNeeded();
    await openBtn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('heading', { name: /^price list$/i })).toBeVisible();
  });
});
