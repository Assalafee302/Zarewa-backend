/**
 * Treasury account statement — cash-book layout: print document (shared print layout: A4 landscape, header repeats,
 * "Page x of y") and Excel sheet. Columns as the owner's cash book: Date (first line of the day only) | Ref |
 * Description | Cr (In) | Dr (Out) | Balance | Remark, plus "Statement close" and "Diff" when a statement closing is
 * on file for a day (optional OM columns). Dates dd/mm/yyyy, times Africa/Lagos.
 */
import { cashBookRows } from './treasuryCashBookCore.js';
import { printDate } from './reportPrintDocument.js';

/** ISO instant → "HH:MM" in Africa/Lagos (UTC+1, no daylight saving). */
export function lagosTime(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? new Date(t + 3600000).toISOString().slice(11, 16) : '';
}

const hasAccNo = (v) => {
  const s = String(v || '').trim();
  return Boolean(s) && !/^n\/?a$/i.test(s);
};

export const cashBookAccountTitle = (account) =>
  `${account.name}${account.bankName ? ` (${account.bankName})` : ''}${hasAccNo(account.accNo) ? ` · ${account.accNo}` : ''}`;

/**
 * @param {ReturnType<import('./treasuryCashBookCore.js').buildTreasuryCashBook>} book
 * @param {{ preparedBy?: string, preparedAtISO?: string, statementColumns?: boolean }} [opts]
 */
export function treasuryCashBookDocument(book, opts = {}) {
  const withStatement = opts.statementColumns ?? book.hasStatement;
  const columns = [
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'ref', label: 'Ref', kind: 'id' },
    { key: 'description', label: 'Description', kind: 'text' },
    { key: 'crNgn', label: 'Cr (In) ₦', kind: 'money' },
    { key: 'drNgn', label: 'Dr (Out) ₦', kind: 'money' },
    { key: 'balanceNgn', label: 'Balance ₦', kind: 'money' },
    ...(withStatement
      ? [
          { key: 'statementCloseNgn', label: 'Statement close ₦', kind: 'money' },
          { key: 'diffNgn', label: 'Diff', kind: 'money' },
        ]
      : []),
    { key: 'remark', label: 'Remark', kind: 'remarks' },
  ];
  const rows = cashBookRows(book).map((r) => ({
    ...r,
    statementCloseNgn: r.kind === 'closing' && r.statementCloseNgn != null ? r.statementCloseNgn : '',
    diffNgn: r.kind === 'closing' && r.diffNgn != null ? r.diffNgn : '',
    _strong: r.kind === 'total' || r.kind === 'closing' || r.kind === 'bf',
    _severity: r.kind === 'closing' && r.diffNgn ? 'exception' : undefined,
  }));
  const cut = book.endAtISO ? ` (to ${lagosTime(book.endAtISO)})` : '';
  const account = cashBookAccountTitle(book.account);
  const all = book.mode === 'all';
  const awaiting = book.awaiting || [];
  const awaitingColumns = [
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'ref', label: 'Ref', kind: 'id' },
    { key: 'customer', label: 'Customer', kind: 'text' },
    { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
    { key: 'onBank', label: 'On bank', kind: 'text' },
    { key: 'status', label: 'Status', kind: 'remarks' },
  ];
  const awaitingRows = [
    ...awaiting.map((a) => ({ ...a, onBank: a.onBank ? 'Yes' : 'No match' })),
    ...(awaiting.length ? [{ date: '', ref: '', customer: 'Total awaiting confirmation', amountNgn: book.awaitingTotalNgn, onBank: '', status: '', _strong: true }] : []),
  ];
  return {
    title: `Treasury account statement — cash-book layout (${all ? 'all movements' : 'confirmed movements'})`,
    branchName: book.branchName,
    startDate: book.startDate,
    endDate: book.endDate,
    summary: {
      rows: [
        { label: 'Account', value: account, kind: 'text' },
        { label: `Balance b/f ${printDate(book.startDate)}`, value: book.openingNgn },
        { label: 'Money in (Cr)', value: book.totalInNgn },
        { label: 'Money out (Dr)', value: book.totalOutNgn },
        { label: 'Bank charges (BC lines)', value: book.bankChargesNgn },
        { label: `Closing balance ${printDate(book.endDate)}${cut}`, value: book.closingNgn, strong: true },
        { label: `Awaiting confirmation (${awaiting.length} line${awaiting.length === 1 ? '' : 's'}, ${all ? 'included above' : 'not included'})`, value: book.awaitingTotalNgn || 0 },
        {
          label: 'Printed',
          value: all ? 'All movements, incl. receipts awaiting confirmation' : 'Confirmed movements only (balance of record)',
          kind: 'text',
        },
      ],
    },
    note:
      'Every ERP movement on this account in the period, in time order, one line each; a receipt reversal is printed on the day of the receipt it cancels. Per day: a Total line (money in and out, bank charges excluded), one bank-charges line (BC) and the closing balance. Amounts are transaction amounts; transfer and POS fees are in the BC line. Ref: RC receipt, EX payment request, EXP direct expense, RF refund, TR own-account transfer, PO supplier, IOU staff advance, RCW company-cut withdrawal, BC bank charges, ADJ statement alignment. Times are Lagos time.',
    // The table starts on page 1, under the summary.
    sections: [
      { title: account, band: account, columns, rows, emptyText: 'No movements in the period.', pageBreakBefore: false },
      {
        title: 'Awaiting confirmation',
        band: `Receipts not yet confirmed by finance — ${all ? 'included in the balance above' : 'not in the balance above'}`,
        columns: awaitingColumns,
        rows: awaitingRows,
        emptyText: 'No receipts awaiting confirmation.',
        pageBreakBefore: false,
      },
    ],
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
  };
}

/** Excel: one sheet in print order, raw numbers, dates dd/mm/yyyy, plus the ERP movement number. */
export function treasuryCashBookExcelSheets(book) {
  const rows = cashBookRows(book).map((r) => ({
    Date: r.date ? printDate(r.date) : '',
    Ref: r.ref || '',
    Description: r.description || '',
    'Cr (In) ₦': r.crNgn === '' ? '' : r.crNgn,
    'Dr (Out) ₦': r.drNgn === '' ? '' : r.drNgn,
    'Balance ₦': r.balanceNgn === '' ? '' : r.balanceNgn,
    ...(book.hasStatement ? { 'Statement close ₦': r.kind === 'closing' ? r.statementCloseNgn ?? '' : '', Diff: r.kind === 'closing' ? r.diffNgn ?? '' : '' } : {}),
    Remark: r.remark || '',
    'ERP movement': r.movementId || '',
  }));
  const awaiting = (book.awaiting || []).map((a) => ({
    Date: printDate(a.date),
    Ref: a.ref,
    Customer: a.customer,
    'Amount ₦': a.amountNgn,
    'On bank': a.onBank ? 'Yes' : 'No match',
    Status: a.status,
    'ERP movement': a.movementId,
  }));
  return [
    { name: `${book.account.bankName || book.account.name} cash book`.slice(0, 31), rows },
    { name: 'Awaiting confirmation', rows: awaiting.length ? awaiting : [{ Date: '', Ref: '', Customer: 'No receipts awaiting confirmation.' }] },
  ];
}
