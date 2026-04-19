/**
 * Polls GET /api/bootstrap until the refund appears as Approved (finance payout queue).
 */
export async function waitForRefundApprovedInBootstrap(page, refundID, { timeoutMs = 60_000 } = {}) {
  const id = String(refundID ?? '').trim();
  if (!id) throw new Error('waitForRefundApprovedInBootstrap: refundID required');
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = await page.request.get('/api/bootstrap');
    if (r.ok()) {
      const j = await r.json();
      const rf = (j.refunds || []).find((x) => String(x.refundID) === id);
      if (rf) {
        lastStatus = String(rf.status ?? '');
        if (lastStatus === 'Approved') {
          const paid = Number(rf.paidAmountNgn) || 0;
          const approved = Number(rf.approvedAmountNgn) || 0;
          const req = Number(rf.amountNgn) || 0;
          const out = Math.max(0, (approved || req) - paid);
          if (out > 0) return rf;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `Refund ${id} did not reach Approved with outstanding payout in time (last status: ${lastStatus || 'missing'})`
  );
}
