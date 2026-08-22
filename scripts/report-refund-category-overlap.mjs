/**
 * List historical refunds that combined Overpayment + Order cancellation
 * (double-count risk under current guards).
 *
 * Usage:
 *   node scripts/report-refund-category-overlap.mjs
 *   node scripts/report-refund-category-overlap.mjs --file "zarewa-entered-data (1).xlsx"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : fallback;
}

const filePath = path.resolve(root, argValue('--file', 'zarewa-entered-data (1).xlsx'));
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const wb = XLSX.readFile(filePath);
const refunds = XLSX.utils.sheet_to_json(wb.Sheets.Refunds || {}, { defval: '' });
const quotes = XLSX.utils.sheet_to_json(wb.Sheets.Quotations || {}, { defval: '' });
const quoteById = Object.fromEntries(quotes.map((q) => [String(q.id), q]));

function parseCats(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* plain text */
  }
  return [s];
}

const overlap = refunds.filter((r) => {
  const cats = parseCats(r.reasonCategory);
  return cats.includes('Overpayment') && cats.includes('Order cancellation');
});

const rows = overlap.map((r) => {
  const q = quoteById[String(r.quotationRef || '')];
  const quoteTotalNgn = q ? Math.round(Number(q.totalNgn) || 0) : null;
  const paidNgn = q ? Math.round(Number(q.paidNgn) || 0) : null;
  const cashOverQuoteNgn =
    q != null ? Math.max(0, Math.round(Number(q.paidNgn) || 0) - Math.round(Number(q.totalNgn) || 0)) : null;
  const amountNgn = Math.round(Number(r.amountNgn) || 0);
  const status = String(r.status || '').trim();
  let reviewStatus = 'SKIP';
  let reviewNote = '';
  let financeAction = '';
  if (status.toLowerCase() === 'paid') {
    if (amountNgn <= (cashOverQuoteNgn || 0) + 1) {
      reviewStatus = 'REVIEW_LOW_RISK';
      reviewNote =
        'Paid amount ≈ cash-over-quote only; may reflect overpayment slice — still verify combined categories on voucher.';
    } else if (amountNgn > (cashOverQuoteNgn || 0) + 1000) {
      reviewStatus = 'REVIEW_HIGH_RISK';
      reviewNote =
        'Paid amount exceeds over-quote excess — likely stacked cancellation + overpayment on same cash.';
    } else {
      reviewStatus = 'REVIEW_REQUIRED';
      reviewNote = 'Paid refund used both categories — verify ledger did not pay twice.';
    }
    financeAction = 'Manual finance review — current guards block new overlap; no auto-reversal.';
  }
  return {
    refundID: r.refundID,
    quotationRef: r.quotationRef,
    status: r.status,
    amountNgn,
    quoteTotalNgn,
    paidNgn,
    cashOverQuoteNgn,
    reasonCategory: r.reasonCategory,
    reviewStatus,
    reviewNote,
    financeAction,
  };
});

function printOverlapSummary(report) {
  const money = (v) => `₦${Math.round(Number(v) || 0).toLocaleString('en-NG')}`;
  console.error('');
  console.error('── Refund category overlap (Overpayment + Order cancellation) ──');
  console.error(`Source: ${report.file} · ${report.overlapCount} rows (${report.paidCount} paid) · ${report.reviewRequiredCount} need finance review`);
  const tiers = ['REVIEW_HIGH_RISK', 'REVIEW_REQUIRED', 'REVIEW_LOW_RISK', 'SKIP'];
  for (const tier of tiers) {
    const tierRows = report.rows.filter((r) => r.reviewStatus === tier);
    if (!tierRows.length) continue;
    console.error(`\n${tier} (${tierRows.length}):`);
    for (const r of tierRows) {
      console.error(
        `  ${r.refundID} · ${r.quotationRef} · ${r.status} · ${money(r.amountNgn)} · over-quote ${money(r.cashOverQuoteNgn ?? 0)}`
      );
    }
  }
  console.error('\nCurrent guards block new overlap; paid rows need manual finance review.\n');
}

const report = {
  file: path.basename(filePath),
  generatedAt: new Date().toISOString(),
  overlapCount: rows.length,
  paidCount: rows.filter((r) => String(r.status).toLowerCase() === 'paid').length,
  reviewRequiredCount: rows.filter((r) => r.reviewStatus.startsWith('REVIEW_')).length,
  rows,
};

const outPath = argValue('--out', '');
const reviewOut = argValue('--review-out', 'refund-overlap-review.json');
if (outPath) {
  const absOut = path.resolve(outPath);
  const md = [
    '# Refund category overlap audit',
    '',
    `Source: ${path.basename(filePath)}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    `**${report.overlapCount}** refunds combined Overpayment + Order cancellation (${report.paidCount} paid).`,
    'Current guards block this on new requests; review paid rows for double-count risk.',
    '',
    '| Refund | Quotation | Status | Amount | Quote | Paid | Over quote |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.refundID} | ${r.quotationRef} | ${r.status} | ₦${r.amountNgn.toLocaleString('en-NG')} | ₦${(r.quoteTotalNgn ?? 0).toLocaleString('en-NG')} | ₦${(r.paidNgn ?? 0).toLocaleString('en-NG')} | ₦${(r.cashOverQuoteNgn ?? 0).toLocaleString('en-NG')} |`
    ),
    '',
  ].join('\n');
  fs.writeFileSync(absOut, md, 'utf8');
  console.error(`Wrote ${absOut}`);
}

fs.writeFileSync(path.resolve(root, reviewOut), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.error(`Wrote review file ${path.resolve(root, reviewOut)}`);

printOverlapSummary(report);
console.log(JSON.stringify(report, null, 2));
