/**
 * HTTP helpers for refund E2E — finance must clear receipts before POST /api/refunds.
 */
import { withTestQuotationMaterial } from './testQuotationFixtures.js';

/** Mark uncleared sales receipts cleared (matches finance settlement outcome). */
export function markQuotationReceiptsClearedForRefundTests(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return;
  db.prepare(
    `UPDATE sales_receipts
     SET finance_reconciliation_saved_at_iso = '2026-03-29T12:00:00Z',
         bank_confirmed_at_iso = COALESCE(bank_confirmed_at_iso, '2026-03-29T12:00:00Z'),
         status = 'Cleared'
     WHERE quotation_ref = ?
       AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed', 'cleared', 'confirmed'))
       AND (finance_reconciliation_saved_at_iso IS NULL OR TRIM(finance_reconciliation_saved_at_iso) = '')`
  ).run(qid);
}

/**
 * Post ledger receipt and finalize finance settlement (required before refund requests).
 * @param {import('supertest').SuperAgentTest} agent authenticated agent with finance.pay or admin
 */
export async function postLedgerReceiptAndClearFinance(
  agent,
  {
    customerID,
    quotationRef,
    amountNgn,
    treasuryAccountId,
    paymentMethod = 'Transfer',
    dateISO = '2026-03-29',
    referencePrefix = 'RCP-E2E',
  }
) {
  const reference = `${referencePrefix}-${Date.now()}`;
  const rcpt = await agent.post('/api/ledger/receipt').send({
    customerID,
    quotationId: quotationRef,
    amountNgn,
    confirmAmountNgn: amountNgn,
    paymentMethod,
    dateISO,
    treasuryAccountId,
    paymentLines: [{ treasuryAccountId, amountNgn, reference }],
    forceDuplicatePost: true,
    duplicateOverrideReason: 'Refund E2E automated test',
  });
  if (rcpt.status !== 201) {
    throw new Error(`Receipt post failed (${rcpt.status}): ${JSON.stringify(rcpt.body)}`);
  }
  const receiptId = rcpt.body.receipt?.id || rcpt.body.receiptId;
  const settle = await agent
    .patch(`/api/sales-receipts/${encodeURIComponent(receiptId)}/finance-settlement`)
    .send({ bankReceivedAmountNgn: amountNgn });
  if (settle.status !== 200) {
    throw new Error(`Finance settlement failed (${settle.status}): ${JSON.stringify(settle.body)}`);
  }
  return { receiptId, rcpt, settle };
}

/**
 * Paid quotation with finance-cleared receipt and cancelled production (refund-eligible).
 * Cutting metres match quoted qty so roofing alignment passes.
 */
export async function createRefundEligibleQuotation(agent, {
  customerID = 'CUS-001',
  treasuryAccountId,
  amountNgn = 250_000,
  metres = 10,
  projectName = `Refund E2E ${Date.now()}`,
  overpayNgn = 0,
} = {}) {
  const unitPrice = Math.round(Number(amountNgn) / metres);
  const totalNgn = unitPrice * metres;
  const q = await agent.post('/api/quotations').send(
    withTestQuotationMaterial({
      customerID,
      projectName,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Roofing Sheet', qty: String(metres), unitPrice: String(unitPrice) }],
        accessories: [],
        services: [],
      },
    })
  );
  if (q.status !== 201) {
    throw new Error(`Quotation post failed (${q.status}): ${JSON.stringify(q.body)}`);
  }
  const quotationRef =
    q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;
  await postLedgerReceiptAndClearFinance(agent, {
    customerID,
    quotationRef,
    amountNgn: totalNgn,
    treasuryAccountId,
    referencePrefix: 'RCP-ELIG',
  });
  const extra = Math.round(Number(overpayNgn) || 0);
  if (extra > 0) {
    await postLedgerReceiptAndClearFinance(agent, {
      customerID,
      quotationRef,
      amountNgn: extra,
      treasuryAccountId,
      referencePrefix: 'RCP-OVR',
    });
  }
  const cutting = await agent.post('/api/cutting-lists').send({
    quotationRef,
    customerID,
    productID: 'FG-101',
    productName: 'Longspan thin',
    dateISO: '2026-03-29',
    machineName: 'Machine 01',
    operatorName: 'QA',
    lines: [{ sheets: 1, lengthM: metres }],
  });
  if (cutting.status !== 201) {
    throw new Error(`Cutting list post failed (${cutting.status}): ${JSON.stringify(cutting.body)}`);
  }
  const job = await agent.post('/api/production-jobs').send({
    cuttingListId: cutting.body.id,
    productID: 'FG-101',
    productName: 'Longspan thin',
    plannedMeters: metres,
    plannedSheets: 1,
  });
  if (job.status !== 201) {
    throw new Error(`Production job post failed (${job.status}): ${JSON.stringify(job.body)}`);
  }
  const cancel = await agent
    .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/cancel`)
    .send({ reason: 'E2E refund eligibility — cancelled before run' });
  if (cancel.status !== 200) {
    throw new Error(`Job cancel failed (${cancel.status}): ${JSON.stringify(cancel.body)}`);
  }
  return { quotationRef, totalNgn, cuttingId: cutting.body.id, jobID: job.body.jobID };
}
