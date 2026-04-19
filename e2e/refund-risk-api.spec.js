import { test, expect } from '@playwright/test';
import { signInViaApi } from './helpers/auth.js';
import { csrfHeader } from './helpers/auth.js';
import { seedOverpaidQuotation } from './helpers/refundRiskSeed.js';

test.describe.configure({ timeout: 120_000 });

test.describe('Refund risk — API behaviour', () => {
  test('preview suggests overpayment when receipts exceed quote total', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const { quotationId } = await seedOverpaidQuotation(page);
    const headers = await csrfHeader(page);

    const prev = await page.request.post('/api/refunds/preview', {
      headers,
      data: {
        quotationRef: quotationId,
        reasonCategory: ['Overpayment'],
      },
    });
    expect(prev.status(), await prev.text()).toBe(200);
    const body = await prev.json();
    expect(body.ok).toBe(true);
    const line = (body.preview?.suggestedLines || []).find((l) => l.category === 'Overpayment');
    expect(line, 'overpayment line').toBeTruthy();
    expect(line.amountNgn).toBe(2000);
  });

  test('duplicate refund same category on same quotation is rejected', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const { customerID, quotationId, customerName } = await seedOverpaidQuotation(page);
    const headers = await csrfHeader(page);

    const payload = {
      customerID,
      customer: customerName,
      quotationRef: quotationId,
      amountNgn: 100,
      reasonCategory: ['Overpayment'],
      reason: 'dup test',
      calculationLines: [{ label: 'Overpay', amountNgn: 100, category: 'Overpayment' }],
    };

    const first = await page.request.post('/api/refunds', { headers, data: payload });
    expect(first.status(), await first.text()).toBe(201);

    const second = await page.request.post('/api/refunds', { headers, data: { ...payload, amountNgn: 50 } });
    expect(second.status()).toBe(400);
    const err = await second.json();
    expect(String(err.error || '')).toMatch(/already exists/i);
  });

  test('sales staff cannot post refund payout (finance only)', async ({ page }) => {
    await signInViaApi(page, 'sales.staff', 'Sales@123');
    const headers = await csrfHeader(page);

    const pay = await page.request.post('/api/refunds/RF-NONEXISTENT/pay', {
      headers,
      data: {
        paidAtISO: new Date().toISOString(),
        lines: [{ treasuryAccountId: 'x', amountNgn: 1 }],
      },
    });
    expect([403, 404]).toContain(pay.status());
  });
});
