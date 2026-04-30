import { test, expect } from '@playwright/test';
import { signInViaApi, csrfHeader } from './helpers/auth';

test.describe.configure({ timeout: 120_000 });

test.describe('Bank reconciliation import upgrade', () => {
  test('CSV import skips duplicate rows on second POST', async ({ page }) => {
    await signInViaApi(page, 'finance.manager', 'Finance@123');
    const csv = `bankDateISO,description,amountNgn
2026-04-23,"E2E dup skip",-33333`;
    const r1 = await page.request.post('/api/bank-reconciliation/import-csv', {
      headers: await csrfHeader(page),
      data: { csvText: csv },
    });
    expect(r1.status(), await r1.text()).toBe(200);
    const j1 = await r1.json();
    expect(j1.createdCount).toBeGreaterThanOrEqual(1);

    const r2 = await page.request.post('/api/bank-reconciliation/import-csv', {
      headers: await csrfHeader(page),
      data: { csvText: csv },
    });
    expect(r2.status(), await r2.text()).toBe(200);
    const j2 = await r2.json();
    expect(j2.createdCount).toBe(0);
    expect(j2.skippedDuplicateCount).toBeGreaterThanOrEqual(1);
  });
});
