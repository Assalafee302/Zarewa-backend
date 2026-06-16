import { test, expect } from '@playwright/test';
import { signInViaApi, pageFetchJson } from './helpers/auth.js';

test.describe.configure({ timeout: 90_000 });

test.describe('HR API', () => {
  test('health and dashboard respond for admin', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const health = await pageFetchJson(page, '/api/hr/health');
    expect(health.status).toBe(200);
    expect(health.json?.hrReady).toBe(true);

    const dash = await pageFetchJson(page, '/api/hr/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.json?.ok).toBe(true);
    expect(dash.json?.staffCounts).toBeTruthy();
  });

  test('reports summary and leave calendar', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const reports = await pageFetchJson(page, '/api/hr/reports/summary');
    expect(reports.status).toBe(200);
    expect(reports.json?.ok).toBe(true);

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const cal = await pageFetchJson(page, `/api/hr/leave/calendar?from=${from}&to=${to}`);
    expect(cal.status).toBe(200);
    expect(cal.json?.ok).toBe(true);
  });

  test('sales staff staff list has redacted compensation', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const res = await pageFetchJson(page, '/api/hr/staff');
    if (res.status === 403) {
      test.skip();
      return;
    }
    expect(res.status).toBe(200);
    const staff = res.json?.staff || [];
    const exposed = staff.filter((s) => s.baseSalaryNgn != null && Number(s.baseSalaryNgn) > 0);
    expect(exposed.length).toBe(0);
  });

  test('employment letter generate and PDF export', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const staffRes = await pageFetchJson(page, '/api/hr/staff');
    expect(staffRes.status).toBe(200);
    const staff = staffRes.json?.staff || [];
    const userId = staff[0]?.userId;
    if (!userId) {
      test.skip();
      return;
    }
    const gen = await pageFetchJson(page, '/api/hr/employment-letters/generate', {
      method: 'POST',
      body: { userId, letterKind: 'employment' },
    });
    expect(gen.status).toBe(201);
    const letterId = gen.json?.id;
    const pdf = await pageFetchJson(page, `/api/hr/employment-letters/${encodeURIComponent(letterId)}/preview`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const buf = Buffer.from(pdf.body);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
