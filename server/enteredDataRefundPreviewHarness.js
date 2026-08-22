/**
 * Replay refund previews from a Zarewa entered-data xlsx export.
 * Used by scripts/test-entered-data-refund-preview.mjs and Vitest.
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { createDatabase } from './db.js';
import { previewRefundRequest } from './controlOps.js';
import { validateRefundSameRequestOverlapCategoriesNgn } from '../shared/lib/refundQuotationMoney.js';

function n(v) {
  return Math.round(Number(v) || 0);
}

function sheetRows(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name] || {}, { defval: '' });
}

function buildLinesJson(quoteLines, quotationId) {
  const rows = quoteLines.filter((l) => String(l.quotationId) === quotationId);
  const products = [];
  const accessories = [];
  const services = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    const qty = String(row.qty ?? '').trim();
    const unitPrice = String(row.unitPrice ?? '').trim();
    if (!name && !qty && !unitPrice) continue;
    const item = { name, qty, unitPrice };
    const cat = String(row.category || '').toLowerCase();
    if (cat.startsWith('access')) accessories.push(item);
    else if (cat.startsWith('serv')) services.push(item);
    else products.push(item);
  }
  return JSON.stringify({ products, accessories, services });
}

/**
 * @param {string} filePath absolute path to entered-data xlsx
 * @returns {{
 *   file: string,
 *   cancelledQuoteCount: number,
 *   cancelledWithOverpaymentExcess: number,
 *   cancelledLogicFailures: object[],
 *   cancelledWithOverpaySample: object[],
 *   historicalBothCategoryCount: number,
 *   historicalBothPreviewSample: object[],
 *   cancelledResults: object[],
 * }}
 */
export function runEnteredDataRefundPreviewChecks(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const wb = XLSX.readFile(filePath);
  const customers = sheetRows(wb, 'Customers');
  const quotes = sheetRows(wb, 'Quotations');
  const quoteLines = sheetRows(wb, 'Quotation_lines');
  const receipts = sheetRows(wb, 'Receipts');
  const ledger = sheetRows(wb, 'Ledger');
  const cuttingLists = sheetRows(wb, 'Cutting_lists');
  const jobs = sheetRows(wb, 'Production_jobs');
  const refunds = sheetRows(wb, 'Refunds');

  const quoteById = new Map(quotes.map((q) => [String(q.id), q]));

  const cancelledQuoteIds = [
    ...new Set(
      jobs
        .filter((j) => String(j.status || '').trim().toLowerCase() === 'cancelled')
        .map((j) => String(j.quotationRef || '').trim())
        .filter((id) => id && quoteById.has(id))
    ),
  ];

  const bothCategoryRefunds = refunds.filter((r) => {
    const cat = String(r.reasonCategory || '');
    return cat.includes('Order cancellation') && cat.includes('Overpayment');
  });

  const focusQuoteIds = [
    ...new Set([
      ...cancelledQuoteIds,
      ...bothCategoryRefunds.map((r) => String(r.quotationRef || '').trim()).filter(Boolean),
    ]),
  ];

  function seedQuoteSlice(db, quotationIds, { includeHistoricalRefunds = false } = {}) {
    const idSet = new Set(quotationIds);
    const custIds = new Set();
    for (const id of idSet) {
      const q = quoteById.get(id);
      if (q?.customerID) custIds.add(String(q.customerID));
    }

    const insertCustomer = db.prepare(`
      INSERT OR IGNORE INTO customers (customer_id, name, branch_id, status)
      VALUES (?, ?, 'BR-KD', 'Active')
    `);
    for (const c of customers) {
      const id = String(c.customerID || '').trim();
      if (!custIds.has(id)) continue;
      insertCustomer.run(id, String(c.name || id));
    }
    for (const id of custIds) {
      insertCustomer.run(id, id);
    }

    const insertQuote = db.prepare(`
      INSERT OR REPLACE INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status,
        lines_json, date_iso, project_name, handled_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const id of idSet) {
      const q = quoteById.get(id);
      if (!q) continue;
      insertQuote.run(
        id,
        String(q.customerID || 'CUS-UNKNOWN'),
        String(q.customer || q.customerID || 'Unknown'),
        n(q.totalNgn),
        n(q.paidNgn),
        String(q.paymentStatus || 'Paid'),
        String(q.status || 'Finished'),
        buildLinesJson(quoteLines, id),
        String(q.dateISO || '2026-05-01'),
        String(q.projectName || ''),
        String(q.handledBy || '')
      );
    }

    const insertReceipt = db.prepare(`
      INSERT OR REPLACE INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso,
        method, ledger_entry_id, bank_confirmed_at_iso, bank_received_amount_ngn,
        finance_delivery_cleared_at_iso, finance_reconciliation_saved_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of receipts) {
      const qref = String(r.quotationRef || '').trim();
      if (!idSet.has(qref)) continue;
      const rid = String(r.id || r.ledgerEntryId || '').trim() || `RCT-${qref}-${n(r.amountNgn)}`;
      const clearedAt = String(r.financeDeliveryClearedAtISO || r.bankConfirmedAtISO || r.dateISO || '2026-05-01');
      insertReceipt.run(
        rid,
        String(r.customerID || ''),
        String(r.customer || ''),
        qref,
        n(r.amountNgn),
        String(r.status || 'Cleared'),
        String(r.dateISO || '2026-05-01'),
        String(r.method || ''),
        String(r.ledgerEntryId || rid),
        clearedAt,
        n(r.bankReceivedAmountNgn || r.amountNgn),
        clearedAt,
        clearedAt
      );
    }

    const insertLedger = db.prepare(`
      INSERT OR REPLACE INTO ledger_entries (
        id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref,
        payment_method, bank_reference, purpose, created_by_name, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of ledger) {
      const qref = String(row.quotationRef || '').trim();
      if (!idSet.has(qref)) continue;
      insertLedger.run(
        String(row.id || '').trim(),
        String(row.atISO || '2026-05-01T00:00:00.000Z'),
        String(row.type || 'RECEIPT'),
        String(row.customerID || ''),
        String(row.customerName || ''),
        n(row.amountNgn),
        qref,
        String(row.paymentMethod || ''),
        String(row.bankReference || ''),
        String(row.purpose || ''),
        String(row.createdByName || ''),
        String(row.note || '')
      );
    }

    const insertCutting = db.prepare(`
      INSERT OR IGNORE INTO cutting_lists (
        id, customer_id, customer_name, quotation_ref, product_id, product_name,
        date_iso, sheets_to_cut, total_meters, status, machine_name, operator_name,
        production_registered, handled_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cl of cuttingLists) {
      const qref = String(cl.quotationRef || '').trim();
      if (!idSet.has(qref)) continue;
      insertCutting.run(
        String(cl.id || '').trim(),
        String(cl.customerID || ''),
        String(cl.customer || ''),
        qref,
        String(cl.productID || ''),
        String(cl.productName || ''),
        String(cl.dateISO || '2026-05-01'),
        Number(cl.sheetsToCut) || 0,
        Number(cl.totalMeters) || 0,
        String(cl.status || 'Waiting'),
        String(cl.machineName || ''),
        String(cl.operatorName || ''),
        String(cl.productionRegistered || '').toLowerCase() === 'yes' ? 1 : 0,
        String(cl.handledBy || '')
      );
    }

    const insertJob = db.prepare(`
      INSERT OR REPLACE INTO production_jobs (
        job_id, cutting_list_id, quotation_ref, customer_id, customer_name,
        product_id, product_name, planned_meters, actual_meters, status, created_at_iso,
        completed_at_iso, machine_name, operator_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const j of jobs) {
      const qref = String(j.quotationRef || '').trim();
      if (!idSet.has(qref)) continue;
      const clId = String(j.cuttingListId || '').trim();
      if (clId) {
        insertCutting.run(
          clId,
          String(j.customerID || ''),
          String(j.customerName || ''),
          qref,
          String(j.productID || ''),
          String(j.productName || ''),
          String(j.createdAtISO || '2026-05-01').slice(0, 10),
          0,
          Number(j.plannedMeters) || 0,
          'Waiting',
          String(j.machineName || ''),
          String(j.operatorName || ''),
          1,
          ''
        );
      }
      insertJob.run(
        String(j.jobID || '').trim(),
        clId || null,
        qref,
        String(j.customerID || ''),
        String(j.customerName || ''),
        String(j.productID || ''),
        String(j.productName || ''),
        Number(j.plannedMeters) || 0,
        Number(j.actualMeters) || 0,
        String(j.status || 'Planned'),
        String(j.createdAtISO || '2026-05-01T00:00:00.000Z'),
        String(j.completedAtISO || '') || null,
        String(j.machineName || ''),
        String(j.operatorName || '')
      );
    }

    if (includeHistoricalRefunds) {
      const insertRefund = db.prepare(`
        INSERT OR REPLACE INTO customer_refunds (
          refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
          amount_ngn, status, requested_by, requested_at_iso, approved_by, approved_amount_ngn,
          paid_amount_ngn, paid_at_iso, paid_by, payee_name, payee_bank_name, branch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of refunds) {
        const qref = String(r.quotationRef || '').trim();
        if (!idSet.has(qref)) continue;
        insertRefund.run(
          String(r.refundID || '').trim(),
          String(r.customerID || ''),
          String(r.customer || ''),
          qref,
          String(r.reasonCategory || ''),
          String(r.reason || ''),
          n(r.amountNgn),
          String(r.status || ''),
          String(r.requestedBy || ''),
          String(r.requestedAtISO || ''),
          String(r.approvedBy || ''),
          n(r.approvedAmountNgn),
          n(r.paidAmountNgn),
          String(r.paidAtISO || ''),
          String(r.paidBy || ''),
          String(r.payeeName || ''),
          String(r.payeeBankName || ''),
          String(r.branchId || 'BR-KD')
        );
      }
    }
  }

  function summarizePreview(quotationRef, prev, historical) {
    const lines = Array.isArray(prev.preview?.suggestedLines) ? prev.preview.suggestedLines : [];
    const cats = lines
      .filter((l) => n(l.amountNgn) > 0)
      .map((l) => `${l.category}:${n(l.amountNgn)}`);
    const suggested = n(prev.preview?.suggestedAmountNgn);
    const hardRaw = prev.preview?.refundHardCapNgn;
    const hard = hardRaw == null ? null : n(hardRaw);
    const cashIn = n(prev.preview?.quotationCashInNgn);
    const effectiveCap = hard == null ? cashIn : hard;
    const over = n(prev.preview?.overpaymentExcessNgn);
    const hasOver = lines.some((l) => String(l.category) === 'Overpayment' && n(l.amountNgn) > 0);
    const hasCancel = lines.some((l) => String(l.category) === 'Order cancellation' && n(l.amountNgn) > 0);
    const overlap = validateRefundSameRequestOverlapCategoriesNgn(
      lines.map((l) => ({ ...l, include: true }))
    );
    const jobStatuses = [
      ...new Set(
        jobs
          .filter((j) => String(j.quotationRef) === quotationRef)
          .map((j) => String(j.status || ''))
      ),
    ];
    const hasOpenProduction = jobStatuses.some((s) => {
      const st = String(s || '')
        .trim()
        .toLowerCase();
      return st && st !== 'completed' && st !== 'cancelled';
    });
    return {
      quotationRef,
      ok: Boolean(prev.ok),
      jobStatuses,
      hasOpenProduction,
      quoteTotal: n(prev.preview?.quoteTotalNgn),
      cashIn,
      overpaymentExcess: over,
      hardCap: hard,
      effectiveCap,
      suggestedAmount: suggested,
      suggestedLines: cats,
      stacksOverpayAndCancel: hasOver && hasCancel,
      overlapOk: overlap.ok,
      exceedsHardCap: suggested > effectiveCap + 1,
      historicalRefunds: historical,
    };
  }

  const db = createDatabase(':memory:', { seed: false });
  try {
    seedQuoteSlice(db, focusQuoteIds, { includeHistoricalRefunds: false });

    const cancelledResults = [];
    for (const qid of cancelledQuoteIds) {
      const prev = previewRefundRequest(db, { quotationRef: qid });
      const hist = refunds
        .filter((r) => String(r.quotationRef) === qid)
        .map((r) => ({
          id: r.refundID,
          status: r.status,
          amount: n(r.amountNgn),
          cat: r.reasonCategory,
        }));
      cancelledResults.push(summarizePreview(qid, prev, hist));
    }

    const bothResults = [];
    for (const r of bothCategoryRefunds) {
      const qid = String(r.quotationRef || '').trim();
      const prev = previewRefundRequest(db, { quotationRef: qid });
      bothResults.push({
        historicalRefund: {
          id: r.refundID,
          amount: n(r.amountNgn),
          status: r.status,
          cat: r.reasonCategory,
        },
        ...summarizePreview(qid, prev, []),
      });
    }

    const cancelledFailures = cancelledResults.filter(
      (r) => r.stacksOverpayAndCancel || r.exceedsHardCap || !r.overlapOk
    );
    const cancelledWithOverpay = cancelledResults.filter((r) => r.overpaymentExcess > 0);

    return {
      file: path.basename(filePath),
      cancelledQuoteCount: cancelledQuoteIds.length,
      cancelledWithOverpaymentExcess: cancelledWithOverpay.length,
      cancelledLogicFailures: cancelledFailures,
      cancelledWithOverpaySample: cancelledWithOverpay.slice(0, 12),
      historicalBothCategoryCount: bothCategoryRefunds.length,
      historicalBothPreviewSample: bothResults.slice(0, 8),
      cancelledResults,
      bothResults,
    };
  } finally {
    db.close();
  }
}
