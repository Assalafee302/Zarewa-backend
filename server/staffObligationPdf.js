/**
 * Printable PDFs for staff obligation disbursements and repayments.
 * @module server/staffObligationPdf
 */
import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { getStaffObligationAccountDetail } from './staffObligationOps.js';

const COMPANY = 'Zarewa Aluminium and Plastics Ltd';

function formatNgn(n) {
  return `NGN ${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 * @param {string} transactionId
 */
export function buildObligationRepaymentReceiptPdf(db, accountId, transactionId) {
  const detail = getStaffObligationAccountDetail(db, accountId);
  if (!detail) return { ok: false, error: 'Account not found.' };
  const tx = (detail.transactions || []).find((t) => t.id === transactionId);
  if (!tx) return { ok: false, error: 'Transaction not found.' };
  if (!['cash_repayment', 'payroll_deduction'].includes(String(tx.type))) {
    return { ok: false, error: 'Transaction is not a repayment.' };
  }

  const ref = tx.paymentReference || tx.sourceId || tx.id;
  const lines = [
    COMPANY,
    '',
    'STAFF REPAYMENT RECEIPT',
    '',
    `Receipt ref: ${ref}`,
    `Date: ${String(tx.effectiveAtIso || '').slice(0, 10)}`,
    '',
    `Staff: ${detail.staffDisplayName || detail.userId}`,
    `Account: ${detail.id}`,
    `Kind: ${detail.kind}`,
    detail.quotationRef ? `Quotation: ${detail.quotationRef}` : null,
    '',
    `Amount received: ${formatNgn(tx.amountNgn)}`,
    `Balance before: ${formatNgn(tx.principalBeforeNgn)}`,
    `Balance after: ${formatNgn(tx.principalAfterNgn)}`,
    '',
    `Payment type: ${tx.type === 'payroll_deduction' ? 'Payroll deduction' : 'Direct payment'}`,
    tx.note ? `Note: ${tx.note}` : null,
    '',
    'This receipt confirms repayment toward a staff obligation with Zarewa.',
    'Keep for your records.',
  ].filter(Boolean);

  const pdf = buildSimpleTextPdf([{ lines }]);
  return { ok: true, pdf, filename: `${ref}.pdf`, receiptReference: ref };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 */
export function buildObligationDisbursementVoucherPdf(db, accountId) {
  const detail = getStaffObligationAccountDetail(db, accountId);
  if (!detail) return { ok: false, error: 'Account not found.' };
  const tx = (detail.transactions || []).find((t) => t.type === 'disbursement');
  if (!tx) return { ok: false, error: 'No disbursement recorded on this account.' };

  const prRef = tx.sourceId || detail.financePaymentRequestId || '—';
  const lines = [
    COMPANY,
    '',
    'STAFF LOAN DISBURSEMENT VOUCHER',
    '',
    `Account: ${detail.id}`,
    `Payment request: ${prRef}`,
    `Disbursement date: ${String(detail.disbursedAtIso || tx.effectiveAtIso || '').slice(0, 10)}`,
    '',
    `Staff: ${detail.staffDisplayName || detail.userId}`,
    `Loan title: ${detail.title}`,
    '',
    `Amount disbursed: ${formatNgn(tx.amountNgn || detail.principalOriginalNgn)}`,
    `Monthly deduction: ${formatNgn(detail.installmentNgn)}`,
    `Term: ${detail.termMonths} month(s)`,
    '',
    'Staff signature: _________________________    Date: __________',
    '',
    'Finance / cashier: ______________________    Date: __________',
    '',
    'Repayment is collected via payroll unless settled by direct payment.',
  ];

  const pdf = buildSimpleTextPdf([{ lines }]);
  return { ok: true, pdf, filename: `disbursement-${detail.id}.pdf` };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} accountId
 */
export function buildObligationAccountStatementPdf(db, accountId) {
  const detail = getStaffObligationAccountDetail(db, accountId);
  if (!detail) return { ok: false, error: 'Account not found.' };

  const header = [
    COMPANY,
    '',
    'STAFF OBLIGATION STATEMENT',
    '',
    `Account: ${detail.id}`,
    `Staff: ${detail.staffDisplayName || detail.userId}`,
    `Kind: ${detail.kind}`,
    `Status: ${detail.status}`,
    detail.quotationRef ? `Quotation: ${detail.quotationRef}` : null,
    '',
    `Original: ${formatNgn(detail.principalOriginalNgn)}`,
    `Outstanding: ${formatNgn(detail.principalOutstandingNgn)}`,
    `Installment: ${formatNgn(detail.installmentNgn)}/month`,
    '',
    '— Transactions —',
  ].filter(Boolean);

  const txLines = (detail.transactions || []).slice(0, 40).flatMap((t) => [
    `${String(t.effectiveAtIso || '').slice(0, 10)}  ${t.type}  ${formatNgn(t.amountNgn)}  bal ${formatNgn(t.principalAfterNgn)}`,
    t.paymentReference ? `  ref: ${t.paymentReference}` : null,
  ].filter(Boolean));

  const pdf = buildSimpleTextPdf([{ lines: [...header, ...txLines, '', `Generated: ${new Date().toISOString().slice(0, 10)}`] }]);
  return { ok: true, pdf, filename: `statement-${detail.id}.pdf` };
}
