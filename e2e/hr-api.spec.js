import { test, expect } from '@playwright/test';
import { signInViaApi, csrfHeader } from './helpers/auth.js';

test.describe.configure({ timeout: 90_000 });

test.describe('HR API', () => {
  test('health and dashboard respond for admin', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const health = await page.request.get('/api/hr/health');
    expect(health.status()).toBe(200);
    expect((await health.json()).hrReady).toBe(true);

    const dash = await page.request.get('/api/hr/dashboard');
    expect(dash.status()).toBe(200);
    const body = await dash.json();
    expect(body.ok).toBe(true);
    expect(body.staffCounts).toBeTruthy();
  });

  test('reports summary and leave calendar', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const reports = await page.request.get('/api/hr/reports/summary');
    expect(reports.status()).toBe(200);
    expect((await reports.json()).ok).toBe(true);

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const cal = await page.request.get(`/api/hr/leave/calendar?from=${from}&to=${to}`);
    expect(cal.status()).toBe(200);
    expect((await cal.json()).ok).toBe(true);
  });

  test('sales staff staff list has redacted compensation', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const res = await page.request.get('/api/hr/staff');
    if (res.status() === 403) {
      test.skip();
      return;
    }
    expect(res.status()).toBe(200);
    const staff = (await res.json()).staff || [];
    const exposed = staff.filter((s) => s.baseSalaryNgn != null && Number(s.baseSalaryNgn) > 0);
    expect(exposed.length).toBe(0);
  });

  test('employment letter generate and PDF export', async ({ page }) => {
    await signInViaApi(page, 'admin', 'Admin@123');
    const headers = await csrfHeader(page);
    const staffRes = await page.request.get('/api/hr/staff');
    expect(staffRes.status()).toBe(200);
    const staff = (await staffRes.json()).staff || [];
    const userId = staff[0]?.userId;
    if (!userId) {
      test.skip();
      return;
    }
    const gen = await page.request.post('/api/hr/employment-letters/generate', {
      headers,
      data: { userId, letterKind: 'employment' },
    });
    expect(gen.status()).toBe(201);
    const letterId = (await gen.json()).id;
    const pdf = await page.request.get(`/api/hr/employment-letters/${encodeURIComponent(letterId)}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    const buf = await pdf.body();
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
