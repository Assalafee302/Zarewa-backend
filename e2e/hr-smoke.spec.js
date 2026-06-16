import { test, expect } from '@playwright/test';

import { expectHrShell, signInViaUi } from './helpers/auth.js';



test.describe.configure({ timeout: 120_000 });



test.describe('HR UI smoke', () => {

  test('admin can open HR dashboard and settings', async ({ page }) => {

    await signInViaUi(page, 'admin', 'Admin@123');

    await page.goto('/hr/dashboard');

    await expectHrShell(page);

    await expect(page.getByText(/active staff|pending|payroll|overview/i).first()).toBeVisible({ timeout: 20_000 });



    await page.goto('/hr/settings');

    await expectHrShell(page);

    await expect(page.getByText(/policies|organization|documents/i).first()).toBeVisible({ timeout: 15_000 });



    await page.goto('/hr/payroll?tab=salary-matrix');

    await expectHrShell(page);

    await expect(page.getByText(/salary matrix/i).first()).toBeVisible({ timeout: 15_000 });



    await page.goto('/hr/documents?tab=letters');

    await expectHrShell(page);

    await expect(page.getByText(/employment confirmation|generate letter/i).first()).toBeVisible({

      timeout: 15_000,

    });

  });



  test('HR hub pages load', async ({ page }) => {

    await signInViaUi(page, 'admin', 'Admin@123');



    await page.goto('/hr/employees');

    await expectHrShell(page);

    await expect(page.getByRole('heading', { level: 2, name: /^employees$/i })).toBeVisible({ timeout: 20_000 });



    await page.goto('/hr/documents?tab=reports');

    await expectHrShell(page);

    await expect(page.getByText(/reports hub|operational readiness/i).first()).toBeVisible({ timeout: 15_000 });



    await page.goto('/hr/discipline-exit?tab=transfers');

    await expectHrShell(page);

    await expect(page.getByText(/transfer/i).first()).toBeVisible({ timeout: 15_000 });



    await page.goto('/hr/analytics');

    await expectHrShell(page);

    await expect(page.getByRole('heading', { name: /hr analytics/i })).toBeVisible({ timeout: 15_000 });

  });



  test('staff registration modal opens from employees directory', async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
    await page.goto('/hr/employees?tab=directory&register=1');
    await expect(page.getByRole('dialog', { name: /register new staff/i })).toBeVisible({ timeout: 45_000 });
  });



  test('payroll export controls render for admin', async ({ page }) => {

    await signInViaUi(page, 'admin', 'Admin@123');

    await page.goto('/hr/payroll');

    await expectHrShell(page);

    await expect(page.getByText(/bank|export|run/i).first()).toBeVisible({ timeout: 15_000 });

  });



  test('HR admin can open requests queue from dashboard links', async ({ page }) => {

    await signInViaUi(page, 'admin', 'Admin@123');

    await page.goto('/hr/requests?view=queue&scope=hr_queue');

    await expectHrShell(page);

    await expect(page.getByText(/pending queue|hr review/i).first()).toBeVisible({ timeout: 20_000 });

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

