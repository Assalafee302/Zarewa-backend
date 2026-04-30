import { test, expect } from '@playwright/test';
import { signInViaApi, signOutViaApi } from './helpers/auth.js';

test.describe.configure({ timeout: 90_000 });

test.describe('Refund intelligence API', () => {
  test('GET /api/refunds/intelligence returns dataQualityIssues array', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const res = await page.request.get(
      '/api/refunds/intelligence?quotationRef=QT-2026-001'
    );
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.dataQualityIssues)).toBe(true);
    await signOutViaApi(page);
  });
});
