/**
 * Usage:
 *   node scripts/test-entered-data-refund-preview.mjs
 *   node scripts/test-entered-data-refund-preview.mjs --file "zarewa-entered-data (1).xlsx"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEnteredDataRefundPreviewChecks } from '../server/enteredDataRefundPreviewHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : fallback;
}

const filePath = path.resolve(root, argValue('--file', 'zarewa-entered-data (1).xlsx'));
const report = runEnteredDataRefundPreviewChecks(filePath);

const {
  cancelledResults: _c,
  bothResults: _b,
  ...publicReport
} = report;

console.log(JSON.stringify(publicReport, null, 2));

if (report.cancelledLogicFailures.length) {
  console.error(
    `\nFAIL: ${report.cancelledLogicFailures.length} cancelled-quote preview(s) still stack or exceed cap.`
  );
  process.exit(1);
}

console.error(
  `\nPASS: ${report.cancelledQuoteCount} cancelled quotes — no Overpayment+Order cancellation stack; totals within cash hard cap.`
);
