import { describe, it, expect } from 'vitest';
import { buildTreasuryCashBook, cashBookRows, cashBookRef, lagosDate, staffViaRemark } from './treasuryCashBookCore.js';
import { treasuryCashBookDocument, treasuryCashBookExcelSheets } from './treasuryCashBookPrint.js';

const at = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const STAFF = [
  { name: 'Abdulrahman Uthman Sali', label: 'OM account' },
  { name: 'Muhammad Ibrahim Bakari', label: 'Bakari' },
];

function fixture(extra = {}) {
  return {
    account: { id: 4, name: 'Zarewa Aluminum & Plastics Ltd', bankName: 'Moniepoint', accNo: '6432680767' },
    branchName: 'Kaduna',
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    openingNgn: 3411799,
    staffAccounts: STAFF,
    movements: [
      { id: 'TM-1', postedAtISO: at('2026-10-01 06:10'), type: 'RECEIPT_IN', treasuryAccountId: 4, amountNgn: 353000, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-2093' },
      { id: 'TM-2', postedAtISO: at('2026-10-01 09:58'), type: 'EXPENSE', treasuryAccountId: 4, amountNgn: -1000000, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0472' },
      { id: 'TM-3', postedAtISO: at('2026-10-01 11:54'), type: 'INTERNAL_TRANSFER_OUT', treasuryAccountId: 4, amountNgn: -2411727, counterpartyId: '2', sourceKind: 'TREASURY_TRANSFER', sourceId: 'TR-26-00042' },
      { id: 'TM-4', postedAtISO: at('2026-10-01 18:20'), type: 'PAYMENT_REQUEST_OUT', treasuryAccountId: 4, amountNgn: -15000, sourceKind: 'PAYMENT_REQUEST', sourceId: 'PREQ-KD-26-0312' },
      { id: 'TM-5', postedAtISO: at('2026-10-01 20:00'), type: 'EXPENSE', treasuryAccountId: 4, amountNgn: -515, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0480' },
      { id: 'TM-6', postedAtISO: at('2026-10-02 09:46'), type: 'REFUND_PAYOUT', treasuryAccountId: 4, amountNgn: -1290000, counterpartyName: 'Suleiman Adamu', sourceKind: 'REFUND', sourceId: 'RF-KD-26-9730' },
      { id: 'TM-7', postedAtISO: at('2026-10-02 16:05'), type: 'REFUND_PAYOUT', treasuryAccountId: 4, amountNgn: -463000, counterpartyName: 'Abdulrahman Uthman Sali', sourceKind: 'REFUND', sourceId: 'RF-KD-26-9730' },
      { id: 'TM-8', postedAtISO: at('2026-10-02 17:00'), type: 'EXPENSE', treasuryAccountId: 4, amountNgn: -20000, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0467' },
      { id: 'TM-9', postedAtISO: at('2026-10-02 18:00'), type: 'EXPENSE', treasuryAccountId: 4, amountNgn: -8340, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0471' },
      { id: 'TM-10', postedAtISO: at('2026-10-02 18:00'), type: 'EXPENSE_REVERSAL_IN', treasuryAccountId: 4, amountNgn: 8340, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0471' },
      { id: 'TM-11', postedAtISO: at('2026-10-02 19:00'), type: 'EXPENSE', treasuryAccountId: 4, amountNgn: -564, sourceKind: 'EXPENSE', sourceId: 'EXP-KD-26-0481' },
      { id: 'TM-X', postedAtISO: at('2026-10-02 19:00'), type: 'RECEIPT_IN', treasuryAccountId: 2, amountNgn: 999, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-9999' },
    ],
    receipts: { 'LE-KD-26-2093': { customerName: 'Engr Attah Nicholas', paidByName: 'Muhammad Ibrahim Bakari', bankReference: '', pos: false } },
    refunds: { 'RF-KD-26-9730': { customerName: 'Suleiman Zaria', quotationRef: 'QT-KD-26-1715', payeeName: 'Suleiman Adamu', staffShare: false } },
    refundPayoutLines: { 'RF-KD-26-9730': ['TM-6', 'TM-7'] },
    paymentRequests: { 'PREQ-KD-26-0312': { payeeName: 'Adamu Hayatu', description: 'Bricklayer labour' } },
    expenses: {
      'EXP-KD-26-0472': { expenseType: 'Commission – QS Isa, FGGC project (QT-KD-26-1394), MD-approved exception', category: 'Sales commission' },
      'EXP-KD-26-0480': { expenseType: 'Bank charges — Moniepoint', category: 'Bank charges' },
      'EXP-KD-26-0467': { expenseType: 'GM IOU — Bala Muazu Suleiman', category: 'Staff loan' },
      'EXP-KD-26-0471': { expenseType: 'Bank charges — Moniepoint, Oct 2026', category: 'Bank charges' },
      'EXP-KD-26-0481': { expenseType: 'Bank charges — Moniepoint', category: 'Bank charges' },
    },
    accountNames: { 2: 'Zaps Aluminum Enterprises (Taj Bank)' },
    statementClosings: { '2026-10-02': 3411799 + 353000 - 1000000 - 2411727 - 15000 - 515 - 1290000 - 463000 - 20000 - 564 },
    ...extra,
  };
}

describe('treasury cash book', () => {
  it('uses the Lagos date for the day', () => {
    expect(lagosDate('2026-09-30T23:30:00.000Z')).toBe('2026-10-01');
    expect(lagosDate('2026-10-01T22:59:00.000Z')).toBe('2026-10-01');
  });

  it('short refs', () => {
    const b = fixture();
    const ref = (id) => cashBookRef(b.movements.find((m) => m.id === id), b);
    expect(ref('TM-1')).toBe('RC-2093');
    expect(ref('TM-2')).toBe('EXP-472');
    expect(ref('TM-3')).toBe('TR');
    expect(ref('TM-4')).toBe('EX-312');
    expect(ref('TM-5')).toBe('BC');
    expect(ref('TM-6')).toBe('RF-9730');
    expect(ref('TM-8')).toBe('IOU');
  });

  it('days: lines, total without bank charges, one BC line, closing; balance on every line', () => {
    const book = buildTreasuryCashBook(fixture());
    expect(book.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02']);
    const [d1, d2] = book.days;
    expect(d1.lines.map((l) => l.ref)).toEqual(['RC-2093', 'EXP-472', 'TR', 'EX-312']);
    expect(d1.totalInNgn).toBe(353000);
    expect(d1.totalOutNgn).toBe(1000000 + 2411727 + 15000);
    expect(d1.bankChargesNgn).toBe(515);
    expect(d1.closingNgn).toBe(3411799 + 353000 - 3426727 - 515);
    expect(d1.lines.at(-1).balanceNgn).toBe(d1.closingNgn + 515);
    // The reversed Oct expense and its reversal net out inside the BC line.
    expect(d2.bankChargesNgn).toBe(564);
    expect(d2.lines.map((l) => l.ref)).toEqual(['RF-9730', 'RF-9730', 'IOU']);
    expect(book.closingNgn).toBe(d2.closingNgn);
    expect(d2.diffNgn).toBe(0);
    expect(book.days.flatMap((d) => d.lines).some((l) => l.movementId === 'TM-X')).toBe(false);
  });

  it('descriptions and remarks: payer, part n of m, via staff account, internal transfer', () => {
    const [d1, d2] = buildTreasuryCashBook(fixture()).days;
    expect(d1.lines[0].description).toBe('Engr Attah Nicholas – paid by Muhammad Ibrahim Bakari');
    expect(d1.lines[0].remark).toBe('paid via Bakari');
    expect(d1.lines[2].description).toBe('Transfer to Zaps Aluminum Enterprises (Taj Bank)');
    expect(d1.lines[3].description).toBe('Adamu Hayatu – Bricklayer labour');
    expect(d2.lines[0].description).toBe('Suleiman Zaria refund (QT-1715) – part 1 of 2');
    expect(d2.lines[1].description).toBe('Suleiman Zaria refund (QT-1715) – part 2 of 2');
    expect(d2.lines[1].remark).toBe('via OM account');
  });

  it('rows: Balance b/f first, Date only on the first line of a day, statement columns when a closing is on file', () => {
    const book = buildTreasuryCashBook(fixture());
    const rows = cashBookRows(book);
    expect(rows[0].kind).toBe('bf');
    expect(rows[0].balanceNgn).toBe(3411799);
    const day1 = rows.filter((r) => r.kind === 'line').slice(0, 4);
    expect(day1.map((r) => r.date)).toEqual(['2026-10-01', '', '', '']);
    expect(rows.filter((r) => r.kind === 'bc').length).toBe(2);
    const doc = treasuryCashBookDocument(book);
    expect(doc.sections[0].columns.map((c) => c.label)).toContain('Statement close ₦');
    const [sheet] = treasuryCashBookExcelSheets(book);
    expect(sheet.rows.length).toBe(rows.length);
    expect(Object.keys(sheet.rows[0])).toEqual(['Date', 'Ref', 'Description', 'Cr (In) ₦', 'Dr (Out) ₦', 'Balance ₦', 'Statement close ₦', 'Diff', 'Remark', 'ERP movement']);
  });

  it('cut-off time on the end date', () => {
    const book = buildTreasuryCashBook(fixture({ endAtISO: at('2026-10-02 12:00') }));
    expect(book.days[1].lines.map((l) => l.movementId)).toEqual(['TM-6']);
  });

  it('a receipt reversal prints on the day of the receipt it cancels (pair nets to zero that day)', () => {
    const f = fixture();
    f.movements.push({ id: 'TM-R', postedAtISO: at('2026-10-02 10:00'), type: 'RECEIPT_REVERSAL_OUT', treasuryAccountId: 4, amountNgn: -353000, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-2093', reversesMovementId: 'TM-1', reversesPostedAtISO: f.movements[0].postedAtISO });
    const [d1, d2] = buildTreasuryCashBook(f).days;
    expect(d1.lines.map((l) => l.movementId).slice(0, 2)).toEqual(['TM-1', 'TM-R']);
    expect(d1.totalInNgn - 353000).toBe(0);
    expect(d2.lines.some((l) => l.movementId === 'TM-R')).toBe(false);
  });

  it('every day of the range has a block, even with no lines', () => {
    const book = buildTreasuryCashBook(fixture({ endDate: '2026-10-04' }));
    expect(book.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    const rows = cashBookRows(book);
    expect(rows.filter((r) => r.description === '(no transactions)').length).toBe(2);
    expect(book.days[3].closingNgn).toBe(book.days[1].closingNgn);
  });

  it('print: no "N/A" account number, Lagos cut-off time, dd/mm/yyyy, table on page 1, no correction tags', () => {
    const f = fixture({ endAtISO: '2026-10-02T08:44:59.999Z', corrections: { 'TM-1': 'ERP corrected (R2-C1)' } });
    f.account.accNo = 'N/A';
    const doc = treasuryCashBookDocument(buildTreasuryCashBook(f));
    expect(doc.sections[0].title).toBe('Zarewa Aluminum & Plastics Ltd (Moniepoint)');
    const labels = doc.summary.rows.map((r) => r.label);
    expect(labels).toContain('Closing balance 02/10/2026 (to 09:44)');
    expect(labels[1]).toBe('Balance b/f 01/10/2026');
    expect(doc.sections[0].pageBreakBefore).toBe(false);
    expect(doc.sections[0].rows.some((r) => /ERP corrected/.test(r.remark || ''))).toBe(false);
    const [sheet] = treasuryCashBookExcelSheets(buildTreasuryCashBook(f));
    expect(sheet.rows[1].Date).toBe('01/10/2026');
    expect(sheet.rows[1]['ERP movement']).toBe('TM-1');
  });

  it('staff via remark needs the whole name or an explicit "via"', () => {
    expect(staffViaRemark(['Bakari Mohammed Ibrahim'], STAFF)).toBe('');
    expect(staffViaRemark(['MUHAMMAD IBRAHIM BAKARI'], STAFF)).toBe('via Bakari');
    expect(staffViaRemark(['paid via OM'], STAFF)).toBe('via OM account');
  });
});

describe('treasury cash book — confirmed vs all movements (owner, 17 Oct)', () => {
  // RC-2161 pending clearance (on the bank: no); RC-2168 pending then reversed (double entry); RC-1926 confirmed then reversed.
  const confirmFixture = (mode) =>
    fixture({
      mode,
      openingConfirmedNgn: 3411799 - 5000,
      movements: [
        ...fixture().movements,
        { id: 'TM-20', postedAtISO: at('2026-10-02 12:00'), type: 'RECEIPT_IN', treasuryAccountId: 4, amountNgn: 34545, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-2161' },
        { id: 'TM-21', postedAtISO: at('2026-10-02 12:00'), type: 'RECEIPT_IN', treasuryAccountId: 4, amountNgn: 1562900, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-2168' },
        { id: 'TM-22', postedAtISO: at('2026-10-02 13:00'), type: 'RECEIPT_REVERSAL_OUT', treasuryAccountId: 4, amountNgn: -1562900, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-2168', reversesMovementId: 'TM-21', reversesPostedAtISO: at('2026-10-02 12:00') },
        { id: 'TM-23', postedAtISO: at('2026-10-01 12:00'), type: 'RECEIPT_IN', treasuryAccountId: 4, amountNgn: 4700, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-1926' },
        { id: 'TM-24', postedAtISO: at('2026-10-02 11:58'), type: 'RECEIPT_REVERSAL_OUT', treasuryAccountId: 4, amountNgn: -4700, sourceKind: 'LEDGER_RECEIPT', sourceId: 'LE-KD-26-1926', reversesMovementId: 'TM-23', reversesPostedAtISO: at('2026-10-01 12:00') },
      ],
      receipts: {
        ...fixture().receipts,
        'LE-KD-26-2161': { customerName: 'Hannatu Thomas', confirmed: false, status: 'Pending clearance' },
        'LE-KD-26-2168': { customerName: 'mamman cap zaria', confirmed: false, reversed: true, status: 'Reversed' },
        'LE-KD-26-1926': { customerName: 'Anas Cap Zaria', confirmed: true, reversed: true, status: 'Reversed' },
      },
      bankNarrations: {},
    });

  it('confirmed (default) leaves out unconfirmed receipts and their reversals, from the confirmed opening', () => {
    const book = buildTreasuryCashBook(confirmFixture(undefined));
    const all = buildTreasuryCashBook(confirmFixture('all'));
    expect(book.mode).toBe('confirmed');
    expect(book.openingNgn).toBe(3411799 - 5000);
    const ids = book.days.flatMap((d) => d.lines.map((l) => l.movementId));
    expect(ids).not.toContain('TM-20');
    expect(ids).not.toContain('TM-21');
    expect(ids).not.toContain('TM-22');
    expect(ids).toEqual(expect.arrayContaining(['TM-23', 'TM-24']));
    expect(all.mode).toBe('all');
    expect(all.openingNgn).toBe(3411799);
    expect(all.days.flatMap((d) => d.lines.map((l) => l.movementId))).toEqual(expect.arrayContaining(['TM-20', 'TM-21', 'TM-22']));
    // Same movements apart from the unconfirmed ones and the opening.
    expect(all.closingNgn - book.closingNgn).toBe(34545 + 5000);
  });

  it('lists live unconfirmed receipts in both modes (reversed ones are not awaiting)', () => {
    for (const mode of [undefined, 'all']) {
      const book = buildTreasuryCashBook(confirmFixture(mode));
      expect(book.awaiting).toEqual([
        { date: '2026-10-02', ref: 'RC-2161', receiptId: 'LE-KD-26-2161', movementId: 'TM-20', customer: 'Hannatu Thomas', amountNgn: 34545, onBank: false, status: 'Pending clearance' },
      ]);
      expect(book.awaitingTotalNgn).toBe(34545);
    }
  });

  it('print states the mode and ends with the awaiting block; Excel has an awaiting sheet', () => {
    const doc = treasuryCashBookDocument(buildTreasuryCashBook(confirmFixture(undefined)));
    expect(doc.title).toMatch(/confirmed movements/);
    expect(doc.summary.rows.find((r) => r.label === 'Printed').value).toMatch(/Confirmed movements only/);
    const block = doc.sections.at(-1);
    expect(block.title).toBe('Awaiting confirmation');
    expect(block.rows[0]).toMatchObject({ ref: 'RC-2161', customer: 'Hannatu Thomas', amountNgn: 34545, onBank: 'No match' });
    expect(block.rows.at(-1)).toMatchObject({ customer: 'Total awaiting confirmation', amountNgn: 34545 });
    expect(treasuryCashBookDocument(buildTreasuryCashBook(confirmFixture('all'))).title).toMatch(/all movements/);
    const sheets = treasuryCashBookExcelSheets(buildTreasuryCashBook(confirmFixture(undefined)));
    expect(sheets.map((s) => s.name)).toEqual(['Moniepoint cash book', 'Awaiting confirmation']);
    expect(sheets[1].rows[0]).toMatchObject({ Ref: 'RC-2161', 'Amount ₦': 34545, 'On bank': 'No match' });
  });
});
