/**
 * Treasury account statement — cash-book layout: print document (shared print layout: A4 landscape, header repeats,
 * "Page x of y") and Excel sheet. Columns as the owner's cash book: Date (first line of the day only) | Ref |
 * Description | Cr (In) | Dr (Out) | Balance | Remark, plus "Statement close" and "Diff" when a statement closing is
 * on file for a day (optional OM columns).
 */
import { cashBookRows } from './treasuryCashBookCore.js';

const title = (book) =>
  `Treasury account statement — ${book.account.name}${book.account.bankName ? ` (${book.account.bankName})` : ''}${book.account.accNo ? ` · ${book.account.accNo}` : ''}`;

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
  const cut = book.endAtISO ? ` (to ${book.endAtISO.slice(11, 16)} UTC on ${book.endDate})` : '';
  return {
    title: 'Treasury account statement — cash-book layout',
    branchName: book.branchName,
    startDate: book.startDate,
    endDate: book.endDate,
    summary: {
      rows: [
        { label: 'Account', value: title(book).replace('Treasury account statement — ', ''), kind: 'text' },
        { label: `Balance b/f ${book.startDate}`, value: book.openingNgn },
        { label: 'Money in (Cr)', value: book.totalInNgn },
        { label: 'Money out (Dr)', value: book.totalOutNgn },
        { label: 'Bank charges (BC lines)', value: book.bankChargesNgn },
        { label: `Closing balance ${book.endDate}${cut}`, value: book.closingNgn, strong: true },
      ],
    },
    note:
      'Every ERP movement on this account in the period, in time order, one line each. Per day: a Total line (money in and out, bank charges excluded), one bank-charges line (BC) and the closing balance. Amounts are transaction amounts; transfer and POS fees are in the BC line. Ref: RC receipt, EX payment request, EXP direct expense, RF refund, TR own-account transfer, PO supplier, IOU staff advance, RCW company-cut withdrawal, BC bank charges, ADJ statement alignment.',
    sections: [{ title: title(book), band: title(book), columns, rows, emptyText: 'No movements in the period.' }],
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
  };
}

/** Excel: one sheet in print order, raw numbers and ISO dates. */
export function treasuryCashBookExcelSheets(book) {
  const rows = cashBookRows(book).map((r) => ({
    Date: r.date || '',
    Ref: r.ref || '',
    Description: r.description || '',
    'Cr (In) ₦': r.crNgn === '' ? '' : r.crNgn,
    'Dr (Out) ₦': r.drNgn === '' ? '' : r.drNgn,
    'Balance ₦': r.balanceNgn === '' ? '' : r.balanceNgn,
    ...(book.hasStatement ? { 'Statement close ₦': r.kind === 'closing' ? r.statementCloseNgn ?? '' : '', Diff: r.kind === 'closing' ? r.diffNgn ?? '' : '' } : {}),
    Remark: r.remark || '',
    'ERP movement': r.movementId || '',
  }));
  return [{ name: `${book.account.bankName || book.account.name} cash book`.slice(0, 31), rows }];
}
