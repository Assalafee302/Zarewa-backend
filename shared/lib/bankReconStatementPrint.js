/**
 * Print / Excel layout for the bank reconciliation statement (see `bankReconStatementCore.js`).
 * Feeds `renderReportDocument` (one layout for all reports).
 */
import { printDate } from './reportPrintDocument.js';

export const BANK_RECON_TITLE = 'Bank reconciliation statement';

export const BANK_RECON_NOTE =
  'ERP side: the treasury balance of each account at the start of the period, every treasury movement posted in the ' +
  'period (by posting date), and the balance at the end. Bank side: the statement balance typed in by the user ' +
  '(the ERP does not store it) plus every imported bank-statement line dated in the period. A bank line and an ERP ' +
  'movement are "linked" when the bank-recon match names the movement (TM id). Every difference between the two ' +
  'movement totals is listed below as an unlinked line, a timing item or a fee/amount variance; what is left is ' +
  '"unexplained" and should be ₦0.';

export function accountTitle(account) {
  const bank = account.bankName ? ` (${account.bankName}${account.accNo ? ` ${account.accNo}` : ''})` : '';
  return `${account.name}${bank} · account ${account.id}`;
}

function statementRows(p) {
  const rows = [{ item: 'ERP opening balance', ids: '', amountNgn: p.erp.openingNgn }];
  for (const b of p.erp.buckets) {
    if (!b.amountNgn && !b.movementIds.length) continue;
    rows.push({ item: b.label, ids: `${b.movementIds.length} movement(s)`, amountNgn: b.amountNgn });
  }
  rows.push({ item: '= ERP closing balance', ids: '', amountNgn: p.erp.closingNgn, _strong: true });
  if (p.isCash) {
    rows.push({ item: 'Bank side', ids: 'Cash account — no bank statement. Count the cash.', amountNgn: '' });
    return rows;
  }
  if (!p.hasBankStatement) {
    rows.push({ item: 'Bank side', ids: 'No bank-statement lines imported for this account', amountNgn: '', _severity: 'exception' });
    return rows;
  }
  const noBal = 'Not entered — add the statement balances for the month';
  const sb = p.statementBalance;
  const enteredBy = sb ? `Entered by ${sb.enteredByName || '—'} on ${printDate(sb.enteredAtISO)}` : '';
  rows.push(
    {
      item: 'Bank opening balance (statement)',
      ids: p.bank.openingNgn == null ? noBal : enteredBy,
      amountNgn: p.bank.openingNgn ?? '',
      _severity: p.bank.openingNgn == null ? 'review' : '',
    },
    {
      item: '± Bank lines in the ERP (BKR) dated in the period',
      ids: `${p.bank.lineCount} BKR row(s) · statement lines: ${p.bank.statementLinesLinked} linked, ${p.bank.statementLinesUnlinked} not linked`,
      amountNgn: p.bank.linesNetNgn,
    }
  );
  if (p.bank.statementGapNgn != null) {
    rows.push({
      item: '± Statement lines not in the ERP (not imported / not linked)',
      ids: p.bank.statementGapNgn ? 'Statement closing − opening − BKR lines' : 'None',
      amountNgn: p.bank.statementGapNgn,
      _severity: p.bank.statementGapNgn ? 'review' : '',
    });
  }
  rows.push(
    {
      item: '= Bank closing balance',
      ids: p.bank.closingSource === 'statement' ? 'From the statement' : p.bank.closingSource || noBal,
      amountNgn: p.bank.closingNgn ?? '',
      _strong: true,
    },
    {
      item: 'Difference (ERP closing − bank closing)',
      ids: p.differenceNgn == null ? 'Needs the statement balances' : '',
      amountNgn: p.differenceNgn ?? '',
      _severity: p.differenceNgn ? 'exception' : '',
      _strong: true,
    }
  );
  if (p.openingDifferenceNgn != null) {
    rows.push({ item: '   of which: difference already at the opening', ids: '', amountNgn: p.openingDifferenceNgn });
  }
  if (p.bank.statementGapNgn) {
    rows.push({ item: '   of which: statement lines not in the ERP (less)', ids: '', amountNgn: -p.bank.statementGapNgn });
  }
  const r = p.reconciling;
  rows.push(
    { item: '   of which: movements, ERP net − BKR lines net', ids: '', amountNgn: p.movementDifferenceNgn, _strong: true },
    {
      item: '   ERP lines with no bank link',
      ids: `${p.erpUnlinked.length} line(s)${p.erpCancelledPairs?.length ? ` + ${p.erpCancelledPairs.length} posted-and-reversed (net ₦0)` : ''}`,
      amountNgn: r.erpUnlinkedNgn,
    },
    { item: '   ERP lines on the bank in another period', ids: `${p.erpTiming.length} line(s)`, amountNgn: r.erpTimingNgn },
    { item: '   Less: bank lines with no ERP link', ids: `${p.bankUnlinked.length} line(s)`, amountNgn: -r.bankUnlinkedNgn },
    {
      item: '   Less: bank amount ≠ linked ERP amount (fees, part links)',
      ids: `${p.matchedVariances.length} line(s)`,
      amountNgn: -r.matchedVarianceNgn,
    },
    { item: 'Unexplained', ids: '', amountNgn: r.unexplainedNgn, _severity: r.unexplainedNgn ? 'exception' : '', _strong: true }
  );
  return rows;
}

const STATEMENT_COLUMNS = [
  { key: 'item', label: 'Item' },
  { key: 'ids', label: 'Detail' },
  { key: 'amountNgn', label: '₦', kind: 'money' },
];

const ERP_COLUMNS = [
  { key: 'dateISO', label: 'Posted', kind: 'date' },
  { key: 'id', label: 'Treasury movement', kind: 'id' },
  { key: 'type', label: 'Type' },
  { key: 'sourceId', label: 'Source record', kind: 'id' },
  { key: 'counterparty', label: 'Counterparty' },
  { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
  { key: 'suggestedMatch', label: 'Suggested bank line', kind: 'id' },
  { key: 'remarks', label: 'Remarks', kind: 'remarks' },
];

const BANK_COLUMNS = [
  { key: 'dateISO', label: 'Bank date', kind: 'date' },
  { key: 'id', label: 'Bank line', kind: 'id' },
  { key: 'status', label: 'Status' },
  { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
  { key: 'suggestedMatch', label: 'Suggested ERP movement', kind: 'id' },
  { key: 'reference', label: 'Recon note' },
  { key: 'description', label: 'Remarks (bank narration)', kind: 'remarks' },
];

const VARIANCE_COLUMNS = [
  { key: 'dateISO', label: 'Bank date', kind: 'date' },
  { key: 'bankLineId', label: 'Bank line', kind: 'id' },
  { key: 'movementIds', label: 'Linked movements', kind: 'id' },
  { key: 'bankAmountNgn', label: 'Bank ₦', kind: 'money' },
  { key: 'erpAmountNgn', label: 'ERP ₦', kind: 'money' },
  { key: 'amountNgn', label: 'Difference ₦', kind: 'money' },
  { key: 'note', label: 'Remarks', kind: 'remarks' },
];

const TIMING_COLUMNS = [
  { key: 'dateISO', label: 'Posted', kind: 'date' },
  { key: 'id', label: 'Treasury movement', kind: 'id' },
  { key: 'type', label: 'Type' },
  { key: 'bankLineId', label: 'Bank line', kind: 'id' },
  { key: 'bankDateISO', label: 'Bank date', kind: 'date' },
  { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
  { key: 'counterparty', label: 'Remarks', kind: 'remarks' },
];

const erpRow = (t) => ({
  ...t,
  remarks: [t.note, t.suggestedMatchNote, t.reference].filter(Boolean).join(' · '),
  _severity: t.severity === 'small' ? '' : t.severity,
  _small: t.severity === 'small',
});
const bankRow = (b) => ({
  ...b,
  _severity: b.severity === 'small' ? '' : b.severity,
  _small: b.severity === 'small',
});
const varianceRow = (v) => ({
  ...v,
  movementIds: v.movementIds.join(' + '),
  _small: Math.abs(v.amountNgn) < 50_000 && !/not found|another account/.test(v.note),
  _severity: /not found|another account/.test(v.note) ? 'exception' : '',
});

/**
 * @param {ReturnType<import('./bankReconStatementCore.js').buildBankReconStatement> & {branch?: {name: string}}} report
 * @param {{ preparedBy?: string, preparedAtISO?: string, showSmallItems?: boolean }} [opts]
 */
export function bankReconStatementDocument(report, opts = {}) {
  const pages = report.pages;
  const exceptionRows = [];
  for (const p of pages) {
    for (const t of p.erpUnlinked) {
      if (t.severity === 'small') continue;
      exceptionRows.push({
        account: p.account.name,
        side: 'ERP, not on bank',
        dateISO: t.dateISO,
        id: t.id,
        source: t.sourceId,
        amountNgn: t.amountNgn,
        suggestedMatch: t.suggestedMatch,
        remarks: [t.type, t.counterparty, t.note].filter(Boolean).join(' · '),
        _severity: t.severity,
      });
    }
    for (const b of p.bankUnlinked) {
      if (b.severity === 'small') continue;
      exceptionRows.push({
        account: p.account.name,
        side: 'Bank, not in ERP',
        dateISO: b.dateISO,
        id: b.id,
        source: b.reference,
        amountNgn: b.amountNgn,
        suggestedMatch: b.suggestedMatch,
        remarks: b.description,
        _severity: b.severity,
      });
    }
    for (const x of p.brokenLinks) {
      exceptionRows.push({
        account: p.account.name,
        side: 'Link to a missing movement',
        dateISO: x.dateISO,
        id: x.bankLineId,
        source: x.treasuryMovementId,
        amountNgn: x.amountNgn,
        suggestedMatch: '',
        remarks: 'The bank-recon match names a treasury movement that does not exist',
        _severity: 'exception',
      });
    }
    if (p.reconciling.unexplainedNgn) {
      exceptionRows.push({
        account: p.account.name,
        side: 'Unexplained difference',
        dateISO: '',
        id: '',
        source: '',
        amountNgn: p.reconciling.unexplainedNgn,
        suggestedMatch: '',
        remarks: '',
        _severity: 'exception',
      });
    }
  }
  exceptionRows.sort(
    (a, b) =>
      String(a.dateISO).localeCompare(String(b.dateISO)) || a.account.localeCompare(b.account) || String(a.id).localeCompare(String(b.id))
  );
  const nExc = exceptionRows.filter((r) => r._severity === 'exception').length;
  const nRev = exceptionRows.filter((r) => r._severity === 'review').length;

  const summary = {
    rows: [
      ...pages.flatMap((p) => [
        { label: `${accountTitle(p.account)} — ERP closing`, value: p.erp.closingNgn, strong: true },
        ...(p.hasBankStatement
          ? [
              { label: '      Bank closing', value: p.bank.closingNgn ?? 'not entered', kind: p.bank.closingNgn == null ? 'text' : undefined },
              {
                label: '      Difference',
                value: p.differenceNgn ?? 'needs bank opening',
                kind: p.differenceNgn == null ? 'text' : undefined,
                severity: p.differenceNgn ? 'exception' : '',
              },
              {
                label: '      Unexplained (movements)',
                value: p.reconciling.unexplainedNgn,
                severity: p.reconciling.unexplainedNgn ? 'exception' : '',
              },
            ]
          : [{ label: p.isCash ? '      Cash account — no bank statement' : '      No bank-statement lines imported', value: '', kind: 'text', severity: p.isCash ? '' : 'exception' }]),
      ]),
      { label: 'Exceptions (red)', value: String(nExc), kind: 'text', severity: nExc ? 'exception' : '' },
      { label: 'Under review (amber)', value: String(nRev), kind: 'text', severity: nRev ? 'review' : '' },
    ],
  };

  const sections = pages.flatMap((p) => {
    const band = `${accountTitle(p.account)} · ${printDate(report.startDate)} – ${printDate(report.endDate)}`;
    const out = [
      {
        title: `Statement — ${accountTitle(p.account)}`,
        band,
        columns: STATEMENT_COLUMNS,
        rows: statementRows(p).map((r) => ({ ...r, _severity: r._severity || '' })),
        pageBreakBefore: true,
      },
    ];
    if (!p.hasBankStatement) return out;
    out.push(
      {
        title: 'Bank lines with no ERP link',
        band,
        columns: BANK_COLUMNS,
        rows: p.bankUnlinked.map(bankRow),
        emptyText: 'Every bank line in the period is linked to an ERP movement.',
      },
      {
        title: 'ERP movements with no bank link',
        band,
        columns: ERP_COLUMNS,
        rows: p.erpUnlinked.map(erpRow),
        emptyText: 'Every ERP movement in the period is linked to a bank line.',
      },
      {
        title: 'ERP movements posted and reversed in the period (net ₦0, no bank line expected)',
        band,
        columns: ERP_COLUMNS,
        rows: (p.erpCancelledPairs || []).map((t) => ({ ...erpRow(t), _severity: '' , _small: false })),
        emptyText: 'None.',
      },
      {
        title: 'ERP movements on the bank in another period (timing)',
        band,
        columns: TIMING_COLUMNS,
        rows: p.erpTiming,
        emptyText: 'None.',
      },
      {
        title: 'Linked lines where the bank amount differs from the ERP amount',
        band,
        columns: VARIANCE_COLUMNS,
        rows: p.matchedVariances.map(varianceRow),
        emptyText: 'None.',
      }
    );
    return out;
  });

  return {
    title: BANK_RECON_TITLE,
    branchName: report.branch?.name || '',
    startDate: report.startDate,
    endDate: report.endDate,
    summary,
    note: BANK_RECON_NOTE,
    exceptionSections: [
      {
        title: 'Exceptions and items under review (all accounts)',
        columns: [
          { key: 'dateISO', label: 'Date', kind: 'date' },
          { key: 'account', label: 'Account' },
          { key: 'side', label: 'Item' },
          { key: 'id', label: 'Id', kind: 'id' },
          { key: 'source', label: 'Source / recon note', kind: 'id' },
          { key: 'amountNgn', label: 'Amount ₦', kind: 'money' },
          { key: 'suggestedMatch', label: 'Suggested match', kind: 'id' },
          { key: 'remarks', label: 'Remarks', kind: 'remarks' },
        ],
        rows: exceptionRows,
        emptyText: 'No exceptions.',
      },
    ],
    sections,
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
    showSmallItems: Boolean(opts.showSmallItems),
  };
}

/** Excel sheets: same columns as print, raw numbers and ISO dates, every row (small items included). */
export function bankReconStatementExcelSheets(report) {
  const statement = [];
  const bankUnlinked = [];
  const erpUnlinked = [];
  const timing = [];
  const variances = [];
  for (const p of report.pages) {
    const account = accountTitle(p.account);
    for (const r of statementRows(p)) statement.push({ account, item: r.item.trim(), detail: r.ids, amountNgn: r.amountNgn });
    for (const b of p.bankUnlinked) {
      bankUnlinked.push({
        account, bankDateISO: b.dateISO, bankLineId: b.id, status: b.status, amountNgn: b.amountNgn,
        suggestedMovementId: b.suggestedMatch, reconNote: b.reference, narration: b.description, severity: b.severity,
      });
    }
    for (const t of p.erpUnlinked) {
      erpUnlinked.push({
        account, postedDateISO: t.dateISO, treasuryMovementId: t.id, type: t.type, sourceKind: t.sourceKind, sourceId: t.sourceId,
        counterparty: t.counterparty, amountNgn: t.amountNgn, suggestedBankLineId: t.suggestedMatch, note: t.note, severity: t.severity,
      });
    }
    for (const t of p.erpTiming) {
      timing.push({ account, postedDateISO: t.dateISO, treasuryMovementId: t.id, type: t.type, bankLineId: t.bankLineId, bankDateISO: t.bankDateISO, amountNgn: t.amountNgn });
    }
    for (const v of p.matchedVariances) {
      variances.push({
        account, bankDateISO: v.dateISO, bankLineId: v.bankLineId, movementIds: v.movementIds.join(' + '),
        bankAmountNgn: v.bankAmountNgn, erpAmountNgn: v.erpAmountNgn, differenceNgn: v.amountNgn, note: v.note,
      });
    }
  }
  return [
    { name: 'Statement', rows: statement },
    { name: 'Bank_not_in_ERP', rows: bankUnlinked },
    { name: 'ERP_not_on_bank', rows: erpUnlinked },
    { name: 'Timing', rows: timing },
    { name: 'Amount_differences', rows: variances },
  ];
}
