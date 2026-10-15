/**
 * Print / Excel layout for the receipts register (see `receiptsRegisterCore.js`). Feeds `renderReportDocument`.
 * Columns (owner, round 2): Date | Payer | Customer | Quotation | Receipt | Amount received | Bank | Confirmed |
 * Statement | Remark — in three sections, then "Settled by credit, no cash".
 */
import { BANK_RECON_SMALL_ITEM_NGN } from './bankReconStatementCore.js';
import { receiptsVersusAccrualBridge } from './receiptsRegisterCore.js';

export const RECEIPTS_REGISTER_TITLE = 'Receipts register';

export const RECEIPTS_REGISTER_NOTE =
  'Cash received: one line per bank leg of every customer receipt, dated by the day the money reached the account ' +
  '(treasury posting). Lines are grouped by what happened to the quotation by period end: produced in the period ' +
  '(this month’s sales), not yet produced (advances), or produced earlier (paying off a debt). The three sections ' +
  'add up to cash received and agree with the accrual statement’s cash line. Receipts settled from the refund fund ' +
  'or an overpayment are not cash and are listed at the end. Confirmed = the cashier confirmed the credit alert; ' +
  'Statement = the month-end bank statement line.';

export const REGISTER_COLUMNS = [
  { key: 'dateISO', label: 'Date', kind: 'date' },
  { key: 'payer', label: 'Payer (name on alert/receipt)' },
  { key: 'customerName', label: 'Customer' },
  { key: 'quotationRef', label: 'Quotation', kind: 'id' },
  { key: 'receiptId', label: 'Receipt', kind: 'id' },
  { key: 'amountNgn', label: 'Amount received ₦', kind: 'money' },
  { key: 'bank', label: 'Bank' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'statement', label: 'Statement', kind: 'id' },
  { key: 'remark', label: 'Remark', kind: 'remarks' },
];

const lineRow = (l) => ({ ...l, _severity: l.severity });
const blank = Object.fromEntries(REGISTER_COLUMNS.map((c) => [c.key, '']));

/**
 * @param {ReturnType<import('./receiptsRegisterCore.js').buildReceiptsRegister>} register
 * @param {{ branchName?: string, preparedBy?: string, preparedAtISO?: string, accrual?: object }} [opts]
 *   `accrual` = `buildSalesAccrual` output for the same period (the bridge check)
 */
export function receiptsRegisterDocument(register, opts = {}) {
  const c = register.counts;
  const tie = opts.accrual ? receiptsVersusAccrualBridge(register, opts.accrual) : null;
  const sectionTables = register.sections.map((s) => ({
    title: `${s.number}. ${s.label.toUpperCase()}`,
    band: `${s.number}. ${s.label}`,
    columns: REGISTER_COLUMNS,
    rows: s.lines.map(lineRow),
    totalRows: [
      ...s.byBank.map((b) => ({ ...blank, payer: `Subtotal ${b.bank}`, customerName: `${b.lineCount} line(s)`, amountNgn: b.amountNgn, bank: b.bank })),
      { ...blank, payer: `Section ${s.number} total`, amountNgn: s.totalNgn },
    ],
    emptyText: 'None.',
  }));
  const grand = {
    title: 'Grand total = sections 1 + 2 + 3 = cash received in period, by bank',
    columns: [
      { key: 'bank', label: 'Bank' },
      ...register.sections.map((s) => ({ key: `s${s.number}`, label: `${s.number}. ${s.label} ₦`, kind: 'money' })),
      { key: 'total', label: 'Cash received ₦', kind: 'money' },
    ],
    rows: register.totalsByBank.map((b) => ({
      bank: b.bank,
      ...Object.fromEntries(register.sections.map((s) => [`s${s.number}`, s.byBank.find((x) => x.bank === b.bank)?.amountNgn ?? 0])),
      total: b.amountNgn,
    })),
    totalRows: [
      {
        bank: 'Total',
        ...Object.fromEntries(register.sections.map((s) => [`s${s.number}`, s.totalNgn])),
        total: register.grandTotalNgn,
      },
    ],
  };
  const creditTable = {
    title: 'Settled by credit, no cash (refund fund / overpayment applied — not counted in cash)',
    columns: [
      { key: 'dateISO', label: 'Date', kind: 'date' },
      { key: 'customerName', label: 'Customer' },
      { key: 'quotationRef', label: 'Quotation', kind: 'id' },
      { key: 'receiptId', label: 'Receipt (₦0)', kind: 'id' },
      { key: 'creditEntries', label: 'Credit entry', kind: 'id' },
      { key: 'creditAppliedNgn', label: 'Credit applied ₦', kind: 'money' },
      { key: 'method', label: 'Remark', kind: 'remarks' },
    ],
    rows: register.creditSettled.rows.map((r) => ({ ...r, creditEntries: r.creditEntryIds.join(', ') })),
    totalRows: [{ dateISO: '', customerName: 'Total (not in cash)', creditAppliedNgn: register.creditSettled.amountNgn }],
    emptyText: 'None.',
  };

  const exceptionRows = [
    ...register.lines.filter((l) => l.severity).map((l) => ({
      ...lineRow(l),
      remark: [...l.exceptions, ...l.review].join(' · '),
      _small: l.severity === 'review' && Math.abs(l.amountNgn) < BANK_RECON_SMALL_ITEM_NGN,
    })),
    ...register.noTreasury.map((r) => ({ ...blank, ...r, remark: r.exceptions.join(' · '), _severity: 'exception' })),
  ].sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO)) || String(a.bank).localeCompare(String(b.bank)));

  const summaryRows = [
    ...register.totalsByBank.map((b) => ({ label: `Receipts — ${b.bank} (${b.lineCount} lines)`, value: b.amountNgn })),
    { label: 'Cash received in period (sections 1 + 2 + 3)', value: register.grandTotalNgn, strong: true },
    ...register.sections.map((s) => ({ label: `      ${s.number}. ${s.label}`, value: s.totalNgn })),
  ];
  if (tie) {
    summaryRows.push(
      { label: 'Accrual statement bridge: cash received in period', value: tie.bridgeCashReceivedNgn },
      tie.comparable
        ? { label: 'Difference (must be ₦0)', value: tie.differenceNgn, severity: tie.differenceNgn ? 'exception' : '', strong: true }
        : { label: 'Difference', value: 'not compared — filters applied', kind: 'text', severity: 'review' }
    );
  }
  summaryRows.push(
    { label: 'Settled by credit, no cash (not in cash)', value: register.creditSettled.amountNgn },
    { label: 'Receipts not confirmed (alert)', value: String(c.unconfirmed), kind: 'text', severity: c.unconfirmed ? 'review' : '' },
    { label: '      of which more than 24 hours old', value: String(c.unconfirmedOver24h), kind: 'text', severity: c.unconfirmedOver24h ? 'exception' : '' },
    {
      label: 'Without a bank-statement match',
      value: c.withoutStatement == null ? `statement loaded to ${register.statementToISO || '—'} (month-end only)` : String(c.withoutStatement),
      kind: 'text',
      severity: c.withoutStatement ? 'review' : '',
    },
    { label: 'Payer is not the customer', value: String(c.payerNotCustomer), kind: 'text', severity: c.payerNotCustomer ? 'review' : '' },
    { label: 'Receipts with no treasury line', value: String(c.noTreasury), kind: 'text', severity: c.noTreasury ? 'exception' : '' }
  );

  return {
    title: RECEIPTS_REGISTER_TITLE,
    branchName: opts.branchName || '',
    startDate: register.startDate,
    endDate: register.endDate,
    summary: { rows: summaryRows },
    note: RECEIPTS_REGISTER_NOTE,
    exceptionSections: [
      { title: 'Exceptions and items under review', columns: REGISTER_COLUMNS, rows: exceptionRows, emptyText: 'No exceptions.' },
    ],
    sections: [...sectionTables, { ...grand, pageBreakBefore: false }, { ...creditTable, pageBreakBefore: false }].map((s, i) => ({
      ...s,
      pageBreakBefore: i === 0,
    })),
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
  };
}

/** Excel: the same columns (plus section and ids for drill-down), raw numbers, every line. */
export function receiptsRegisterExcelSheets(register, opts = {}) {
  const tie = opts.accrual ? receiptsVersusAccrualBridge(register, opts.accrual) : null;
  return [
    {
      name: 'Receipts',
      rows: register.sections.flatMap((s) =>
        s.lines.map((l) => ({
          section: `${s.number}. ${s.label}`,
          dateISO: l.dateISO,
          payer: l.payer,
          payerSource: l.payerSource,
          customer: l.customerName,
          quotationRef: l.quotationRef,
          receiptId: l.receiptId,
          amountReceivedNgn: l.amountNgn,
          bank: l.bank,
          confirmed: l.confirmed,
          statement: l.bankLineId,
          remark: l.remark,
          treasuryMovementId: l.treasuryMovementId,
          ledgerEntryId: l.ledgerEntryId,
          receiptDateISO: l.receiptDateISO,
          exceptions: [...l.exceptions, ...l.review].join(' · '),
        }))
      ),
    },
    {
      name: 'By_bank_and_section',
      rows: register.totalsByBank.map((b) => ({
        bank: b.bank,
        ...Object.fromEntries(register.sections.map((s) => [`${s.number}. ${s.label}`, s.byBank.find((x) => x.bank === b.bank)?.amountNgn ?? 0])),
        cashReceivedNgn: b.amountNgn,
      })),
    },
    { name: 'Daily_by_bank', rows: register.days.flatMap((d) => d.byBank.map((b) => ({ dateISO: d.dateISO, ...b }))) },
    {
      name: 'Settled_by_credit',
      rows: register.creditSettled.rows.map((r) => ({
        dateISO: r.dateISO, customer: r.customerName, quotationRef: r.quotationRef, receiptId: r.receiptId, ledgerEntryId: r.ledgerEntryId,
        creditEntryIds: r.creditEntryIds.join(', '), creditAppliedNgn: r.creditAppliedNgn, method: r.method,
      })),
    },
    { name: 'No_treasury_line', rows: register.noTreasury.map((r) => ({ ...r, exceptions: r.exceptions.join(' · ') })) },
    ...(tie ? [{ name: 'Accrual_bridge_check', rows: [...tie.rows, { item: 'Total', amountNgn: tie.totalNgn }, { item: 'Accrual bridge: cash received', amountNgn: tie.bridgeCashReceivedNgn }, { item: 'Difference', amountNgn: tie.differenceNgn }] }] : []),
  ];
}
