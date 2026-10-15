/**
 * Accrual section of the sales report (Reports Phase 1). Pure: source rows in → figures, rows, exceptions out.
 *
 * Basis (owner decision 2026-10-14):
 * - A sale is recognised when production completes (job completedAt). A quotation split across periods is
 *   pro-rated by the metres of each completed job (effective metres when actual is 0).
 * - Value of a completed quotation = total − value-reducing refunds. A refund is valued at the amount PAID OUT.
 *   Pure "Overpayment" refunds never reduce value; for mixed-reason refunds only the part above the quote's
 *   overpayment counts. Overpayment = cash that stayed on the quote (receipts net of reversals, plus applied
 *   advances/overpayments) − quote total.
 * - A completed job with 0 actual metres and 0 kg is a sale when the quotation is accessory-only or piece-only
 *   (stone flat sheets). It is NOT a sale when the quotation has a metre-based product line, or has no
 *   identifiable product/accessory line at all; those are listed as exceptions.
 * - Customer balance = cash received − refunds paid out − value produced (from treasury, by posting date).
 *   > 0 is an advance, < 0 is a debt.
 * - Cash excludes: treasury lines of zero-amount ledger receipts (credit applications — see
 *   `creditApplicationReceipts`) that no bank-statement line names (`creditLineLeftOutOfCash`), receipt and advance reversals (they reduce cash), and RECEIPT_IN lines that re-post an
 *   unconsumed earlier ADVANCE_IN of the same customer with no matching bank-statement inflow (double-counted
 *   advance applications; "unverified" when bank recon does not cover the date). Treasury lines with no
 *   customer are left out of balances and listed.
 * - Sales bridge: cash received − refunds paid − cash not attributable to customers + Δdebts − Δadvances
 *   = goods produced (net). Difference must be ₦0.
 */

const CASH_TYPES = new Set(['RECEIPT_IN', 'ADVANCE_IN', 'RECEIPT_REVERSAL_OUT', 'ADVANCE_REVERSAL_OUT']);

export const ACCRUAL_EXCEPTION_ZERO_METRE = 'Completed job with 0 m — not a sale';
export const ACCRUAL_EXCEPTION_REFUND_OVER_VALUE = 'Refunds bigger than the quotation value';
export const ACCRUAL_EXCEPTION_DOUBLE_COUNTED_ADVANCE = 'Double-counted advance application';
export const ACCRUAL_EXCEPTION_UNASSIGNED_CASH = 'Treasury receipt with no customer';
export const ACCRUAL_EXCEPTION_UNASSIGNED_REFUND = 'Refund payout with no customer';
export const ACCRUAL_EXCEPTION_STALE = 'Balance unchanged in the period';
/** Exceptions under this amount are counted in one line, not listed (round 2, L10). */
export const ACCRUAL_SMALL_ITEM_NGN = 50_000;

const day = (v) => String(v || '').slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);

function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Refund reason labels from an array, a JSON string or "a, b" text. */
export function refundReasonList(refund) {
  const raw = refund?.reasonCategories ?? refund?.reasonCategory ?? refund?.reason_category ?? [];
  if (Array.isArray(raw)) return raw.map((s) => String(s || '').trim()).filter(Boolean);
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s || '').trim()).filter(Boolean);
  } catch {
    /* plain text */
  }
  return text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Zero-amount ledger receipts are credit applications (refund fund / overpayment applied), not cash: the money
 * is the same-day OVERPAY_APPLIED / ADVANCE_APPLIED entry on the same quotation. Some of them also carry
 * treasury RECEIPT_IN lines (no bank link; most reversed later). Those lines are left out of cash.
 * @returns {Map<string, {ledgerEntryId: string, dateISO: string, customerID: string, customerName: string,
 *   quotationRef: string, method: string, creditAppliedNgn: number, creditEntryIds: string[]}>}
 */
export function creditApplicationReceipts(ledgerEntries = []) {
  const credits = new Map();
  for (const e of ledgerEntries) {
    if (e.type !== 'OVERPAY_APPLIED' && e.type !== 'ADVANCE_APPLIED') continue;
    const k = `${String(e.quotationRef || '').trim()}|${day(e.atISO)}`;
    const list = credits.get(k) || [];
    list.push(e);
    credits.set(k, list);
  }
  const out = new Map();
  for (const e of ledgerEntries) {
    if (e.type !== 'RECEIPT' || ngn(e.amountNgn) !== 0) continue;
    const id = String(e.id || '').trim();
    if (!id) continue;
    const quotationRef = String(e.quotationRef || '').trim();
    const applied = credits.get(`${quotationRef}|${day(e.atISO)}`) || [];
    out.set(id, {
      ledgerEntryId: id,
      dateISO: day(e.atISO),
      customerID: String(e.customerID || '').trim(),
      customerName: e.customerName || '',
      quotationRef,
      method: String(e.paymentMethod || '').trim(),
      creditAppliedNgn: applied.reduce((s, x) => s + Math.abs(ngn(x.amountNgn)), 0),
      creditEntryIds: applied.map((x) => String(x.id)),
    });
  }
  return out;
}

/** Treasury movement ids named by any bank-statement line (bank recon `systemMatch`). */
export function bankLinkedMovementIds(bankRecon = []) {
  const ids = new Set();
  for (const b of bankRecon || []) {
    for (const m of String(b?.systemMatch || '').matchAll(/TM-[A-Z]{2,4}-\d{2}-\d+/gi)) ids.add(m[0].toUpperCase());
  }
  return ids;
}

/**
 * A treasury line of a zero-amount (credit) ledger receipt is left out of cash — unless a bank-statement line
 * names it: then the money did reach the bank and it stays in cash (owner, 2026-10-15; e.g. Farouq TM-KD-26-2178
 * once linked to MP-0348).
 */
export function creditLineLeftOutOfCash(t, creditReceipts, bankLinked) {
  if (String(t?.sourceKind || '') !== 'LEDGER_RECEIPT') return false;
  if (!creditReceipts.has(String(t?.sourceId || '').trim())) return false;
  return !bankLinked.has(String(t?.id || '').toUpperCase());
}

/** No stated reason is treated like "Overpayment": it does not reduce the quotation value. */
const isPureOverpayment = (refund) => refundReasonList(refund).every((r) => /^overpayment$/i.test(r));

/**
 * Quotation lines as flat rows: accepts `quotationLines` [{quotationId, category, name, qty}] or quotations
 * carrying `quotationLines: { products, accessories, services }`.
 */
function flatQuotationLines(quotationLines, quotations) {
  if (Array.isArray(quotationLines) && quotationLines.length) return quotationLines;
  const out = [];
  for (const q of quotations || []) {
    const groups = q?.quotationLines;
    if (!groups || Array.isArray(groups)) continue;
    for (const category of ['products', 'accessories', 'services']) {
      for (const line of groups[category] || []) {
        out.push({ quotationId: q.id, category, name: line?.name, qty: line?.qty });
      }
    }
  }
  return out;
}

/**
 * Completed jobs that are sales, per quotation, up to `endDate` (owner rules 2026-10-14). A completed job with 0 m
 * and 0 kg is a sale only for accessory-only / piece-only quotations; otherwise it is listed as an exception.
 * Shared by the accrual statement and the receipts register so "produced" means the same in both.
 * @returns {{ jobsByQuote: Map<string, {jobID: string, date: string, metres: number}[]>, zeroMetreJobs: object[] }}
 */
export function saleJobsByQuotation({ productionJobs = [], quotations = [], quotationLines, endDate = '' }) {
  const quoteById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metreBased = new Set();
  const identifiable = new Set();
  for (const l of flatQuotationLines(quotationLines, quotations)) {
    const name = String(l.name || '').trim();
    if (!name || !(Number(l.qty) > 0) || l.category === 'services') continue;
    const qid = String(l.quotationId || '').trim();
    identifiable.add(qid);
    if (l.category === 'products' && !/^stone\s*flat\s*sheet/i.test(name)) metreBased.add(qid);
  }
  const zeroMetreJobs = [];
  const jobsByQuote = new Map();
  for (const j of productionJobs) {
    if (String(j.status || '').trim() !== 'Completed') continue;
    const date = day(j.completedAtISO || j.endDateISO);
    if (!date || (endDate && date > endDate)) continue;
    const qref = String(j.quotationRef || '').trim();
    const actual = Number(j.actualMeters) || 0;
    const effective = Number(j.effectiveOutputMeters) || 0;
    const kg = Number(j.actualWeightKg) || 0;
    let metres = actual;
    if (!actual && !kg) {
      if (effective > 0) metres = effective;
      else if (metreBased.has(qref) || !identifiable.has(qref)) {
        zeroMetreJobs.push({
          kind: ACCRUAL_EXCEPTION_ZERO_METRE,
          jobID: j.jobID,
          quotationRef: qref,
          customerName: j.customerName || quoteById.get(qref)?.customer || '',
          dateISO: date,
          amountNgn: ngn(quoteById.get(qref)?.totalNgn),
          note: metreBased.has(qref)
            ? 'Quotation has metre-based lines, 0 m cut'
            : 'No identifiable product/accessory lines on the quotation',
        });
        continue;
      }
    }
    const list = jobsByQuote.get(qref) || [];
    list.push({ jobID: j.jobID, date, metres });
    jobsByQuote.set(qref, list);
  }
  return { jobsByQuote, zeroMetreJobs };
}

/**
 * @param {object} input
 * @param {object[]} input.quotations
 * @param {object[]} [input.quotationLines]
 * @param {object[]} input.productionJobs
 * @param {object[]} input.ledgerEntries
 * @param {object[]} input.treasuryMovements — full history up to period end (not only the period)
 * @param {object[]} input.refunds
 * @param {object[]} [input.bankRecon]
 * @param {string} input.startDate
 * @param {string} input.endDate
 */
export function buildSalesAccrual(input = {}) {
  const {
    quotations = [],
    productionJobs = [],
    ledgerEntries = [],
    treasuryMovements = [],
    refunds = [],
    bankRecon = [],
    startDate = '',
    endDate = '',
  } = input;
  const openingDate = dayBefore(startDate);
  const inPeriod = (iso) => iso >= startDate && iso <= endDate;

  const quoteById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const ledgerById = new Map(ledgerEntries.map((e) => [String(e.id || '').trim(), e]));
  const refundById = new Map(refunds.map((r) => [String(r.refundID || r.id || '').trim(), r]));
  const customerName = new Map();
  for (const q of quotations) if (q.customerID && !customerName.has(q.customerID)) customerName.set(q.customerID, q.customer || q.customerName || '');
  for (const e of ledgerEntries) if (e.customerID && !customerName.has(e.customerID)) customerName.set(e.customerID, e.customerName || '');
  const nameOf = (id) => customerName.get(id) || '';

  // --- Customer cash lines ------------------------------------------------------------------------
  // Treasury lines of zero-amount ledger receipts are credit applications, not cash (owner, round 2 A1).
  const creditReceipts = creditApplicationReceipts(ledgerEntries);
  const bankLinked = bankLinkedMovementIds(bankRecon);
  const isCreditApplicationLine = (t) => creditLineLeftOutOfCash(t, creditReceipts, bankLinked);
  const cashLines = treasuryMovements
    .filter((t) => CASH_TYPES.has(t.type) && !isCreditApplicationLine(t))
    .map((t) => ({
      id: t.id,
      type: t.type,
      date: day(t.postedAtISO),
      amountNgn: ngn(t.amountNgn),
      customerID: String(ledgerById.get(String(t.sourceId || '').trim())?.customerID || '').trim(),
      sourceId: String(t.sourceId || ''),
      treasuryAccountId: t.treasuryAccountId,
      counterpartyName: t.counterpartyName || '',
    }))
    .filter((t) => !endDate || t.date <= endDate);

  // Double-counted advance applications: RECEIPT_IN equal to an unconsumed earlier ADVANCE_IN.
  const bankCoverage = new Map();
  const bankKeys = new Set();
  for (const b of bankRecon) {
    const acc = String(b.treasuryAccountId ?? '');
    const bd = day(b.bankDateISO);
    if (!bd) continue;
    const c = bankCoverage.get(acc) || { min: bd, max: bd };
    if (bd < c.min) c.min = bd;
    if (bd > c.max) c.max = bd;
    bankCoverage.set(acc, c);
    bankKeys.add(`${acc}|${bd}|${ngn(b.amountNgn)}`);
  }
  const appliedByCustomer = new Map();
  for (const e of ledgerEntries) {
    if (e.type !== 'ADVANCE_APPLIED' || !e.customerID) continue;
    const list = appliedByCustomer.get(e.customerID) || [];
    list.push({ date: day(e.atISO), amountNgn: Math.abs(ngn(e.amountNgn)) });
    appliedByCustomer.set(e.customerID, list);
  }
  const linesByCustomer = new Map();
  for (const t of cashLines) {
    if (!t.customerID) continue;
    const list = linesByCustomer.get(t.customerID) || [];
    list.push(t);
    linesByCustomer.set(t.customerID, list);
  }
  const doubleCounted = [];
  const excludedCashIds = new Set();
  for (const [customerID, lines] of linesByCustomer) {
    const events = [
      ...lines.filter((t) => t.type === 'ADVANCE_IN').map((t) => ({ order: 0, date: t.date, t })),
      ...lines.filter((t) => t.type === 'ADVANCE_REVERSAL_OUT').map((t) => ({ order: 1, date: t.date, t })),
      ...(appliedByCustomer.get(customerID) || []).map((a) => ({ order: 2, date: a.date, a })),
      ...lines.filter((t) => t.type === 'RECEIPT_IN').map((t) => ({ order: 3, date: t.date, t })),
    ].sort((x, y) => x.date.localeCompare(y.date) || x.order - y.order);
    const open = [];
    for (const ev of events) {
      if (ev.order === 0) {
        open.push({ id: ev.t.id, date: ev.date, amountNgn: ev.t.amountNgn, remaining: ev.t.amountNgn });
      } else if (ev.order === 1) {
        const i = open.findIndex((a) => a.remaining === Math.abs(ev.t.amountNgn));
        if (i >= 0) open.splice(i, 1);
      } else if (ev.order === 2) {
        let left = ev.a.amountNgn;
        for (const a of open) {
          const use = Math.min(left, a.remaining);
          a.remaining -= use;
          left -= use;
          if (!left) break;
        }
        for (let i = open.length - 1; i >= 0; i -= 1) if (!open[i].remaining) open.splice(i, 1);
      } else {
        const t = ev.t;
        const i = open.findIndex((a) => a.remaining === t.amountNgn && a.amountNgn === t.amountNgn);
        if (i < 0) continue;
        const acc = String(t.treasuryAccountId ?? '');
        const cov = bankCoverage.get(acc);
        let verification = 'Unverified — no bank recon for this date';
        if (cov && t.date >= cov.min && t.date <= cov.max) {
          if (bankKeys.has(`${acc}|${t.date}|${t.amountNgn}`)) continue; // real inflow on the statement
          verification = 'Confirmed — no matching bank inflow';
        }
        const adv = open.splice(i, 1)[0];
        excludedCashIds.add(t.id);
        doubleCounted.push({
          kind: ACCRUAL_EXCEPTION_DOUBLE_COUNTED_ADVANCE,
          customerID,
          customerName: nameOf(customerID),
          treasuryMovementId: t.id,
          ledgerEntryId: t.sourceId,
          dateISO: t.date,
          amountNgn: t.amountNgn,
          advanceMovementId: adv.id,
          advanceDateISO: adv.date,
          verification,
        });
      }
    }
  }

  const unassignedCash = [];
  const customerCash = [];
  for (const t of cashLines) {
    if (excludedCashIds.has(t.id)) continue;
    if (!t.customerID) {
      excludedCashIds.add(t.id);
      unassignedCash.push({
        kind: ACCRUAL_EXCEPTION_UNASSIGNED_CASH,
        treasuryMovementId: t.id,
        ledgerEntryId: t.sourceId,
        counterpartyName: t.counterpartyName,
        dateISO: t.date,
        amountNgn: t.amountNgn,
      });
      continue;
    }
    customerCash.push({ customerID: t.customerID, date: t.date, amountNgn: t.amountNgn });
  }

  // --- Refunds paid out (treasury) ------------------------------------------------------------
  const refundsPaid = [];
  const unassignedRefunds = [];
  for (const t of treasuryMovements) {
    if (t.type !== 'REFUND_PAYOUT') continue;
    const date = day(t.postedAtISO);
    if (endDate && date > endDate) continue;
    const customerID = String(refundById.get(String(t.sourceId || '').trim())?.customerID || '').trim();
    if (!customerID) {
      unassignedRefunds.push({
        kind: ACCRUAL_EXCEPTION_UNASSIGNED_REFUND,
        treasuryMovementId: t.id,
        ledgerEntryId: String(t.sourceId || ''),
        counterpartyName: t.counterpartyName || '',
        dateISO: date,
        amountNgn: ngn(t.amountNgn),
      });
      continue;
    }
    refundsPaid.push({ customerID, date, amountNgn: ngn(t.amountNgn) });
  }

  // --- Quotation value net of value-reducing refunds ------------------------------------------
  const stayedByQuote = new Map();
  const addStayed = (qref, amt) => {
    if (!qref) return;
    stayedByQuote.set(qref, (stayedByQuote.get(qref) || 0) + amt);
  };
  for (const t of treasuryMovements) {
    if (t.sourceKind !== 'LEDGER_RECEIPT' || (t.type !== 'RECEIPT_IN' && t.type !== 'RECEIPT_REVERSAL_OUT')) continue;
    if (isCreditApplicationLine(t)) continue; // the OVERPAY_APPLIED / ADVANCE_APPLIED entry below carries it
    addStayed(String(ledgerById.get(String(t.sourceId || '').trim())?.quotationRef || '').trim(), ngn(t.amountNgn));
  }
  for (const e of ledgerEntries) {
    if (e.type === 'ADVANCE_APPLIED' || e.type === 'OVERPAY_APPLIED') addStayed(String(e.quotationRef || '').trim(), Math.abs(ngn(e.amountNgn)));
  }
  const refundsByQuote = new Map();
  for (const r of refunds) {
    if (r.status === 'Rejected' || r.status === 'Cancelled') continue;
    const qref = String(r.quotationRef || '').trim();
    if (!qref) continue;
    const list = refundsByQuote.get(qref) || [];
    list.push(r);
    refundsByQuote.set(qref, list);
  }
  const valueReducingByQuote = new Map();
  const refundsOverValue = [];
  for (const [qref, list] of refundsByQuote) {
    const q = quoteById.get(qref);
    if (!q) continue;
    const total = ngn(q.totalNgn);
    let pool = Math.max(0, (stayedByQuote.get(qref) || 0) - total);
    list.sort((a, b) => day(a.requestedAtISO).localeCompare(day(b.requestedAtISO)));
    for (const r of list) if (isPureOverpayment(r)) pool -= ngn(r.paidAmountNgn);
    pool = Math.max(0, pool);
    let reducing = 0;
    for (const r of list) {
      if (isPureOverpayment(r)) continue;
      const paid = ngn(r.paidAmountNgn);
      if (refundReasonList(r).some((x) => /^overpayment$/i.test(x))) {
        const use = Math.min(pool, paid);
        pool -= use;
        reducing += paid - use;
      } else {
        reducing += paid;
      }
    }
    valueReducingByQuote.set(qref, reducing);
    if (reducing > total) {
      refundsOverValue.push({
        kind: ACCRUAL_EXCEPTION_REFUND_OVER_VALUE,
        quotationRef: qref,
        customerID: q.customerID,
        customerName: q.customer || nameOf(q.customerID),
        quoteTotalNgn: total,
        valueReducingRefundsNgn: reducing,
        amountNgn: reducing - total,
      });
    }
  }

  // --- Goods produced, per completed job ------------------------------------------------------
  const { jobsByQuote, zeroMetreJobs } = saleJobsByQuotation({
    productionJobs,
    quotations,
    quotationLines: input.quotationLines,
    endDate,
  });
  const producedLines = [];
  for (const [qref, jobs] of jobsByQuote) {
    const q = quoteById.get(qref);
    if (!q) continue;
    const quoteTotalNgn = ngn(q.totalNgn);
    const valueReducingRefundsNgn = valueReducingByQuote.get(qref) || 0;
    const value = quoteTotalNgn - valueReducingRefundsNgn;
    const totalMetres = jobs.reduce((s, x) => s + x.metres, 0);
    jobs.sort((a, b) => a.date.localeCompare(b.date) || String(a.jobID).localeCompare(String(b.jobID)));
    let left = value;
    jobs.forEach((x, i) => {
      const share =
        i === jobs.length - 1 ? left : Math.round(totalMetres ? (value * x.metres) / totalMetres : value / jobs.length);
      left -= share;
      producedLines.push({
        customerID: q.customerID,
        quotationRef: qref,
        jobID: x.jobID,
        date: x.date,
        metres: x.metres,
        amountNgn: share,
        quoteTotalNgn,
        valueReducingRefundsNgn,
        jobsOnQuote: jobs.length,
      });
    });
  }

  // --- Goods produced in period, by quotation -----------------------------------------------------
  const periodByQuote = new Map();
  for (const p of producedLines) {
    if (!inPeriod(p.date)) continue;
    const row = periodByQuote.get(p.quotationRef) || {
      quotationRef: p.quotationRef,
      customerID: p.customerID,
      customerName: nameOf(p.customerID),
      firstCompletedISO: p.date,
      jobIDs: [],
      metresInPeriod: 0,
      quoteTotalNgn: p.quoteTotalNgn,
      valueReducingRefundsNgn: p.valueReducingRefundsNgn,
      valueInPeriodNgn: 0,
      proRated: false,
    };
    row.jobIDs.push(p.jobID);
    row.metresInPeriod += p.metres;
    row.valueInPeriodNgn += p.amountNgn;
    if (p.date < row.firstCompletedISO) row.firstCompletedISO = p.date;
    periodByQuote.set(p.quotationRef, row);
  }
  for (const row of periodByQuote.values()) {
    row.proRated = row.valueInPeriodNgn !== row.quoteTotalNgn - row.valueReducingRefundsNgn;
  }
  const producedRows = [...periodByQuote.values()].sort(
    (a, b) => a.firstCompletedISO.localeCompare(b.firstCompletedISO) || a.quotationRef.localeCompare(b.quotationRef)
  );

  // --- Customer balances --------------------------------------------------------------------------
  const balances = new Map();
  const bucket = (id) => {
    if (!balances.has(id)) {
      balances.set(id, { customerID: id, customerName: nameOf(id), openingNgn: 0, cashNgn: 0, refundsPaidNgn: 0, producedNgn: 0, closingNgn: 0 });
    }
    return balances.get(id);
  };
  const post = (id, date, amt, field) => {
    const b = bucket(id);
    if (date <= openingDate) b.openingNgn += amt;
    else if (field) b[field] += field === 'producedNgn' || field === 'refundsPaidNgn' ? -amt : amt;
    b.closingNgn += amt;
  };
  for (const c of customerCash) post(c.customerID, c.date, c.amountNgn, 'cashNgn');
  for (const r of refundsPaid) post(r.customerID, r.date, r.amountNgn, 'refundsPaidNgn');
  for (const p of producedLines) post(p.customerID, p.date, -p.amountNgn, 'producedNgn');

  const balanceRows = [...balances.values()]
    .filter((b) => b.openingNgn || b.closingNgn || b.cashNgn || b.refundsPaidNgn || b.producedNgn)
    .map((b) => ({ ...b, unchanged: b.openingNgn === b.closingNgn && b.closingNgn !== 0 }))
    .sort((a, b) => Math.abs(b.closingNgn) - Math.abs(a.closingNgn) || a.customerID.localeCompare(b.customerID));

  const side = (field) => {
    let advances = 0;
    let debts = 0;
    for (const b of balanceRows) {
      if (b[field] > 0) advances += b[field];
      else debts -= b[field];
    }
    return { advancesNgn: advances, debtsNgn: debts };
  };
  const opening = side('openingNgn');
  const closing = side('closingNgn');
  const stale = balanceRows.filter((b) => b.unchanged);
  const staleSmall = stale.filter((b) => Math.abs(b.closingNgn) < ACCRUAL_SMALL_ITEM_NGN);
  const staleBalances = stale.filter((b) => Math.abs(b.closingNgn) >= ACCRUAL_SMALL_ITEM_NGN).map((b) => ({
    kind: ACCRUAL_EXCEPTION_STALE,
    customerID: b.customerID,
    customerName: b.customerName,
    amountNgn: b.closingNgn,
    note: b.closingNgn > 0 ? 'Advance' : 'Debt',
  }));

  // --- Sales bridge ---------------------------------------------------------------------------
  const sumIn = (list, dateKey = 'date') => list.filter((x) => inPeriod(x[dateKey])).reduce((s, x) => s + x.amountNgn, 0);
  const cashReceivedNgn = cashLines.filter((t) => inPeriod(t.date)).reduce((s, t) => s + t.amountNgn, 0);
  const refundsPaidNgn = -(sumIn(refundsPaid) + sumIn(unassignedRefunds, 'dateISO'));
  const cashNotAttributableNgn = cashLines
    .filter((t) => inPeriod(t.date) && excludedCashIds.has(t.id))
    .reduce((s, t) => s + t.amountNgn, 0);
  const refundsNotAttributableNgn = -sumIn(unassignedRefunds, 'dateISO') || 0;
  const increaseInDebtsNgn = closing.debtsNgn - opening.debtsNgn;
  const increaseInAdvancesNgn = closing.advancesNgn - opening.advancesNgn;
  const producedNgn = producedRows.reduce((s, r) => s + r.valueInPeriodNgn, 0);
  const bridgeTotal =
    cashReceivedNgn - refundsPaidNgn - cashNotAttributableNgn + refundsNotAttributableNgn + increaseInDebtsNgn - increaseInAdvancesNgn;
  const bridge = {
    cashReceivedNgn,
    refundsPaidNgn,
    cashNotAttributableNgn,
    refundsNotAttributableNgn,
    increaseInDebtsNgn,
    increaseInAdvancesNgn,
    adjustmentNgn: increaseInDebtsNgn - increaseInAdvancesNgn,
    bridgeTotalNgn: bridgeTotal,
    producedNgn,
    differenceNgn: bridgeTotal - producedNgn,
  };

  return {
    startDate,
    endDate,
    openingDate,
    producedNgn,
    producedRows,
    balances: {
      rows: balanceRows,
      opening,
      closing,
      staleAdvancesNgn: stale.filter((b) => b.closingNgn > 0).reduce((s, b) => s + b.closingNgn, 0),
      staleDebtsNgn: -stale.filter((b) => b.closingNgn < 0).reduce((s, b) => s + b.closingNgn, 0),
    },
    bridge,
    exceptions: {
      zeroMetreJobs: zeroMetreJobs.filter((x) => inPeriod(x.dateISO)),
      zeroMetreJobsAllTime: zeroMetreJobs,
      refundsOverValue,
      doubleCountedAdvances: doubleCounted,
      unassignedCash,
      unassignedRefunds,
      staleBalances,
      staleSmall: { count: staleSmall.length, amountNgn: staleSmall.reduce((s, b) => s + b.closingNgn, 0), customerIDs: staleSmall.map((b) => b.customerID) },
    },
  };
}
