import { test, expect } from '@playwright/test';
import { signInViaApi, signOutViaApi, csrfHeader } from './helpers/auth';

test.describe.configure({ timeout: 120_000 });

test.describe('Edit approvals (second-party token)', () => {
  test('procurement requests token; admin approves on /edit-approvals; PATCH succeeds once', async ({ page }) => {
    const runTag = `pw-ea-${Date.now()}`;

    await signInViaApi(page, 'procurement', 'Procure@123');

    const poRes = await page.request.post('/api/purchase-orders', {
      headers: await csrfHeader(page),
      data: {
        supplierID: 'SUP-001',
        supplierName: `EA supplier ${runTag}`,
        orderDateISO: '2026-04-01',
        expectedDeliveryISO: '',
        lines: [
          {
            lineKey: 'L1',
            productID: 'COIL-ALU',
            productName: 'Alu',
            qtyOrdered: 100,
            unitPriceNgn: 100,
          },
        ],
        status: 'Pending',
      },
    });
    expect(poRes.status(), await poRes.text()).toBe(201);
    const poJson = await poRes.json();
    const poId = poJson.poID;
    expect(poId).toBeTruthy();

    const denied = await page.request.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`, {
      headers: await csrfHeader(page),
      data: { status: 'Approved' },
    });
    expect(denied.status()).toBe(403);
    const deniedJson = await denied.json();
    expect(deniedJson.code).toBe('EDIT_APPROVAL_REQUIRED');

    const reqRes = await page.request.post('/api/edit-approvals/request', {
      headers: await csrfHeader(page),
      data: { entityKind: 'purchase_order', entityId: poId },
    });
    expect(reqRes.status(), await reqRes.text()).toBe(200);
    const reqJson = await reqRes.json();
    expect(reqJson.ok).toBe(true);
    const approvalId = reqJson.approvalId;
    expect(approvalId).toBeTruthy();

    await signOutViaApi(page);
    await signInViaApi(page, 'admin', 'Admin@123');

    await page.goto('/edit-approvals');
    await expect(page.getByRole('heading', { name: /^Edit approvals$/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('li').filter({ hasText: poId })).toBeVisible({ timeout: 15_000 });
    await page.locator('li').filter({ hasText: poId }).getByRole('button', { name: /^Approve$/i }).click();
    await expect(page.getByText(/edit approval granted/i)).toBeVisible({ timeout: 15_000 });

    await signOutViaApi(page);
    await signInViaApi(page, 'procurement', 'Procure@123');

    const okPatch = await page.request.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`, {
      headers: await csrfHeader(page),
      data: { status: 'Approved', editApprovalId: approvalId },
    });
    expect(okPatch.status(), await okPatch.text()).toBe(200);
    const okJson = await okPatch.json();
    expect(okJson.ok).toBe(true);

    const deniedAgain = await page.request.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`, {
      headers: await csrfHeader(page),
      data: { status: 'Rejected' },
    });
    expect(deniedAgain.status()).toBe(403);
  });
});
