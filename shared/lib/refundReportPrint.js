/**
 * Print / Excel layout for the refund report v2 (see `refundReportCore.js`). Feeds `renderReportDocument`.
 */

export const REFUND_REPORT_TITLE = 'Refund report';

export const REFUND_REPORT_NOTE =
  'Every refund payout posted in treasury in the period (one line per payout, by payment date, then account), with ' +
  'who asked for it, who approved it, who it was paid to and from which account. A payout is red when the payee is ' +
  'not the customer, is the approver, matches a staff/user name, or receives refunds for 3+ different customers; amber when no payee is recorded or a bank ' +
  'payout has no bank-statement line. Refunds approved but not yet paid are listed separately and are not in the total.';

const PAYOUT_COLUMNS = [
  { key: 'paidDateISO', label: 'Paid', kind: 'date' },
  { key: 'accountDebited', label: 'Account debited' },
  { key: 'treasuryMovementId', label: 'Treasury line', kind: 'id' },
  { key: 'bankLineId', label: 'Bank line', kind: 'id' },
  { key: 'refundID', label: 'Refund', kind: 'id' },
  { key: 'quotationRef', label: 'Quotation', kind: 'id' },
  { key: 'customerName', label: 'Customer' },
  { key: 'payeeName', label: 'Payee' },
  { key: 'payeeBank', label: 'Payee bank', secondLine: true },
  { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
  { key: 'requestedBy', label: 'Requested by', secondLine: true },
  { key: 'approvedBy', label: 'Approved by' },
  { key: 'paidBy', label: 'Paid by', secondLine: true },
  { key: 'remarks', label: 'Flags / remarks', kind: 'remarks' },
];

const payoutRow = (r) => ({
  ...r,
  remarks: [...r.flags, ...r.review, r.reason].filter(Boolean).join(' · '),
  _severity: r.severity,
});

/**
 * @param {ReturnType<import('./refundReportCore.js').buildRefundReport>} report
 * @param {{ branchName?: string, preparedBy?: string, preparedAtISO?: string }} [opts]
 */
export function refundReportDocument(report, opts = {}) {
  const t = report.totals;
  const c = report.counts;
  const flagged = report.rows.filter((r) => r.severity);
  return {
    title: REFUND_REPORT_TITLE,
    branchName: opts.branchName || '',
    startDate: report.startDate,
    endDate: report.endDate,
    summary: {
      rows: [
        { label: `Refunds paid in period (${t.payoutCount} payout lines)`, value: t.paidNgn, strong: true },
        { label: '      Customer refunds', value: t.refundsPaidNgn },
        { label: '      Company cut withdrawn', value: t.companyCutNgn },
        ...t.byAccount.map((a) => ({ label: `      From ${a.account}`, value: a.amountNgn })),
        { label: 'Approved / requested in period, not yet paid (not in the total)', value: t.notPaidNgn },
        { label: 'Payee is not the customer', value: String(c.payeeNotCustomer), kind: 'text', severity: c.payeeNotCustomer ? 'exception' : '' },
        { label: 'Payee is the approver', value: String(c.payeeIsApprover), kind: 'text', severity: c.payeeIsApprover ? 'exception' : '' },
        { label: 'Payee matches a staff / user name', value: String(c.payeeIsStaff), kind: 'text', severity: c.payeeIsStaff ? 'exception' : '' },
        { label: 'Same payee for 3+ different customers', value: String(c.payeeManyCustomers), kind: 'text', severity: c.payeeManyCustomers ? 'exception' : '' },
        { label: 'Marked paid, no treasury payout line', value: String(report.paidNoTreasury.length), kind: 'text', severity: report.paidNoTreasury.length ? 'exception' : '' },
        { label: 'No payee recorded', value: String(c.noPayee), kind: 'text', severity: c.noPayee ? 'review' : '' },
        { label: 'Bank payout with no bank-statement line', value: String(c.noBankLink), kind: 'text', severity: c.noBankLink ? 'review' : '' },
      ],
    },
    note: REFUND_REPORT_NOTE,
    exceptionSections: [
      {
        title: 'Exceptions and items under review',
        columns: PAYOUT_COLUMNS,
        rows: [
          ...flagged.map(payoutRow),
          ...report.paidNoTreasury.map((r) => ({ ...r, remarks: r.flags.join(' · '), _severity: 'exception' })),
        ],
        emptyText: 'No exceptions.',
      },
    ],
    sections: [
      {
        title: 'Refund payouts in the period (by payment date, then account)',
        columns: PAYOUT_COLUMNS,
        rows: report.rows.map(payoutRow),
        totalRows: [{ paidDateISO: '', accountDebited: 'Total', amountNgn: t.paidNgn }],
        emptyText: 'No refund payouts in the period.',
      },
      {
        title: 'Requested in the period, not yet paid (not in the total)',
        columns: [
          { key: 'requestedAtISO', label: 'Requested', kind: 'date' },
          { key: 'refundID', label: 'Refund', kind: 'id' },
          { key: 'quotationRef', label: 'Quotation', kind: 'id' },
          { key: 'customerName', label: 'Customer' },
          { key: 'status', label: 'Status' },
          { key: 'approvedNgn', label: 'Approved ₦', kind: 'money' },
          { key: 'paidNgn', label: 'Paid ₦', kind: 'money' },
          { key: 'creditAppliedNgn', label: 'Credit applied ₦', kind: 'money' },
          { key: 'outstandingNgn', label: 'Outstanding ₦', kind: 'money' },
          { key: 'requestedBy', label: 'Requested by' },
          { key: 'approvedBy', label: 'Approved by' },
        ],
        rows: report.notPaid,
        totalRows: [{ requestedAtISO: '', refundID: 'Total', outstandingNgn: t.notPaidNgn }],
        emptyText: 'None.',
      },
    ],
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
  };
}

/** Excel: same columns as print, raw numbers and ISO dates. */
export function refundReportExcelSheets(report) {
  return [
    {
      name: 'Refund_payouts',
      rows: report.rows.map((r) => ({
        paidDateISO: r.paidDateISO, accountDebited: r.accountDebited, treasuryMovementId: r.treasuryMovementId, bankLineId: r.bankLineId,
        refundID: r.refundID, quotationRef: r.quotationRef, customerID: r.customerID, customer: r.customerName, payee: r.payeeName,
        payeeBank: r.payeeBank, amountNgn: r.amountNgn, requestedBy: r.requestedBy, requestedAtISO: r.requestedAtISO,
        approvedBy: r.approvedBy, approvedAtISO: r.approvedAtISO, paidBy: r.paidBy, type: r.type, reason: r.reason,
        flags: r.flags.join(' · '), review: r.review.join(' · '), severity: r.severity,
      })),
    },
    { name: 'Paid_no_treasury', rows: report.paidNoTreasury.map((r) => ({ ...r, flags: r.flags.join(' · ') })) },
    { name: 'Not_yet_paid', rows: report.notPaid },
    { name: 'By_account', rows: report.totals.byAccount },
  ];
}
