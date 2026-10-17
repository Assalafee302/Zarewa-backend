/**
 * Treasury account statement — cash-book layout (owner, 17 Oct 2026; layout of the sheet "Oct 2026 Moniepoint" in
 * Moniepoint_Cash_Book_Oct2026.xlsx). Pure: one account's movements + the records they come from in → days of lines.
 *
 * Per day (Lagos date): the day's lines in time order, then a Total line (Cr, Dr — bank charges excluded), one
 * bank-charges line (BC: every "Bank charges" expense of the day, net of reversals), and the closing balance.
 * The first line is "Balance b/f". Balance runs on every line. Ref short codes:
 *   RC-#### receipt LE-KD-26-#### · EX-### payment request PREQ-KD-26-0### · EXP-### direct expense · RF-#### refund
 *   RF-KD-26-#### · TR internal transfer · PO-## supplier / transport payment · IOU staff advance · RCW-# company-cut
 *   withdrawal · BC bank charges · ADJ statement alignment.
 * Amounts are the ERP's (transaction amounts ex-fee; transfer fees are in the BC line).
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x) => Math.round(x * 100) / 100;
/** Trailing number of an id, without leading zeros, padded to k digits (PREQ-KD-26-0312 → "312"; LE-…-1986 → "1986"). */
const lastDigits = (id, k) => {
  const m = String(id || '').match(/(\d+)\s*$/);
  return m ? String(Number(m[1])).padStart(k, '0') : '';
};

/** ISO instant → Lagos calendar date (YYYY-MM-DD). */
export function lagosDate(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return String(iso || '').slice(0, 10);
  return new Date(t + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Short reference for a movement (see module note). */
export function cashBookRef(m, ctx = {}) {
  const sid = String(m.sourceId || '');
  const exp = ctx.expenses?.[sid];
  switch (m.type) {
    case 'RECEIPT_IN':
    case 'ADVANCE_IN':
    case 'RECEIPT_REVERSAL_OUT':
    case 'ADVANCE_REVERSAL_OUT':
      return sid ? `RC-${lastDigits(sid, 4)}` : 'RC-';
    case 'PAYMENT_REQUEST_OUT':
    case 'PAYMENT_REQUEST_REVERSAL_IN':
      return `EX-${lastDigits(sid, 3)}`;
    case 'EXPENSE':
    case 'EXPENSE_REVERSAL_IN':
      if (isBankCharge(m, ctx)) return 'BC';
      if (/staff loan|iou/i.test(String(exp?.category || ''))) return 'IOU';
      return `EXP-${lastDigits(sid, 3)}`;
    case 'REFUND_PAYOUT':
    case 'REFUND_PAYOUT_REVERSAL_IN':
      return `RF-${lastDigits(sid, 4)}`;
    case 'REFUND_COMPANY_CUT_PAYOUT':
      return `RCW-${Number(lastDigits(sid, 1)) || ''}`;
    case 'INTERNAL_TRANSFER_OUT':
    case 'INTERNAL_TRANSFER_IN':
      return 'TR';
    case 'AP_PAYMENT':
    case 'SUPPLIER_PAYMENT':
    case 'TRANSPORT_PAYMENT':
    case 'SUPPLIER_OVERPAYMENT': {
      const po = ctx.payables?.[sid]?.poRef || sid;
      const d = String(po).match(/PO-[A-Z]+-\d+-(\d+)/);
      return d ? `PO-${Number(d[1])}` : 'PO';
    }
    case 'BANK_RECON_ADJUSTMENT':
      return 'ADJ';
    default:
      return '';
  }
}

/** Expense line (or its reversal) in category "Bank charges" → part of the day's BC line. */
export function isBankCharge(m, ctx = {}) {
  if (m.type !== 'EXPENSE' && m.type !== 'EXPENSE_REVERSAL_IN') return false;
  return /^bank charges$/i.test(String(ctx.expenses?.[String(m.sourceId || '')]?.category || '').trim());
}

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Text mentions a staff member (all name words present, any order) or says "via <label>". */
export function staffViaRemark(texts, staffAccounts = []) {
  const joined = texts.filter(Boolean).join(' ');
  const have = new Set(words(joined));
  for (const s of staffAccounts) {
    const need = words(s.name);
    if (need.length >= 2 && need.every((w) => have.has(w))) return `via ${s.label}`;
    if (s.label && new RegExp(`\\bvia\\s+${s.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(joined)) return `via ${s.label}`;
  }
  const m = joined.match(/\bvia\s+(OM account|OM|Bakari|BM\s+\w+)/i);
  if (m) return `via ${/^om$/i.test(m[1]) ? 'OM account' : m[1]}`;
  return '';
}

function describe(m, ctx) {
  const sid = String(m.sourceId || '');
  const amount = n(m.amountNgn);
  const rec = ctx.receipts?.[sid];
  const ref = ctx.refunds?.[sid];
  const pr = ctx.paymentRequests?.[sid];
  const exp = ctx.expenses?.[sid];
  const ap = ctx.payables?.[sid];
  const other = ctx.accountNames?.[String(m.counterpartyId || '')] || m.counterpartyName || '';
  switch (m.type) {
    case 'RECEIPT_IN':
    case 'ADVANCE_IN':
      return rec?.paidByName && rec?.customerName && rec.paidByName.toLowerCase() !== rec.customerName.toLowerCase()
        ? `${rec.customerName} – paid by ${rec.paidByName}`
        : rec?.paidByName || rec?.customerName || m.counterpartyName || 'Receipt';
    case 'RECEIPT_REVERSAL_OUT':
    case 'ADVANCE_REVERSAL_OUT':
      return `${rec?.customerName || m.counterpartyName || 'Receipt'} – receipt reversed`;
    case 'REFUND_PAYOUT':
    case 'REFUND_PAYOUT_REVERSAL_IN': {
      const lines = ctx.refundPayoutLines?.[sid] || [];
      const part = lines.length > 1 ? ` – part ${lines.indexOf(m.id) + 1} of ${lines.length}` : '';
      const qt = ref?.quotationRef ? ` (QT-${lastDigits(ref.quotationRef, 4)})` : '';
      return `${ref?.customerName || m.counterpartyName || 'Customer'} refund${qt}${part}${amount > 0 ? ' – reversal' : ''}`;
    }
    case 'REFUND_COMPANY_CUT_PAYOUT':
      return 'Company cut withdrawal (20% of staff refunds)';
    case 'PAYMENT_REQUEST_OUT':
    case 'PAYMENT_REQUEST_REVERSAL_IN': {
      const text = [pr?.payeeName, pr?.description].filter(Boolean).join(' – ');
      return `${text || m.counterpartyName || 'Payment request'}${amount > 0 ? ' – reversal' : ''}`;
    }
    case 'EXPENSE':
    case 'EXPENSE_REVERSAL_IN':
      return `${exp?.expenseType || m.note || m.counterpartyName || 'Expense'}${amount > 0 ? ' – reversal' : ''}`;
    case 'AP_PAYMENT':
    case 'SUPPLIER_PAYMENT':
    case 'SUPPLIER_OVERPAYMENT':
      return `Supplier payment – ${ap?.supplierName || m.counterpartyName || ''}`.trim();
    case 'TRANSPORT_PAYMENT':
      return `Transport – ${m.counterpartyName || ap?.supplierName || ''}`.trim();
    case 'INTERNAL_TRANSFER_OUT':
      return `Transfer to ${other || 'own account'}`;
    case 'INTERNAL_TRANSFER_IN':
      return `Transfer from ${other || 'own account'}`;
    case 'BANK_RECON_ADJUSTMENT':
      return m.note || 'Statement alignment';
    default:
      return m.note || m.counterpartyName || m.type;
  }
}

function remark(m, ctx) {
  const sid = String(m.sourceId || '');
  const rec = ctx.receipts?.[sid];
  const ref = ctx.refunds?.[sid];
  const pr = ctx.paymentRequests?.[sid];
  const parts = [];
  const isOut = n(m.amountNgn) < 0;
  // A staff advance is paid to the staff member, not through him.
  const isIou = cashBookRef(m, ctx) === 'IOU';
  if (isIou) parts.push('Staff advance');
  if (isOut && !isIou) {
    const via = staffViaRemark([m.counterpartyName, m.note, ref?.payeeName, ref?.paymentNote, pr?.payeeName], ctx.staffAccounts);
    if (via) parts.push(via);
  } else if (rec) {
    const via = staffViaRemark([rec.paidByName, rec.bankReference], ctx.staffAccounts);
    if (via) parts.push(`paid ${via}`);
  }
  if ((m.type === 'RECEIPT_IN' || m.type === 'ADVANCE_IN') && (rec?.pos || /\bPURCHASE FOR\b/i.test(ctx.bankNarrations?.[m.id] || ''))) parts.push('POS');
  if (m.type === 'REFUND_PAYOUT' && ref?.staffShare) parts.push('staff share 80%');
  if (m.type === 'INTERNAL_TRANSFER_OUT' || m.type === 'INTERNAL_TRANSFER_IN') parts.push('Internal transfer');
  if (m.type === 'RECEIPT_REVERSAL_OUT' && m.note) parts.push(m.note);
  const c = ctx.corrections?.[m.id] || ctx.corrections?.[sid];
  if (c) parts.push(c);
  return [...new Set(parts)].join('; ');
}

/**
 * @param {object} input
 * @param {{id:number,name:string,bankName?:string,accNo?:string}} input.account
 * @param {string} input.startDate — Lagos date
 * @param {string} input.endDate — Lagos date (inclusive)
 * @param {string} [input.endAtISO] — optional cut-off instant on the end date (e.g. a statement time)
 * @param {number} input.openingNgn — ERP balance before startDate (Lagos)
 * @param {object[]} input.movements — {id, postedAtISO, type, amountNgn, sourceKind, sourceId, counterpartyId, counterpartyName, note}
 * @param {object} [input.receipts] / refunds / paymentRequests / expenses / payables / accountNames / refundPayoutLines /
 *   corrections / bankNarrations — keyed lookups (see describe / remark)
 * @param {{name:string,label:string}[]} [input.staffAccounts] — staff whose accounts are used for payouts
 * @param {Record<string, number>} [input.statementClosings] — Lagos date → statement closing (kobo allowed)
 */
export function buildTreasuryCashBook(input = {}) {
  const { account = {}, startDate = '', endDate = '', endAtISO = '' } = input;
  const ctx = input;
  const startMs = Date.parse(`${startDate}T00:00:00+01:00`);
  const endMs = endAtISO ? Date.parse(endAtISO) : Date.parse(`${endDate}T23:59:59.999+01:00`);
  const moves = (input.movements || [])
    .filter((m) => Number(m.treasuryAccountId ?? account.id) === Number(account.id))
    .filter((m) => {
      const t = Date.parse(m.postedAtISO);
      return t >= startMs && t <= endMs;
    })
    .sort((a, b) => String(a.postedAtISO).localeCompare(String(b.postedAtISO)) || String(a.id).localeCompare(String(b.id)));
  let balance = n(input.openingNgn);
  const days = [];
  const byDay = new Map();
  for (const m of moves) {
    const d = lagosDate(m.postedAtISO);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(m);
  }
  const statement = input.statementClosings || {};
  let totalIn = 0;
  let totalOut = 0;
  let totalCharges = 0;
  for (const [date, list] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const opening = balance;
    const lines = [];
    let dayIn = 0;
    let dayOut = 0;
    let charges = 0;
    const chargeIds = [];
    for (const m of list) {
      const amt = n(m.amountNgn);
      if (isBankCharge(m, ctx)) {
        charges += -amt;
        chargeIds.push(m.id);
        continue;
      }
      balance = r2(balance + amt);
      if (amt >= 0) dayIn += amt;
      else dayOut += -amt;
      lines.push({
        movementId: m.id,
        postedAtISO: m.postedAtISO,
        ref: cashBookRef(m, ctx),
        description: describe(m, ctx),
        crNgn: amt >= 0 ? amt : '',
        drNgn: amt < 0 ? -amt : '',
        balanceNgn: balance,
        remark: remark(m, ctx),
        type: m.type,
        sourceId: m.sourceId || '',
      });
    }
    charges = r2(charges);
    balance = r2(balance - charges);
    const stmt = statement[date];
    days.push({
      date,
      openingNgn: opening,
      lines,
      totalInNgn: r2(dayIn),
      totalOutNgn: r2(dayOut),
      bankChargesNgn: charges,
      bankChargeMovementIds: chargeIds,
      closingNgn: balance,
      statementCloseNgn: stmt == null ? null : n(stmt),
      diffNgn: stmt == null ? null : r2(balance - n(stmt)),
    });
    totalIn += dayIn;
    totalOut += dayOut;
    totalCharges += charges;
  }
  return {
    account: { id: account.id, name: account.name || '', bankName: account.bankName || '', accNo: account.accNo || '' },
    branchName: input.branchName || '',
    startDate,
    endDate,
    endAtISO: endAtISO || '',
    openingNgn: n(input.openingNgn),
    closingNgn: balance,
    totalInNgn: r2(totalIn),
    totalOutNgn: r2(totalOut),
    bankChargesNgn: r2(totalCharges),
    days,
    hasStatement: days.some((d) => d.statementCloseNgn != null),
  };
}

/** Flat rows in print order: Balance b/f, then per day: lines, Total, BC, Closing balance. */
export function cashBookRows(book) {
  const rows = [{ kind: 'bf', date: book.startDate, ref: '', description: `Balance b/f — ${book.account.name}${book.account.bankName ? ` (${book.account.bankName})` : ''}`, crNgn: '', drNgn: '', balanceNgn: book.openingNgn, remark: '' }];
  for (const d of book.days) {
    d.lines.forEach((l, i) => rows.push({ kind: 'line', date: i === 0 ? d.date : '', ...l }));
    if (!d.lines.length) rows.push({ kind: 'line', date: d.date, ref: '', description: '(bank charges only)', crNgn: '', drNgn: '', balanceNgn: d.openingNgn, remark: '' });
    rows.push({ kind: 'total', date: '', ref: '', description: `Total for ${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, crNgn: d.totalInNgn, drNgn: d.totalOutNgn, balanceNgn: '', remark: '' });
    rows.push({ kind: 'bc', date: '', ref: 'BC', description: 'Bank charges (stamp duty, VAT, transfer & POS fees)', crNgn: '', drNgn: d.bankChargesNgn || '', balanceNgn: r2(d.closingNgn), remark: d.bankChargesNgn ? 'One line per day' : 'No charges recorded' });
    rows.push({
      kind: 'closing',
      date: '',
      ref: '',
      description: `Closing balance ${d.date.slice(8, 10)}/${d.date.slice(5, 7)}/${d.date.slice(0, 4)}`,
      crNgn: '',
      drNgn: '',
      balanceNgn: d.closingNgn,
      remark: d.statementCloseNgn == null ? '' : d.diffNgn === 0 ? 'Equals statement ✔' : `Statement ${d.statementCloseNgn} — differs`,
      statementCloseNgn: d.statementCloseNgn,
      diffNgn: d.diffNgn,
    });
  }
  return rows;
}
