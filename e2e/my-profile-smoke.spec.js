import { test, expect } from '@playwright/test';

import { signInViaUi, pageFetchJson } from './helpers/auth.js';

test.describe.configure({ timeout: 120_000 });

/** Wait for lazy profile chunks and bootstrap spinners. */
async function expectProfileReady(page) {
  await expect(page.getByText(/preparing live workspace/i)).toBeHidden({ timeout: 60_000 });
}

async function expectProfileRoute(page, path, headingPattern) {
  await page.goto(path);
  await expectProfileReady(page);
  await expect(page).toHaveURL(new RegExp(path.replace(/\//g, '\\/').replace(/\?.*$/, '')));
  await expect(page.getByRole('heading', { name: headingPattern }).first()).toBeVisible({ timeout: 25_000 });
}

const EMPLOYEE_PROFILE_ROUTES = [
  { path: '/my-profile/overview', heading: /hr services/i, nav: 'Overview' },
  { path: '/my-profile/leave', heading: /^leave$/i, nav: 'Leave' },
  { path: '/my-profile/payslips', heading: /payslips/i, nav: 'Payslips' },
  { path: '/my-profile/loans', heading: /staff loans/i, nav: 'Loans' },
  { path: '/my-profile/attendance', heading: /attendance/i, nav: 'Attendance' },
  { path: '/my-profile/employment', heading: /employment record/i, nav: 'Employment' },
  { path: '/my-profile/documents', heading: /^documents$/i, nav: 'Documents' },
  { path: '/my-profile/id-card', heading: /id card/i, nav: 'ID card' },
  { path: '/my-profile/benefits', heading: /^benefits$/i, nav: 'Benefits' },
  { path: '/my-profile/policies', heading: /company policies/i, nav: 'Policies' },
  { path: '/my-profile/grievance', heading: /raise a concern/i, nav: 'Feedback' },
  { path: '/my-profile/surveys', heading: /engagement surveys/i, nav: 'Surveys' },
  { path: '/my-profile/discipline', heading: /conduct record/i, nav: 'Conduct' },
];

test.describe('My Profile — employee smoke', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaUi(page, 'admin', 'Admin@123');
  });

  test('index redirects to overview', async ({ page }) => {
    await page.goto('/my-profile');
    await expectProfileReady(page);
    await expect(page).toHaveURL(/\/my-profile\/overview$/);
    await expect(page.getByRole('heading', { name: /hr services/i })).toBeVisible({ timeout: 20_000 });
  });

  for (const route of EMPLOYEE_PROFILE_ROUTES) {
    test(`loads ${route.path}`, async ({ page }) => {
      await expectProfileRoute(page, route.path, route.heading);
    });
  }

  test('sidebar navigation visits every employee section', async ({ page }) => {
    await page.goto('/my-profile/overview');
    await expectProfileReady(page);

    const sidebar = page.locator('aside').filter({ has: page.getByText(/^Menu$/i) });
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    for (const route of EMPLOYEE_PROFILE_ROUTES.filter((r) => r.path !== '/my-profile/overview')) {
      await sidebar.getByRole('link', { name: route.nav, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(route.path.replace(/\//g, '\\/')));
      await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible({ timeout: 20_000 });
    }
  });

  test('hub tabs switch between account and HR services', async ({ page }) => {
    await page.goto('/me');
    await expectProfileReady(page);
    await expect(page.getByRole('heading', { name: /^account$/i })).toBeVisible({ timeout: 20_000 });

    const hub = page.getByRole('navigation', { name: /profile area/i });
    await hub.getByRole('tab', { name: /hr services/i }).click();
    await expect(page).toHaveURL(/\/my-profile/);
    await expectProfileReady(page);
    await expect(page.getByRole('heading', { name: /hr services/i })).toBeVisible({ timeout: 15_000 });

    await hub.getByRole('tab', { name: /^account$/i }).click();
    await expect(page).toHaveURL(/\/me$/);
    await expectProfileReady(page);
    await expect(page.getByRole('heading', { name: /^account$/i })).toBeVisible({ timeout: 15_000 });
  });

  test('account sub-pages load', async ({ page }) => {
    await page.goto('/me/account');
    await expectProfileReady(page);
    await expect(page.getByRole('heading', { name: /account & security/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.goto('/me/services');
    await expectProfileReady(page);
    await expect(page.getByRole('heading', { name: /all services/i })).toBeVisible({ timeout: 20_000 });
  });

  test('legacy /me HR paths redirect to /my-profile', async ({ page }) => {
    const redirects = [
      { from: '/me/leave', to: /\/my-profile\/leave$/ },
      { from: '/me/payslips', to: /\/my-profile\/payslips$/ },
      { from: '/me/documents', to: /\/my-profile\/documents$/ },
      { from: '/me/employment', to: /\/my-profile\/employment$/ },
    ];

    for (const { from, to } of redirects) {
      await page.goto(from);
      await expectProfileReady(page);
      await expect(page).toHaveURL(to);
    }
  });

  test('profile APIs respond for signed-in employee', async ({ page }) => {
    await page.goto('/my-profile/overview');
    await expectProfileReady(page);

    const endpoints = [
      '/api/hr/me',
      '/api/hr/leave/balances',
      '/api/hr/payslips',
      `/api/hr/me/attendance-summary?periodYyyymm=${new Date().toISOString().slice(0, 7).replace('-', '')}`,
      '/api/hr/policy-requirements',
    ];

    for (const path of endpoints) {
      const res = await pageFetchJson(page, path);
      expect(res.status, `${path} failed: ${res.text}`).toBe(200);
    }
  });
});
