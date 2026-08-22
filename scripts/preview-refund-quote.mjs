/**
 * Preview refund breakdown for one quotation (xlsx row or lab scenario).
 *
 * Usage:
 *   node scripts/preview-refund-quote.mjs --lab
 *   node scripts/preview-refund-quote.mjs --quote QT-KD-26-0449
 *   node scripts/preview-refund-quote.mjs --quote QT-KD-26-0029 --file "zarewa-entered-data (1).xlsx"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { createDatabase } from '../server/db.js';
import { previewRefundRequest } from '../server/controlOps.js';
import { validateRefundSameRequestOverlapCategoriesNgn } from '../shared/lib/refundQuotationMoney.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : fallback;
}

function n(v) {
  return Math.round(Number(v) || 0);
}

function printHumanSummary(summary) {
  const money = (v) => (v == null ? '—' : `₦${n(v).toLocaleString('en-NG')}`);
  console.error('');
  console.error('── Refund preview ──');
  if (summary.scenario === 'lab') {
    console.error(`Scenario: lab (${summary.mapsToUiQuoteId || 'demo'})`);
    if (summary.note) console.error(summary.note);
  } else {
    console.error(`Quotation: ${summary.quotationRef} (${summary.sourceFile || 'seed'})`);
  }
  console.error(`Quote total: ${money(summary.quoteTotal)} · Cash in: ${money(summary.cashIn)} · Overpay: ${money(summary.overpaymentExcess)}`);
  console.error(`Suggested refund: ${money(summary.suggestedAmount)} · Hard cap: ${money(summary.hardCap)}`);
  if (summary.hasCancelledProductionJob) console.error('Production: cancelled job (Order cancellation path)');
  if (summary.openProductionJob?.jobId) {
    console.error(`Production: OPEN ${summary.openProductionJob.jobId} (${summary.openProductionJob.status || '?'}) — refund blocked until closed`);
  }
  if (summary.suggestedLines?.length) {
    console.error('Lines:');
    for (const l of summary.suggestedLines) {
      console.error(`  · ${l.category}: ${money(l.amountNgn)}${l.label ? ` — ${l.label}` : ''}`);
    }
  }
  if (summary.stacksOverpayAndCancel) {
    console.error('⚠ Double-count risk: both Overpayment and Order cancellation are positive.');
  } else if (summary.uiExpect?.showOverpayContextOnly) {
    console.error('✓ Overpay shown as context only (included in Order cancellation).');
  }
  if (summary.warnings?.length) {
    console.error('Warnings:');
    for (const w of summary.warnings) console.error(`  · ${w}`);
  }
  console.error('');
}

function summarize(prev, quotationRef, meta = {}) {
  const lines = Array.isArray(prev.preview?.suggestedLines) ? prev.preview.suggestedLines : [];
  const positive = lines.filter((l) => n(l.amountNgn) > 0);
  const overlap = validateRefundSameRequestOverlapCategoriesNgn(
    positive.map((l) => ({ ...l, include: true }))
  );
  return {
    ...meta,
    quotationRef,
    ok: Boolean(prev.ok),
    quoteTotal: n(prev.preview?.quoteTotalNgn),
    cashIn: n(prev.preview?.quotationCashInNgn),
    overpaymentExcess: n(prev.preview?.overpaymentExcessNgn),
    hardCap: prev.preview?.refundHardCapNgn != null ? n(prev.preview.refundHardCapNgn) : null,
    suggestedAmount: n(prev.preview?.suggestedAmountNgn),
    suggestedLines: positive.map((l) => ({
      category: l.category,
      amountNgn: n(l.amountNgn),
      label: l.label,
    })),
    hasCancelledProductionJob: Boolean(prev.preview?.hasCancelledProductionJob),
    openProductionJob: prev.preview?.openProductionJob || null,
    stacksOverpayAndCancel:
      positive.some((l) => l.category === 'Overpayment') &&
      positive.some((l) => l.category === 'Order cancellation'),
    overlapOk: overlap.ok,
    warnings: (prev.preview?.warnings || []).slice(0, 6),
    uiExpect: {
      createPath: positive.some((l) => l.category === 'Order cancellation') ? 'full' : undefined,
      quickOverpayDisabled: Boolean(prev.preview?.hasCancelledProductionJob),
      showOverpayContextOnly:
        n(prev.preview?.overpaymentExcessNgn) > 0 &&
        positive.some((l) => l.category === 'Order cancellation') &&
        !positive.some((l) => l.category === 'Overpayment'),
    },
  };
}

function seedLabScenario(db) {
  const linesJson = JSON.stringify({
    products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '4500' }],
    accessories: [],
    services: [],
  });
  db.exec(`
    INSERT INTO customers (customer_id, name, branch_id, status, bank_account_name, bank_name, bank_account_no)
    VALUES ('CUS-LAB-7vwl', 'Refund Lab Customer 7vwl', 'BR-KD', 'Active', 'Refund Lab Customer 7vwl', 'Guaranty Trust Bank', '0123456789');
    INSERT INTO quotations (
      id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, project_name
    ) VALUES (
      'QT-LAB-CANCEL-OVP', 'CUS-LAB-7vwl', 'Refund Lab Customer 7vwl', 180000, 260000, 'Paid', 'Finished',
      '${linesJson.replace(/'/g, "''")}', '2026-05-01', 'Lab cancel overpay'
    );
    INSERT INTO sales_receipts (
      id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso,
      finance_reconciliation_saved_at_iso, bank_confirmed_at_iso, bank_received_amount_ngn
    ) VALUES (
      'RCT-LAB-7vwl', 'CUS-LAB-7vwl', 'Refund Lab Customer 7vwl', 'QT-LAB-CANCEL-OVP', 260000, 'Cleared', '2026-05-01',
      '2026-05-01T12:00:00.000Z', '2026-05-01T12:00:00.000Z', 260000
    );
    INSERT INTO production_jobs (
      job_id, quotation_ref, customer_id, customer_name, status, planned_meters, actual_meters, created_at_iso
    ) VALUES (
      'PRO-LAB-0001', 'QT-LAB-CANCEL-OVP', 'CUS-LAB-7vwl', 'Refund Lab Customer 7vwl', 'Cancelled', 40, 0,
      '2026-05-01T00:00:00.000Z'
    );
  `);
  return 'QT-LAB-CANCEL-OVP';
}

function seedQuoteFromXlsx(db, filePath, quotationRef) {
  const wb = XLSX.readFile(filePath);
  const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name] || {}, { defval: '' });
  const quotes = sheet('Quotations');
  const quote = quotes.find((q) => String(q.id) === quotationRef);
  if (!quote) throw new Error(`Quotation ${quotationRef} not found in ${path.basename(filePath)}`);

  const quoteLines = sheet('Quotation_lines');
  const products = [];
  const accessories = [];
  const services = [];
  for (const row of quoteLines.filter((l) => String(l.quotationId) === quotationRef)) {
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
  const linesJson = JSON.stringify({ products, accessories, services }).replace(/'/g, "''");

  const custId = String(quote.customerID || 'CUS-UNKNOWN');
  db.prepare(
    `INSERT OR IGNORE INTO customers (customer_id, name, branch_id, status) VALUES (?, ?, 'BR-KD', 'Active')`
  ).run(custId, String(quote.customer || custId));

  db.prepare(
    `INSERT OR REPLACE INTO quotations (
      id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, project_name, handled_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    quotationRef,
    custId,
    String(quote.customer || custId),
    n(quote.totalNgn),
    n(quote.paidNgn),
    String(quote.paymentStatus || 'Paid'),
    String(quote.status || 'Finished'),
    linesJson,
    String(quote.dateISO || '2026-05-01'),
    String(quote.projectName || ''),
    String(quote.handledBy || '')
  );

  for (const r of sheet('Receipts').filter((x) => String(x.quotationRef) === quotationRef)) {
    const rid = String(r.id || r.ledgerEntryId || `RCT-${quotationRef}`);
    const clearedAt = String(r.financeDeliveryClearedAtISO || r.bankConfirmedAtISO || r.dateISO || '2026-05-01');
    db.prepare(
      `INSERT OR REPLACE INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso,
        ledger_entry_id, bank_confirmed_at_iso, bank_received_amount_ngn,
        finance_delivery_cleared_at_iso, finance_reconciliation_saved_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rid,
      String(r.customerID || custId),
      String(r.customer || ''),
      quotationRef,
      n(r.amountNgn),
      String(r.status || 'Cleared'),
      String(r.dateISO || '2026-05-01'),
      String(r.ledgerEntryId || rid),
      clearedAt,
      n(r.bankReceivedAmountNgn || r.amountNgn),
      clearedAt,
      clearedAt
    );
  }

  for (const row of sheet('Ledger').filter((x) => String(x.quotationRef) === quotationRef)) {
    db.prepare(
      `INSERT OR REPLACE INTO ledger_entries (
        id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(row.id),
      String(row.atISO || '2026-05-01T00:00:00.000Z'),
      String(row.type || 'RECEIPT'),
      String(row.customerID || custId),
      String(row.customerName || ''),
      n(row.amountNgn),
      quotationRef
    );
  }

  const insertCutting = db.prepare(
    `INSERT OR IGNORE INTO cutting_lists (id, customer_id, customer_name, quotation_ref, date_iso, status, production_registered)
     VALUES (?, ?, ?, ?, ?, 'Waiting', 1)`
  );
  for (const j of sheet('Production_jobs').filter((x) => String(x.quotationRef) === quotationRef)) {
    const clId = String(j.cuttingListId || '').trim();
    if (clId) {
      insertCutting.run(clId, String(j.customerID || custId), String(j.customerName || ''), quotationRef, '2026-05-01');
    }
    db.prepare(
      `INSERT OR REPLACE INTO production_jobs (
        job_id, cutting_list_id, quotation_ref, customer_id, customer_name, status, planned_meters, actual_meters, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(j.jobID),
      clId || null,
      quotationRef,
      String(j.customerID || custId),
      String(j.customerName || ''),
      String(j.status || 'Planned'),
      Number(j.plannedMeters) || 0,
      Number(j.actualMeters) || 0,
      String(j.createdAtISO || '2026-05-01T00:00:00.000Z')
    );
  }

  return quotationRef;
}

const useLab = process.argv.includes('--lab');
const quoteArg = argValue('--quote', '');
const xlsxPath = path.resolve(root, argValue('--file', 'zarewa-entered-data (1).xlsx'));

const db = createDatabase(':memory:', { seed: false });
try {
  let quotationRef;
  let meta = {};
  if (useLab) {
    quotationRef = seedLabScenario(db);
    meta = {
      scenario: 'lab',
      note: 'Matches Sales lab paste (180k quote / 260k cash / cancelled job). Not the KASU row in xlsx QT-KD-26-0029.',
      mapsToUiQuoteId: 'QT-KD-26-0029 (demo seed only)',
    };
  } else if (quoteArg) {
    if (!fs.existsSync(xlsxPath)) {
      console.error(`File not found: ${xlsxPath}`);
      process.exit(1);
    }
    quotationRef = seedQuoteFromXlsx(db, xlsxPath, quoteArg);
    meta = { scenario: 'xlsx', sourceFile: path.basename(xlsxPath) };
  } else {
    console.error('Usage: --lab OR --quote QT-…');
    process.exit(1);
  }

  const prev = previewRefundRequest(db, { quotationRef });
  const summary = summarize(prev, quotationRef, meta);
  printHumanSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  db.close();
}
