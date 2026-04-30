import { test, expect } from '@playwright/test';
import { signInViaApi, signOutViaApi } from './helpers/auth.js';
import { seedPaidQuotationAndPendingRefund } from './helpers/salesRefundFinanceSeed.js';
import { waitForRefundApprovedInBootstrap } from './helpers/waitBootstrapRefund.js';
import { ensureAllBranchesRollup } from './helpers/branchRollup.js';

test.describe.configure({ timeout: 120_000 });

test.describe('Focused checklist — Sales, Refund, Finance', () => {
  test('Sales: primary tabs switch and list shells render', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    await page.goto('/sales');
    await expect(page).toHaveURL(/\/sales$/);
    await expect(page.getByRole('heading', { name: /^sales$/i })).toBeVisible({ timeout: 20_000 });

    const tabs = page.getByRole('tablist', { name: 'Section' });

    await tabs.getByRole('tab', { name: 'Quotations' }).click();
    await expect(page.getByRole('button', { name: /new quotation/i })).toBeVisible();
    await expect(page.getByPlaceholder(/search id, customer, date/i)).toBeVisible();

    await tabs.getByRole('tab', { name: 'Receipts' }).click();
    await expect(page.getByRole('button', { name: /new receipt/i })).toBeVisible();

    await tabs.getByRole('tab', { name: 'Refunds' }).click();
    await expect(page.getByRole('button', { name: /new refund/i })).toBeVisible();

    await tabs.getByRole('tab', { name: 'Customers' }).click();
    await expect(page.getByRole('button', { name: /add customer/i })).toBeVisible();
  });

  test('Refund: pending request → manager approves in Sales → Finance posts payout', async ({ page }) => {
    test.setTimeout(180_000);

    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const { refundID } = await seedPaidQuotationAndPendingRefund(page);
    await signOutViaApi(page);

    await signInViaApi(page, 'sales.manager', 'Sales@123');
    await page.goto('/sales');
    await expect(page.getByRole('tablist', { name: 'Section' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: 'Refunds' }).click();
    await page.getByPlaceholder(/search refund id/i).fill(refundID);
    const row = page.getByTestId(`refund-row-${refundID}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();

    await expect(page.getByRole('heading', { name: 'Refund Approval' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByPlaceholder(/why was this decided/i).fill('E2E approval');
    const saveDecision = page.getByRole('button', { name: 'Save Decision' });
    const waitDecision = page.waitForResponse(
      (r) => r.url().includes(`/api/refunds/${encodeURIComponent(refundID)}/decision`) && r.request().method() === 'POST',
      { timeout: 25_000 }
    );
    await Promise.all([saveDecision.click(), waitDecision]);
    await expect(page.getByRole('heading', { name: 'Refund Approval' })).toBeHidden({ timeout: 20_000 });
    await signOutViaApi(page);

    await signInViaApi(page, 'finance.manager', 'Finance@123');
    await page.goto('/');
    await ensureAllBranchesRollup(page);
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible({ timeout: 20_000 });
    await waitForRefundApprovedInBootstrap(page, refundID);
    await expect(page.getByTestId('finance-refunds-awaiting-payout')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId(`finance-refund-awaiting-row-${refundID}`)
      .getByRole('button', { name: 'Record pay' })
      .click();
    await expect(page.getByRole('heading', { name: 'Refund payout' })).toBeVisible();
    await page.getByPlaceholder(/e\.g\. Hauwa/i).fill('Playwright GTB transfer');
    const postPayout = page.getByRole('button', { name: 'Post refund payout' });
    const waitPay = page.waitForResponse(
      (r) => r.url().includes(`/api/refunds/${encodeURIComponent(refundID)}/pay`) && r.request().method() === 'POST',
      { timeout: 25_000 }
    );
    await Promise.all([postPayout.click(), waitPay]);
    await expect(page.getByRole('heading', { name: 'Refund payout' })).toBeHidden({ timeout: 20_000 });
  });

  test('Refund: pending request → MD approves in Sales → Finance posts payout', async ({ page }) => {
    test.setTimeout(180_000);

    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const { refundID } = await seedPaidQuotationAndPendingRefund(page);
    await signOutViaApi(page);

    await signInViaApi(page, 'md', 'Md@1234567890!');
    await page.goto('/sales');
    await expect(page.getByRole('tablist', { name: 'Section' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: 'Refunds' }).click();
    await page.getByPlaceholder(/search refund id/i).fill(refundID);
    const row = page.getByTestId(`refund-row-${refundID}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();

    await expect(page.getByRole('heading', { name: 'Refund Approval' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('region', { name: /approver verification checklist/i })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByPlaceholder(/why was this decided/i).fill('E2E MD approval');
    const saveDecision = page.getByRole('button', { name: 'Save Decision' });
    const waitDecision = page.waitForResponse(
      (r) => r.url().includes(`/api/refunds/${encodeURIComponent(refundID)}/decision`) && r.request().method() === 'POST',
      { timeout: 25_000 }
    );
    await Promise.all([saveDecision.click(), waitDecision]);
    await expect(page.getByRole('heading', { name: 'Refund Approval' })).toBeHidden({ timeout: 20_000 });
    await signOutViaApi(page);

    await signInViaApi(page, 'finance.manager', 'Finance@123');
    await page.goto('/');
    await ensureAllBranchesRollup(page);
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible({ timeout: 20_000 });
    await waitForRefundApprovedInBootstrap(page, refundID);
    await expect(page.getByTestId('finance-refunds-awaiting-payout')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId(`finance-refund-awaiting-row-${refundID}`)
      .getByRole('button', { name: 'Record pay' })
      .click();
    await expect(page.getByRole('heading', { name: 'Refund payout' })).toBeVisible();
    await page.getByPlaceholder(/e\.g\. Hauwa/i).fill('Playwright MD path payout');
    const postPayout = page.getByRole('button', { name: 'Post refund payout' });
    const waitPay = page.waitForResponse(
      (r) => r.url().includes(`/api/refunds/${encodeURIComponent(refundID)}/pay`) && r.request().method() === 'POST',
      { timeout: 25_000 }
    );
    await Promise.all([postPayout.click(), waitPay]);
    await expect(page.getByRole('heading', { name: 'Refund payout' })).toBeHidden({ timeout: 20_000 });
  });

  test('Finance: treasury, expenses & requests, and audit tabs load', async ({ page }) => {
    await signInViaApi(page, 'finance.manager', 'Finance@123');
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: /finance & accounts/i })).toBeVisible({ timeout: 20_000 });

    const tabs = page.getByRole('tablist', { name: 'Section' });
    const mainTitle = page.locator('#main-content h2').first();

    await tabs.getByRole('tab', { name: 'Treasury' }).click();
    await expect(mainTitle).toHaveText('Treasury');
    await expect(page.getByText(/Cash inflows/i).first()).toBeVisible();

    await tabs.getByRole('tab', { name: 'Expenses & requests' }).click();
    await expect(mainTitle).toHaveText('Expenses & requests');
    await expect(page.getByText(/Raise a payment request for approval/i).first()).toBeVisible();

    await tabs.getByRole('tab', { name: 'Audit' }).click();
    await expect(mainTitle).toHaveText('Audit & reconciliation');
    await expect(page.getByText(/Audit checklist/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
