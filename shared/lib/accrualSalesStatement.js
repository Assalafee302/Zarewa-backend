/**
 * Accrual sales statement (Reports round 2, sales split part 2) — one page + exceptions, no receipt lines.
 * Pure: `buildSalesAccrual` output (+ the period's treasury and ledger for the credit-receipt exceptions) in →
 * statement figures and a `renderReportDocument` payload out.
 *
 *   Goods produced in period at quotation value, by category
 *   − value-reducing refunds on those quotations
 *   = net sales (goods produced, net value)            ← accrual.producedNgn
 *   customer advances and debts, start → end
 *   bridge: cash received − refunds paid ± … + Δdebts − Δadvances = net sales (difference ₦0)
 *   exceptions: credit receipts with treasury lines (phantom cash), refunds above the quotation value,
 *   double-counted advances, 0 m jobs, cash/refunds with no customer, unchanged balances ≥ ₦50,000.
 *
 * Category of a quotation = its first product line (e.g. "Roofing Sheet"), "Stone flat sheet", or
 * "Accessories only" — quotation lines carry no prices, so the whole quotation value goes to that category.
 */
import { ACCRUAL_SMALL_ITEM_NGN, creditApplicationReceipts } from './salesAccrualCore.js';

export const ACCRUAL_STATEMENT_TITLE = 'Accrual sales statement';

export const ACCRUAL_STATEMENT_NOTE =
  'Sales are counted when production is completed (goods made to the customer’s order become theirs), not when ' +
  'money arrives. Net sales = value of the quotations produced in the period, less refunds that reduce what was ' +
  'sold (unproduced metres, services not given). The bridge shows how cash received in the period turns into net ' +
  'sales: money for goods not yet made sits in customer advances; goods made but not fully paid sit in customer ' +
  'debts. So cash received and net sales are different figures, and the bridge must close to ₦0.';

const day = (v) => String(v || '').slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);

function categoryByQuotation(quotationLines = []) {
  const out = new Map();
  const accessoriesOnly = new Set();
  for (const l of quotationLines) {
    const qid = String(l.quotationId || '').trim();
    const name = String(l.name || '').trim();
    if (!qid || !name || !(Number(l.qty) > 0)) continue;
    if (l.category === 'products' && !out.has(qid)) out.set(qid, /^stone\s*flat\s*sheet/i.test(name) ? 'Stone flat sheet' : name);
    if (l.category === 'accessories') accessoriesOnly.add(qid);
  }
  return (qid) => out.get(qid) || (accessoriesOnly.has(qid) ? 'Accessories only' : 'No product line');
}

/** Bridge lines, cash received → net sales, ending with the difference (expected ₦0). */
export function accrualStatementBridgeLines(accrual) {
  const b = accrual.bridge;
  const lines = [
    { item: 'Cash received in period (treasury; credit applications excluded)', amountNgn: b.cashReceivedNgn },
    { item: 'Less: refunds paid in period', amountNgn: -b.refundsPaidNgn },
  ];
  if (b.cashNotAttributableNgn) lines.push({ item: 'Less: cash not attributable to a customer (exceptions)', amountNgn: -b.cashNotAttributableNgn });
  if (b.refundsNotAttributableNgn) lines.push({ item: 'Add back: refunds with no customer (exceptions)', amountNgn: b.refundsNotAttributableNgn });
  lines.push(
    { item: 'Add: increase in customer debts', amountNgn: b.increaseInDebtsNgn },
    { item: 'Less: increase in customer advances', amountNgn: -b.increaseInAdvancesNgn },
    { item: '= Net sales by the bridge', amountNgn: b.bridgeTotalNgn, strong: true },
    { item: 'Net sales (goods produced, net value)', amountNgn: b.producedNgn },
    { item: 'Difference (must be ₦0)', amountNgn: b.differenceNgn, strong: true, severity: b.differenceNgn ? 'exception' : '' }
  );
  return lines;
}

/**
 * @param {ReturnType<import('./salesAccrualCore.js').buildSalesAccrual>} accrual
 * @param {{ quotationLines?: object[], ledgerEntries?: object[], treasuryMovements?: object[] }} [src]
 */
export function buildAccrualSalesStatement(accrual, src = {}) {
  const inPeriod = (d) => d >= accrual.startDate && d <= accrual.endDate;
  const catOf = categoryByQuotation(src.quotationLines || []);
  const byCat = new Map();
  for (const r of accrual.producedRows) {
    const net = r.valueInPeriodNgn;
    const value = r.quoteTotalNgn - r.valueReducingRefundsNgn;
    // Pro-rated rows: gross and refunds in the same proportion as the net value in the period.
    const gross = value > 0 ? Math.round((net * r.quoteTotalNgn) / value) : net;
    const cat = catOf(r.quotationRef);
    const c = byCat.get(cat) || { category: cat, quotationCount: 0, grossNgn: 0, valueReducingRefundsNgn: 0, netNgn: 0 };
    c.quotationCount += 1;
    c.grossNgn += gross;
    c.valueReducingRefundsNgn += gross - net;
    c.netNgn += net;
    byCat.set(cat, c);
  }
  const categories = [...byCat.values()].sort((a, b) => b.netNgn - a.netNgn || a.category.localeCompare(b.category));
  const gross = categories.reduce((s, c) => s + c.grossNgn, 0);
  const refunds = categories.reduce((s, c) => s + c.valueReducingRefundsNgn, 0);

  // Credit receipts (₦0 ledger receipts) whose treasury lines would have looked like cash.
  const credit = creditApplicationReceipts(src.ledgerEntries || []);
  const phantom = new Map();
  for (const t of src.treasuryMovements || []) {
    if (String(t.sourceKind || '') !== 'LEDGER_RECEIPT' || !inPeriod(day(t.postedAtISO))) continue;
    const c = credit.get(String(t.sourceId || '').trim());
    if (!c || !ngn(t.amountNgn)) continue;
    const row = phantom.get(c.ledgerEntryId) || { ...c, treasuryMovementIds: [], leftOutNgn: 0, postedInNgn: 0 };
    row.treasuryMovementIds.push(String(t.id));
    row.leftOutNgn += ngn(t.amountNgn);
    if (ngn(t.amountNgn) > 0) row.postedInNgn += ngn(t.amountNgn);
    phantom.set(c.ledgerEntryId, row);
  }
  const e = accrual.exceptions;
  const exceptions = [
    ...[...phantom.values()].map((p) => ({
      kind: 'Credit receipt with treasury cash lines (left out of cash)',
      ref: p.ledgerEntryId, ref2: p.treasuryMovementIds.join(', '), customerName: p.customerName, dateISO: p.dateISO, amountNgn: p.postedInNgn,
      note: `Credit ${p.creditEntryIds.join(', ') || '—'} on ${p.quotationRef}; posted as cash ${p.postedInNgn}, ${p.leftOutNgn ? `net ${p.leftOutNgn} still in treasury` : 'reversed to nil'}`,
      severity: p.leftOutNgn ? 'exception' : 'review',
    })),
    ...e.refundsOverValue.map((x) => ({
      kind: x.kind, ref: x.quotationRef, ref2: '', customerName: x.customerName, dateISO: '', amountNgn: x.amountNgn,
      note: `Quote total ${x.quoteTotalNgn}; value-reducing refunds ${x.valueReducingRefundsNgn}`, severity: 'exception',
    })),
    ...e.doubleCountedAdvances.map((x) => ({
      kind: x.kind, ref: x.treasuryMovementId, ref2: x.ledgerEntryId, customerName: x.customerName, dateISO: x.dateISO, amountNgn: x.amountNgn,
      note: `Same money as ${x.advanceMovementId} (${x.advanceDateISO}). ${x.verification}`, severity: 'exception',
    })),
    ...e.zeroMetreJobs.map((x) => ({
      kind: x.kind, ref: x.jobID, ref2: x.quotationRef, customerName: x.customerName, dateISO: x.dateISO, amountNgn: x.amountNgn, note: x.note, severity: 'exception',
    })),
    ...e.unassignedCash.map((x) => ({
      kind: x.kind, ref: x.treasuryMovementId, ref2: x.ledgerEntryId, customerName: x.counterpartyName, dateISO: x.dateISO, amountNgn: x.amountNgn,
      note: 'Left out of customer balances', severity: 'exception',
    })),
    ...e.unassignedRefunds.map((x) => ({
      kind: x.kind, ref: x.treasuryMovementId, ref2: x.ledgerEntryId, customerName: x.counterpartyName, dateISO: x.dateISO, amountNgn: x.amountNgn,
      note: 'Left out of customer balances', severity: 'exception',
    })),
    ...e.staleBalances.map((x) => ({
      kind: x.kind, ref: x.customerID, ref2: '', customerName: x.customerName, dateISO: '', amountNgn: x.amountNgn, note: x.note, severity: 'review',
    })),
  ];
  return {
    startDate: accrual.startDate,
    endDate: accrual.endDate,
    openingDate: accrual.openingDate,
    categories,
    grossNgn: gross,
    valueReducingRefundsNgn: refunds,
    netSalesNgn: accrual.producedNgn,
    categoriesTieNgn: gross - refunds - accrual.producedNgn,
    refundsPaidInPeriodNgn: accrual.bridge.refundsPaidNgn,
    balances: accrual.balances,
    bridgeLines: accrualStatementBridgeLines(accrual),
    bridgeDifferenceNgn: accrual.bridge.differenceNgn,
    exceptions,
    smallStale: e.staleSmall || { count: 0, amountNgn: 0 },
  };
}

/** One page: summary box = the statement; exceptions after it. */
export function accrualSalesStatementDocument(st, opts = {}) {
  const d = (iso) => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const b = st.balances;
  const rows = [
    { label: 'Goods produced in period, at quotation value', value: st.grossNgn, strong: true },
    ...st.categories.map((c) => ({ label: `      ${c.category} (${c.quotationCount} quotation(s))`, value: c.grossNgn })),
    { label: 'Less: value-reducing refunds on those quotations', value: -st.valueReducingRefundsNgn },
    { label: '= Net sales (goods produced, net value)', value: st.netSalesNgn, strong: true },
    { label: 'Memo: refunds paid in period (cash, all quotations)', value: st.refundsPaidInPeriodNgn },
    { label: `Customer advances ${d(st.openingDate)} → ${d(st.endDate)}`, value: `${b.opening.advancesNgn.toLocaleString('en-NG')} → ${b.closing.advancesNgn.toLocaleString('en-NG')}`, kind: 'text' },
    { label: `Customer debts ${d(st.openingDate)} → ${d(st.endDate)}`, value: `${b.opening.debtsNgn.toLocaleString('en-NG')} → ${b.closing.debtsNgn.toLocaleString('en-NG')}`, kind: 'text' },
    ...st.bridgeLines.map((l) => ({ label: `Bridge: ${l.item}`, value: l.amountNgn, strong: l.strong, severity: l.severity })),
  ];
  return {
    title: ACCRUAL_STATEMENT_TITLE,
    branchName: opts.branchName || '',
    startDate: st.startDate,
    endDate: st.endDate,
    summary: { rows },
    note: ACCRUAL_STATEMENT_NOTE,
    exceptionSections: [
      {
        title: 'Exceptions',
        columns: [
          { key: 'kind', label: 'Exception' },
          { key: 'ref', label: 'Id', kind: 'id' },
          { key: 'ref2', label: 'Related id', kind: 'id' },
          { key: 'customerName', label: 'Customer' },
          { key: 'dateISO', label: 'Date', kind: 'date' },
          { key: 'amountNgn', label: '₦', kind: 'money' },
          { key: 'note', label: 'Remarks', kind: 'remarks' },
        ],
        rows: [
          ...st.exceptions.map((x) => ({ ...x, _severity: x.severity })),
          ...(st.smallStale.count
            ? [{ kind: `${st.smallStale.count} unchanged balance(s), each under ₦${ACCRUAL_SMALL_ITEM_NGN.toLocaleString('en-NG')}`, amountNgn: st.smallStale.amountNgn, note: 'Counted, not listed (see Excel)' }]
            : []),
        ],
        emptyText: 'No exceptions.',
      },
    ],
    sections: [],
    signOff: { preparedBy: opts.preparedBy, preparedAtISO: opts.preparedAtISO },
  };
}

export function accrualSalesStatementExcelSheets(st, accrual) {
  return [
    { name: 'Statement', rows: accrualSalesStatementDocument(st).summary.rows.map((r) => ({ item: r.label.trim(), value: r.value })) },
    { name: 'By_category', rows: st.categories },
    { name: 'Produced_by_quotation', rows: accrual.producedRows.map((r) => ({ ...r, jobIDs: r.jobIDs.join(', ') })) },
    { name: 'Customer_balances', rows: accrual.balances.rows },
    { name: 'Bridge', rows: st.bridgeLines },
    { name: 'Exceptions', rows: st.exceptions },
  ];
}
