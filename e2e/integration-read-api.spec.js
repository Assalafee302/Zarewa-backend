import { test, expect } from '@playwright/test';
import { signInViaApi, csrfHeader } from './helpers/auth';

test.describe.configure({ timeout: 90_000 });

test('integration API: create key, read trial balance with Bearer, revoke', async ({ page }) => {
  await signInViaApi(page, 'admin', 'Admin@123');
  const headers = { ...(await csrfHeader(page)), 'Content-Type': 'application/json' };
  const cre = await page.request.post('/api/settings/integration-api-keys', {
    headers,
    data: { name: 'playwright-smoke' },
  });
  expect(cre.status(), await cre.text()).toBe(201);
  const body = await cre.json();
  expect(body.ok).toBe(true);
  expect(body.token).toBeTruthy();

  const tb = await page.request.get(
    `/api/integration/v1/trial-balance?startDate=2026-01-01&endDate=2026-12-31`,
    { headers: { Authorization: `Bearer ${body.token}` } }
  );
  expect(tb.status(), await tb.text()).toBe(200);
  const tbJson = await tb.json();
  expect(tbJson.ok).toBe(true);

  const revoke = await page.request.patch(
    `/api/settings/integration-api-keys/${encodeURIComponent(body.id)}/revoke`,
    { headers, data: '{}' }
  );
  expect(revoke.status(), await revoke.text()).toBe(200);

  const tb2 = await page.request.get(
    `/api/integration/v1/trial-balance?startDate=2026-01-01&endDate=2026-12-31`,
    { headers: { Authorization: `Bearer ${body.token}` } }
  );
  expect(tb2.status()).toBe(401);
});
