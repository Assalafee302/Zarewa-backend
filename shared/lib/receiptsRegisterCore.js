/**
 * Receipts register — daily cash book (Reports round 2, sales split part 1). Pure: receipts, ledger, treasury,
 * bank recon in → one line per bank leg of each receipt, daily and running totals per bank, exceptions out.
 *
 * - A line is a treasury leg of a receipt: RECEIPT_IN (and its RECEIPT_REVERSAL_OUT, negative) of a ledger receipt,
 *   or an ADVANCE_IN / ADVANCE_REVERSAL_OUT. Split receipts give one line per bank leg. Date = the money date
 *   (treasury posting date); the period, sort and daily totals use it, so the grand total = cash received.
 * - Zero-amount ledger receipts (credit applied from the refund fund / overpayment) are not cash: listed in
 *   "Settled by credit, no cash", their treasury lines left out (same rule as the sales report, round 2 A1).
 * - Bank = short bank name (Taj, Moniepoint, GT, Cash), from the treasury account, never the account title.
 * - Confirmed = "Alert · <cashier> · <dd/mm hh:mm>" once the cashier confirmed the credit alert; blank otherwise,
 *   red when still blank 24 hours after the receipt.
 * - Statement = "✓ BKR-…" when a bank-statement line names the leg; blank otherwise.
 * - Payer = name the cashier typed on the receipt (Paid by), else the "Paid by:" name on the linked bank line,
 *   else the name typed in the ledger bank reference. The source is kept for the export.
 * - Lines are grouped in three sections (no status column), each sorted by date with a subtotal by bank and a
 *   section total, from the quotation's sale jobs (same rule as the accrual statement, `saleJobsByQuotation`):
 *     1. Produced in period — a sale job completed in the period (sales this month)
 *     2. Advances — not produced by period end, or no quotation (advance deposit); "Not yet produced" while the
 *        period is still open (as-at before period end) — a line moves to section 1 when production completes
 *     3. Settles earlier debt — sale jobs only in an earlier period
 *   Sections 1+2+3 = cash received in period = the accrual bridge's cash line (`receiptsVersusAccrualBridge`).
 */

export const STATUS_PRODUCED = 'Produced';
export const STATUS_ADVANCE = 'Advance';
export const STATUS_SETTLES_DEBT = 'Settles debt';
export const RECEIPT_STATUSES = [STATUS_PRODUCED, STATUS_ADVANCE, STATUS_SETTLES_DEBT];
export const SECTION_LABELS = {
  [STATUS_PRODUCED]: 'Produced in period',
  [STATUS_ADVANCE]: 'Advances',
  [STATUS_SETTLES_DEBT]: 'Settles earlier debt',
};
export const SECTION_LABEL_OPEN_ADVANCE = 'Not yet produced';
import { creditApplicationReceipts, saleJobsByQuotation } from './salesAccrualCore.js';
import { sameName } from './refundReportCore.js';

export const RECEIPT_LEG_TYPES = ['RECEIPT_IN', 'RECEIPT_REVERSAL_OUT', 'ADVANCE_IN', 'ADVANCE_REVERSAL_OUT'];
export const UNCONFIRMED_AFTER_HOURS = 24;
export const EXC_UNCONFIRMED = 'Alert not confirmed after 24 hours';
export const EXC_NO_TREASURY = 'Receipt with no treasury line';
export const EXC_PAYER_NOT_CUSTOMER = 'Payer is not the customer';
export const REVIEW_NO_STATEMENT = 'Not on the bank statement';
export const REVIEW_CONFIRMED_LATE = 'Alert confirmed more than 24 hours after the receipt';

const day = (v) => String(v || '').slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);

/** Short bank name for a treasury account / movement. */
export function shortBankName(t) {
  if (String(t?.accountType || '').trim().toLowerCase() === 'cash') return 'Cash';
  const text = `${t?.bankName || ''} ${t?.accountName || ''}`;
  if (/moniepoint/i.test(text)) return 'Moniepoint';
  if (/\btaj\b/i.test(text)) return 'Taj';
  if (/\bgt\b|guaranty/i.test(text)) return 'GT';
  if (/\bpos\b/i.test(text)) return 'POS';
  if (/^\s*cash\b/i.test(String(t?.accountName || ''))) return 'Cash';
  const first = String(t?.bankName || '').trim().split(/\s+/)[0];
  return first || String(t?.accountName || '').trim() || '—';
}

/** dd/mm hh:mm from an ISO date-time. */
function shortStamp(iso) {
  const m = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}/${m[1]} ${m[3]}:${m[4]}` : day(iso);
}

/** Name typed in the ledger bank reference ("ibrahim dougo ₦15,000 Bank:…" → "ibrahim dougo"). */
export function payerFromBankReference(text) {
  const s = String(text || '').trim();
  if (!s || /^REVERSAL_OF:/i.test(s)) return '';
  return s.split(/\s*₦/)[0].replace(/\s+Bank:.*$/i, '').trim();
}

/** "… — Paid by: NAME" on a bank-statement narration. */
export function payerFromNarration(text) {
  const m = String(text || '').match(/Paid by:\s*(.+)$/i);
  return m ? m[1].trim() : '';
}

/**
 * @param {object} input
 * @param {object[]} input.receipts — {id, ledgerEntryId, customerID, customer, quotationRef, dateISO, amountNgn, method,
 *   status, paidByName, bankConfirmedAtISO, bankConfirmedBy}
 * @param {object[]} input.ledgerEntries
 * @param {object[]} input.treasuryMovements — period legs (with accountName/bankName/accountType)
 * @param {object[]} [input.bankRecon]
 * @param {string} input.startDate
 * @param {string} input.endDate
 * @param {string} [input.asAtISO] — "now" for the 24-hour rule (defaults to the end of endDate)
 * @param {{ bank?: string, confirmed?: 'all'|'confirmed'|'unconfirmed', payerNotCustomer?: boolean }} [input.filters]
 */
export function buildReceiptsRegister(input = {}) {
  const {
    receipts = [],
    ledgerEntries = [],
    treasuryMovements = [],
    bankRecon = [],
    productionJobs = [],
    quotations = [],
    startDate = '',
    endDate = '',
    filters = {},
  } = input;
  const asAtISO = input.asAtISO || `${endDate}T23:59:59.000Z`;
  const inPeriod = (iso) => {
    const d = day(iso);
    return Boolean(d) && (!startDate || d >= startDate) && (!endDate || d <= endDate);
  };
  const credit = creditApplicationReceipts(ledgerEntries);
  const ledgerById = new Map(ledgerEntries.map((e) => [String(e.id || '').trim(), e]));
  const receiptByLedger = new Map();
  for (const r of receipts) {
    const k = String(r.ledgerEntryId || r.id || '').trim();
    if (k && !receiptByLedger.has(k)) receiptByLedger.set(k, r);
  }
  const bankByMovement = new Map();
  let statementToISO = '';
  for (const b of bankRecon) {
    const d = day(b.bankDateISO);
    if (d > statementToISO) statementToISO = d;
    for (const hit of String(b?.systemMatch || '').matchAll(/TM-[A-Z]{2,4}-\d{2}-\d+/gi)) {
      const id = hit[0].toUpperCase();
      if (!bankByMovement.has(id)) bankByMovement.set(id, b);
    }
  }
  const statementLoaded = Boolean(statementToISO) && statementToISO >= endDate;

  const { jobsByQuote } = saleJobsByQuotation({ productionJobs, quotations, quotationLines: input.quotationLines, endDate });
  const statusFor = (qref) => {
    const jobs = jobsByQuote.get(String(qref || '').trim()) || [];
    if (jobs.some((j) => inPeriod(j.date))) return STATUS_PRODUCED;
    if (jobs.some((j) => startDate && j.date < startDate)) return STATUS_SETTLES_DEBT;
    return STATUS_ADVANCE;
  };

  const legs = treasuryMovements.filter(
    (t) =>
      RECEIPT_LEG_TYPES.includes(t.type) &&
      inPeriod(t.postedAtISO) &&
      ngn(t.amountNgn) !== 0 &&
      !(String(t.sourceKind || '') === 'LEDGER_RECEIPT' && credit.has(String(t.sourceId || '').trim()))
  );
  const legLedgerIds = new Set(legs.map((t) => String(t.sourceId || '').trim()));
  const hoursSince = (iso) => (Date.parse(asAtISO) - Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso)) / 3_600_000;

  let lines = legs.map((t) => {
    const ledgerId = String(t.sourceId || '').trim();
    const r = receiptByLedger.get(ledgerId) || null;
    const le = ledgerById.get(ledgerId) || {};
    const bankLine = bankByMovement.get(String(t.id).toUpperCase()) || null;
    const isReversal = /REVERSAL_OUT$/.test(t.type);
    let payer = String(r?.paidByName || '').trim();
    let payerSource = payer ? 'receipt' : '';
    if (!payer && bankLine) {
      payer = payerFromNarration(bankLine.description);
      payerSource = payer ? 'bank statement' : '';
    }
    if (!payer) {
      payer = payerFromBankReference(le.bankReference);
      payerSource = payer ? 'typed by sales' : '';
    }
    const customerName = String(r?.customer || le.customerName || t.counterpartyName || '').trim();
    const receiptDateISO = day(r?.dateISO || le.atISO || t.postedAtISO);
    const confirmedAt = r?.bankConfirmedAtISO || '';
    const confirmed = confirmedAt ? `Alert · ${String(r?.bankConfirmedBy || '').trim() || 'cashier'} · ${shortStamp(confirmedAt)}` : '';
    const exceptions = [];
    const review = [];
    if (!isReversal && !confirmed && t.type === 'RECEIPT_IN' && hoursSince(receiptDateISO) > UNCONFIRMED_AFTER_HOURS) exceptions.push(EXC_UNCONFIRMED);
    if (!isReversal && confirmedAt && hoursSince(receiptDateISO) - hoursSince(confirmedAt) > UNCONFIRMED_AFTER_HOURS + 24) {
      // receipt dates carry no time: allow the rest of the receipt day before counting 24 hours
      review.push(REVIEW_CONFIRMED_LATE);
    }
    if (!isReversal && payer && customerName && !sameName(payer, customerName)) review.push(EXC_PAYER_NOT_CUSTOMER);
    const bank = shortBankName(t);
    if (statementLoaded && bank !== 'Cash' && !bankLine) review.push(REVIEW_NO_STATEMENT);
    return {
      dateISO: day(t.postedAtISO),
      receiptDateISO,
      payer,
      payerSource,
      customerID: String(r?.customerID || le.customerID || '').trim(),
      customerName,
      quotationRef: String(r?.quotationRef || le.quotationRef || '').trim(),
      statusAtPeriodEnd: statusFor(r?.quotationRef || le.quotationRef),
      receiptId: String(r?.id || ledgerId),
      ledgerEntryId: ledgerId,
      treasuryMovementId: String(t.id),
      type: t.type,
      amountNgn: ngn(t.amountNgn),
      bank,
      treasuryAccountId: t.treasuryAccountId,
      confirmed,
      confirmedAtISO: confirmedAt,
      statement: bankLine ? `✓ ${bankLine.id}` : '',
      bankLineId: bankLine ? String(bankLine.id) : '',
      remark: isReversal ? `Reversal of ${ledgerId}` : String(le.note || '').trim(),
      receiptStatus: String(r?.status || '').trim(),
      exceptions,
      review,
      severity: exceptions.length ? 'exception' : review.length ? 'review' : '',
    };
  });

  // Filters (date range = the period).
  if (filters.bank) lines = lines.filter((l) => l.bank === filters.bank);
  if (filters.confirmed === 'confirmed') lines = lines.filter((l) => l.confirmed);
  if (filters.confirmed === 'unconfirmed') lines = lines.filter((l) => !l.confirmed);
  if (filters.payerNotCustomer) lines = lines.filter((l) => l.review.includes(EXC_PAYER_NOT_CUSTOMER));

  lines.sort(
    (a, b) =>
      a.dateISO.localeCompare(b.dateISO) ||
      a.bank.localeCompare(b.bank) ||
      a.receiptDateISO.localeCompare(b.receiptDateISO) ||
      a.treasuryMovementId.localeCompare(b.treasuryMovementId)
  );

  // Daily subtotal per bank + running monthly total per bank.
  const banks = [...new Set(lines.map((l) => l.bank))].sort();
  const running = Object.fromEntries(banks.map((b) => [b, 0]));
  const days = [];
  for (const d of [...new Set(lines.map((l) => l.dateISO))]) {
    const dayLines = lines.filter((l) => l.dateISO === d);
    const byBank = banks
      .map((b) => {
        const amt = dayLines.filter((l) => l.bank === b).reduce((s, l) => s + l.amountNgn, 0);
        if (!dayLines.some((l) => l.bank === b)) return null;
        running[b] += amt;
        return { bank: b, dayNgn: amt, monthToDateNgn: running[b] };
      })
      .filter(Boolean);
    days.push({ dateISO: d, lineCount: dayLines.length, byBank, dayNgn: dayLines.reduce((s, l) => s + l.amountNgn, 0) });
  }

  // Receipts dated in the period with no treasury leg (not credit applications).
  const noTreasury = receipts
    .filter((r) => inPeriod(r.dateISO) && ngn(r.amountNgn) !== 0)
    .filter((r) => !/^reversed$/i.test(String(r.status || '').trim()))
    .filter((r) => !legLedgerIds.has(String(r.ledgerEntryId || r.id || '').trim()))
    .filter((r) => !treasuryMovements.some((t) => String(t.sourceId || '').trim() === String(r.ledgerEntryId || r.id || '').trim()))
    .map((r) => ({
      dateISO: day(r.dateISO),
      receiptId: String(r.id || ''),
      ledgerEntryId: String(r.ledgerEntryId || ''),
      customerName: String(r.customer || ''),
      quotationRef: String(r.quotationRef || ''),
      amountNgn: ngn(r.amountNgn),
      status: String(r.status || ''),
      exceptions: [EXC_NO_TREASURY],
      severity: 'exception',
    }));

  const creditRows = [...credit.values()]
    .filter((c) => inPeriod(c.dateISO))
    .map((c) => ({ ...c, receiptId: String(receiptByLedger.get(c.ledgerEntryId)?.id || c.ledgerEntryId) }))
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.ledgerEntryId.localeCompare(b.ledgerEntryId));

  const totalsByBank = banks.map((b) => ({
    bank: b,
    amountNgn: lines.filter((l) => l.bank === b).reduce((s, l) => s + l.amountNgn, 0),
    lineCount: lines.filter((l) => l.bank === b).length,
  }));
  const cashLines = lines.filter((l) => l.type === 'RECEIPT_IN');
  const periodOpen = Date.parse(asAtISO) < Date.parse(`${endDate}T23:59:59.000Z`);
  const sections = RECEIPT_STATUSES.map((status, i) => {
    const list = lines
      .filter((l) => l.statusAtPeriodEnd === status)
      .slice()
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.bank.localeCompare(b.bank) || a.treasuryMovementId.localeCompare(b.treasuryMovementId));
    const byBank = [...new Set(list.map((l) => l.bank))].sort().map((bank) => ({
      bank,
      amountNgn: list.filter((l) => l.bank === bank).reduce((s, l) => s + l.amountNgn, 0),
      lineCount: list.filter((l) => l.bank === bank).length,
    }));
    return {
      number: i + 1,
      status,
      label: status === STATUS_ADVANCE && periodOpen ? SECTION_LABEL_OPEN_ADVANCE : SECTION_LABELS[status],
      lines: list,
      byBank,
      totalNgn: list.reduce((s, l) => s + l.amountNgn, 0),
    };
  });
  const totalsByStatus = RECEIPT_STATUSES.map((status) => ({
    status,
    amountNgn: lines.filter((l) => l.statusAtPeriodEnd === status).reduce((s, l) => s + l.amountNgn, 0),
    lineCount: lines.filter((l) => l.statusAtPeriodEnd === status).length,
  }));
  return {
    startDate,
    endDate,
    asAtISO,
    statementLoaded,
    statementToISO,
    lines,
    days,
    totalsByBank,
    totalsByStatus,
    sections,
    periodOpen,
    filtered: Boolean(filters.bank || (filters.confirmed && filters.confirmed !== 'all') || filters.payerNotCustomer),
    grandTotalNgn: lines.reduce((s, l) => s + l.amountNgn, 0),
    creditSettled: { rows: creditRows, amountNgn: creditRows.reduce((s, c) => s + c.creditAppliedNgn, 0) },
    noTreasury,
    counts: {
      lines: lines.length,
      unconfirmed: cashLines.filter((l) => !l.confirmed).length,
      unconfirmedOver24h: lines.filter((l) => l.exceptions.includes(EXC_UNCONFIRMED)).length,
      confirmedLate: lines.filter((l) => l.review.includes(REVIEW_CONFIRMED_LATE)).length,
      withoutStatement: statementLoaded ? lines.filter((l) => l.review.includes(REVIEW_NO_STATEMENT)).length : null,
      payerNotCustomer: lines.filter((l) => l.review.includes(EXC_PAYER_NOT_CUSTOMER)).length,
      noTreasury: noTreasury.length,
    },
  };
}

/**
 * Receipts by status at period end against the accrual statement's bridge. The three statuses add up to the bridge's
 * "cash received in period" (same treasury lines, credit applications left out of both); difference expected ₦0.
 * @param {ReturnType<typeof buildReceiptsRegister>} register — unfiltered
 * @param {{ bridge: { cashReceivedNgn: number, cashNotAttributableNgn: number } }} accrual — `buildSalesAccrual` output
 */
export function receiptsVersusAccrualBridge(register, accrual) {
  const b = accrual?.bridge || {};
  const rows = register.sections.map((x) => ({ item: `${x.number}. ${x.label}`, amountNgn: x.totalNgn, lineCount: x.lines.length }));
  const total = rows.reduce((s, r) => s + r.amountNgn, 0);
  return {
    rows,
    totalNgn: total,
    bridgeCashReceivedNgn: Math.round(Number(b.cashReceivedNgn) || 0),
    cashNotAttributableNgn: Math.round(Number(b.cashNotAttributableNgn) || 0),
    differenceNgn: total - Math.round(Number(b.cashReceivedNgn) || 0),
    comparable: !register.filtered,
  };
}
