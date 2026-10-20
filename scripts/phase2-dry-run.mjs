#!/usr/bin/env node
/**
 * Phase 2 data corrections — DRY RUN (no database, no writes).
 *
 * Builds the correction list (groups A–E), marks each READY or WAITING (+ who must confirm), and simulates the
 * READY corrections on in-memory copies of the Kaduna Sep 2026 report fixtures (ERP export of 13 Oct 2026) to
 * show their effect on the four reports' headline figures.
 *
 *   node scripts/phase2-dry-run.mjs [out.xlsx]
 *
 * Optional input: exports/phase2_preERP_coil_prices.csv (coilNo,unitCostNgnPerKg[,note]) — pre-ERP coil prices.
 *
 * How each READY item will be applied in step 2 (existing ERP mechanisms; correct, never delete):
 * - field corrections (coil cost / dates / gauge, job status, expense category, receipt status text):
 *   update the field + audit_log row (action "phase2.correction", details_json = before/after, reason, approver).
 * - treasury: a new RECEIPT_REVERSAL_OUT linked by reverses_movement_id (and a re-post on the right account for
 *   account moves), dated in the open period.
 * - fraud register: investigation_cases + investigation_links.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FE = path.resolve(BE, '../Zarewa-frontend-main');
const require = createRequire(path.join(BE, 'package.json'));
const XLSX = require('xlsx');
const imp = (p) => import(pathToFileURL(p).href);

const { buildCoilRegister } = await imp(path.join(BE, 'shared/lib/coilRegisterCore.js'));
const { buildSalesReport } = await imp(path.join(FE, 'src/lib/salesReportCore.js'));
const { headlines } = await imp(path.join(BE, 'scripts/lib/phase2Headlines.mjs'));
const { buildExpensesReport } = await imp(path.join(FE, 'src/lib/expensesReportCore.js'));

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const BASE = {
  purchase: load(path.join(BE, 'shared/lib/__fixtures__/kd-2026-09/purchaseRegisterSource.json')),
  material: load(path.join(BE, 'shared/lib/__fixtures__/kd-2026-09/materialRegisterSource.json')),
  sales: load(path.join(FE, 'src/lib/__fixtures__/kd-2026-09/salesReportSource.json')),
  expenses: load(path.join(FE, 'src/lib/__fixtures__/kd-2026-09/expensesReportSource.json')),
};
const TODAY = new Date().toISOString().slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);

// ---------------------------------------------------------------------------------------------
// Correction list
// ---------------------------------------------------------------------------------------------
const corrections = [];
let seq = 0;
const add = (c) => corrections.push({ id: `${c.group}${String(++seq).padStart(2, '0')}`, status: 'READY', confirm: '', ...c });
const coilOf = (fx, no) => fx.material.coilLots.find((c) => c.coilNo === no);
const setCoil = (no, patch) => (fx) => {
  for (const list of [fx.material.coilLots, fx.purchase.coilLots]) {
    const c = list.find((x) => x.coilNo === no);
    if (c) Object.assign(c, patch);
  }
};

const baseCoil = buildCoilRegister(BASE.material);

// A — coils ------------------------------------------------------------------------------------
for (const e of baseCoil.exceptions.costVsPurchase.filter((x) => x.boughtBy === 'metre' && Math.abs(x.differencePct) > 10)) {
  const waiting = e.coilNo === 'CL-26-2200';
  add({
    group: 'A',
    record: `coil ${e.coilNo} (${e.poID})`,
    field: 'coil_lots.unit_cost_ngn_per_kg',
    before: e.erpUnitCostNgnPerKg,
    after: Math.round(e.costPerKgReceivedNgn),
    reason: `Bought by metre (${e.boughtByRule}): cost/kg = amount paid ÷ kg received (${e.note}). Stored as a whole number.`,
    ...(waiting ? { status: 'WAITING', confirm: 'Storekeeper: real weight of CL-26-2200 (recorded 1 kg for 75.4 m)' } : {}),
    apply: waiting ? null : setCoil(e.coilNo, { unitCostNgnPerKg: Math.round(e.costPerKgReceivedNgn) }),
  });
}
const csvPath = path.join(BE, 'exports/phase2_preERP_coil_prices.csv');
const preErpPrices = new Map();
const preErpKept = [];
if (fs.existsSync(csvPath)) {
  const [head, ...lines] = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',').map((s) => s.trim());
  for (const line of lines) {
    const v = line.split(',');
    const row = Object.fromEntries(cols.map((c, i) => [c, (v[i] || '').trim()]));
    if (row.coilNo) preErpPrices.set(row.coilNo, row);
  }
  // CSV columns (owner): coilNo, mat, gaugeLabel, old_db_gauge, old_db_purchase_date, erp_cost_per_kg,
  // proposed_cost_per_kg, source. Blank proposal ("none") = no price evidence → ERP cost kept, no correction.
  for (const [no, row] of preErpPrices) {
    const c = coilOf(BASE, no);
    const proposed = String(row.proposed_cost_per_kg ?? row.unitCostNgnPerKg ?? '').trim();
    const source = row.source || row.note || '';
    if (!c) {
      add({ group: 'A', record: `coil ${no}`, field: 'coil_lots.unit_cost_ngn_per_kg', before: '(coil not found)', after: proposed || '—', reason: `Pre-ERP price (CSV): ${source}`, status: 'WAITING', confirm: 'Accounts: coil not found in the ERP', apply: null });
      continue;
    }
    if (!proposed) {
      if (/mismatch/i.test(source)) {
        // Material in doubt — the A item for CL-KD-APR-1969 already waits for the storekeeper.
        if (no !== 'CL-KD-APR-1969') add({ group: 'A', record: `coil ${no}`, field: 'coil_lots.unit_cost_ngn_per_kg', before: c.unitCostNgnPerKg, after: '?', reason: `Pre-ERP price (CSV): ${source}`, status: 'WAITING', confirm: 'Storekeeper: which coil is this', apply: null });
      } else {
        preErpKept.push(no);
      }
      continue;
    }
    const after = Math.round(Number(proposed));
    if (!(after > 0) || ngn(c.unitCostNgnPerKg) === after) continue;
    add({
      group: 'A',
      record: `coil ${no} (${row.mat || c.materialTypeName} ${row.gaugeLabel || c.gaugeLabel})`,
      field: 'coil_lots.unit_cost_ngn_per_kg',
      before: c.unitCostNgnPerKg || '(none)',
      after,
      reason: `Pre-ERP price (owner CSV): ${source}${row.old_db_purchase_date ? `, old DB ${row.old_db_gauge} bought ${row.old_db_purchase_date}` : ''}`,
      apply: setCoil(no, { unitCostNgnPerKg: after }),
    });
  }
} else {
  add({ group: 'A', record: 'pre-ERP coils (opening stock)', field: 'coil_lots.unit_cost_ngn_per_kg', before: '—', after: '—', reason: 'exports/phase2_preERP_coil_prices.csv not found — re-run the dry run when it is in place', status: 'WAITING', confirm: 'Owner / accounts: provide the CSV', apply: null });
}
for (const e of baseCoil.exceptions.noUnitCost) {
  if (preErpPrices.has(e.coilNo)) continue;
  add({
    group: 'A',
    record: `coil ${e.coilNo}`,
    field: 'coil_lots.unit_cost_ngn_per_kg',
    before: '(none)',
    after: e.unitCostNgnPerKg,
    reason: `Uncosted opening coil — ${e.costSource} (owner-approved 14 Oct)`,
    apply: setCoil(e.coilNo, { unitCostNgnPerKg: e.unitCostNgnPerKg }),
  });
}
add({
  group: 'A',
  record: 'coil CL-26-2096 (PO-KD-26-0078)',
  field: 'coil_lots.received_at_iso + STORE_GRN movement date',
  before: '2026-10-12',
  after: '2026-09-12',
  reason: 'Delivered 12 Sep with PO-0078, booked 12 Oct (owner)',
  apply: (fx) => {
    setCoil('CL-26-2096', { receivedAtISO: '2026-09-12' })(fx);
    for (const m of fx.material.stockMovements) {
      if (m.type === 'STORE_GRN' && String(m.detail).includes('CL-26-2096')) Object.assign(m, { dateISO: '2026-09-12', atISO: '2026-09-12T12:00:00' });
    }
    fx.material.receivedDateCorrections = [];
  },
});
add({
  group: 'A',
  record: 'coil CL-26-2082 (PO-KD-26-0070)',
  field: 'STORE_GRN movement date',
  before: '2026-09-01',
  after: '2026-08-31',
  reason: 'In the store on 31 Aug (owner, 14 Oct): same PO-0070 delivery as CL-26-2083, received 31 Aug, Dechimex liability in 31 Aug creditors; GRN simply posted 1 Sep. Expected: 31 Aug stock 65 coils, +2,081 kg, +₦13,942,700',
  apply: (fx) => {
    for (const m of fx.material.stockMovements) {
      if (m.type === 'STORE_GRN' && String(m.detail).includes('CL-26-2082')) Object.assign(m, { dateISO: '2026-08-31', atISO: '2026-08-31T12:00:00' });
    }
  },
});
add({ group: 'A', record: 'coil CL-26-2065 (PO-KD-26-0056)', field: 'coil_lots.gauge_label', before: '0.28mm', after: '0.24mm', reason: 'Weight 3,374 kg is exactly the 0.24 mm PO line received', apply: setCoil('CL-26-2065', { gaugeLabel: '0.24mm' }) });
add({ group: 'A', record: 'coil CL-KD-APR-1969', field: 'coil_lots.material_type', before: `${coilOf(BASE, 'CL-KD-APR-1969')?.materialTypeName || '?'} ${coilOf(BASE, 'CL-KD-APR-1969')?.gaugeLabel || ''}`, after: '?', reason: 'Material in doubt', status: 'WAITING', confirm: 'Storekeeper: material of CL-KD-APR-1969', apply: null });

// B — jobs -------------------------------------------------------------------------------------
const cancelJob = (jobID) => (fx) => {
  for (const list of [fx.sales.productionJobs, fx.material.productionJobs]) {
    const j = list.find((x) => x.jobID === jobID);
    if (j) j.status = 'Cancelled';
  }
};
add({ group: 'B', record: 'job PRO-KD-26-1349 (QT-KD-26-1643)', field: 'production_jobs.status', before: 'Completed (0 m, 0 kg)', after: 'Cancelled', reason: 'Completed with 0 metres on a quotation with no identifiable lines — not a sale', apply: cancelJob('PRO-KD-26-1349') });
add({ group: 'B', record: 'job PRO-KD-26-1272 (QT-KD-26-1558)', field: 'production_jobs.status', before: 'Completed (0 m, 0 kg)', after: 'Cancelled', reason: 'Completed with 0 metres on a quotation with no identifiable lines — not a sale', apply: cancelJob('PRO-KD-26-1272') });
for (const q of ['QT-KD-26-1522', 'QT-KD-26-1681', 'QT-KD-26-1544', 'QT-KD-26-1668']) {
  add({ group: 'B', record: q, field: 'ledger credit applied (OVERPAY/ADVANCE_APPLIED)', before: 'credit on top of cash', after: 'reverse the extra credit', reason: 'Covered above quotation value + own overpayment', status: 'WAITING', confirm: 'Sales: confirm the credit was applied twice', apply: null });
}

// C — cash / receipts --------------------------------------------------------------------------
add({
  group: 'C',
  record: 'treasury TM-KD-26-1499 (LE-KD-26-1154, Mal Sani)',
  field: 'new RECEIPT_REVERSAL_OUT linked to TM-KD-26-1499',
  before: 'RECEIPT_IN ₦1,500,000 (16 Jul)',
  after: `reversal −₦1,500,000 dated ${TODAY}`,
  reason: 'Re-post of the 25 Jun ADVANCE_IN (TM-KD-26-1147) when it was applied — same money counted twice',
  apply: null, // dated in the open period: no September figure moves
});
const baseSales = buildSalesReport({ ...BASE.sales, accrualTreasuryMovements: BASE.sales.treasuryMovements });
const reconByTm = new Map();
for (const b of BASE.sales.bankRecon || []) {
  for (const m of String(b.systemMatch || '').matchAll(/TM-[A-Z]{2,4}-\d{2}-\d+/gi)) reconByTm.set(m[0].toUpperCase(), b);
}
const accountName = new Map((BASE.sales.treasuryAccounts || []).map((a) => [String(a.id), a.name]));
const checkLines = baseSales.recognisedRows.flatMap((r) =>
  r.paymentLines.filter((l) => l.type === 'RECEIPT_IN' && l.check).map((l) => ({ r, l }))
);
for (const { r, l } of checkLines) {
  const recon = reconByTm.get(String(l.treasuryMovementId).toUpperCase());
  const tm = BASE.sales.treasuryMovements.find((t) => t.id === l.treasuryMovementId);
  const reconAccount = recon ? accountName.get(String(recon.treasuryAccountId)) || String(recon.treasuryAccountId) : '';
  if (recon && String(recon.treasuryAccountId) !== String(tm?.treasuryAccountId)) {
    add({ group: 'C', record: `${l.treasuryMovementId} (${r.ledgerEntryId}, ${r.customerName})`, field: 'treasury account', before: l.accountName, after: reconAccount, reason: `Bank recon ${recon.id} shows the money on ${reconAccount}; reverse and re-post (open period)`, apply: null });
  } else if (recon) {
    add({ group: 'C', record: `receipt ${r.ledgerEntryId} (${r.customerName})`, field: 'sales_receipts.method (text)', before: r.paymentMethod, after: `Bank — ${l.accountName}`, reason: `Bank recon ${recon.id} confirms the treasury account; the method text is wrong`, apply: null });
  } else {
    add({ group: 'C', record: `${l.treasuryMovementId} (${r.ledgerEntryId}, ${r.customerName})`, field: 'treasury account / method text', before: `${l.accountName} vs "${r.paymentMethod}"`, after: '?', reason: l.isCash ? 'Cash line — no bank statement to decide' : 'No bank-recon line matched', status: 'WAITING', confirm: 'Cashier: which account really received this', apply: null });
  }
}
const suspended = BASE.sales.receipts.filter((x) => /^suspended/i.test(String(x.status || '')));
const canonical = (s) =>
  /investigation/i.test(s) ? 'Suspended — investigation' : /no bank receipt/i.test(s) ? 'Suspended — no bank receipt, awaiting credit check' : s;
for (const x of suspended) {
  if (canonical(x.status) === x.status) continue;
  add({ group: 'C', record: `receipt ${x.ledgerEntryId || x.id} (${x.customer})`, field: 'sales_receipts.status (text)', before: x.status, after: canonical(x.status), reason: 'One spelling per suspended status', apply: (fx) => { const y = fx.sales.receipts.find((z) => z.id === x.id); if (y) y.status = canonical(x.status); } });
}
add({ group: 'C', record: 'Yusuf (CUS-KD-26-1069): LE-KD-26-1767, LE-KD-26-1778', field: 'investigation_cases + investigation_links', before: '—', after: 'case opened, receipts linked (₦2,122,000, reversed in treasury)', reason: 'Fraud register entry (owner)', apply: null });
add({ group: 'C', record: 'LE-KD-26-1840 (Usman Tijjani)', field: '₦200,000 treasury line dated 6 Aug', before: 'receipt ₦1,645,000 vs Sep treasury ₦1,445,000', after: '?', reason: 'Which ₦200,000 belongs to this receipt', status: 'WAITING', confirm: 'Cashier: source of the 6 Aug ₦200,000', apply: null });
add({ group: 'C', record: 'TM-KD-26-0271 (LE-KD-26-0284, Feb, Jamilu Muhd Ibrahim)', field: 'customer', before: '(no ledger entry)', after: '?', reason: '₦1,907,500 receipt with no customer', status: 'WAITING', confirm: 'Branch manager: who paid ₦1,907,500', apply: null });

// D — expenses / payables ------------------------------------------------------------------------
const toErpCategory = { R1: 'Refund', R2: 'Staff loan', R3: 'Plant and machinery', R4: 'Accessories', R5: 'Maintenance', R6: 'Admin expenses' };
const baseExp = buildExpensesReport(BASE.expenses);
for (const row of baseExp.rows.filter((x) => x.reclassRule)) {
  const after = toErpCategory[row.reclassRule];
  add({
    group: 'D',
    record: `expense ${row.expenseID}`,
    field: 'expenses.category',
    before: row.category,
    after,
    reason: `${row.reclassLabel} — "${row.description}"${row.reclassRule === 'R3' ? ' (capex: fixed-asset row + capitalisation journal created on save)' : ''}`,
    apply: (fx) => { const e = fx.expenses.expenses.find((z) => z.expenseID === row.expenseID); if (e) e.category = after; },
  });
}
add({ group: 'D', record: 'expense EXP-KD-26-0398', field: 'expenses.expense_type', before: 'Payment request (pending payout)', after: 'Payment request (cancelled)', reason: 'Request cancelled — not an expense (book view already leaves it out)', apply: (fx) => { const e = fx.expenses.expenses.find((z) => z.expenseID === 'EXP-KD-26-0398'); if (e) e.expenseType = 'Payment request (cancelled)'; } });
add({ group: 'D', record: 'PO-KD-26-0070 (Dechimex)', field: '—', before: '₦400 outstanding', after: '₦400 stays payable', reason: 'Exact balance (owner) — already open on the PO; no data change', apply: null });
add({ group: 'D', record: 'EXP-KD-26-0402 / 0403 ↔ PO-0085 transport', field: '—', before: '₦290,000 in expenses and in PO transport', after: '?', reason: 'Paid twice or recorded twice', status: 'WAITING', confirm: 'Accounts: check the bank lines for 7 Sep ₦240,000 and 19 Sep ₦50,000', apply: null });
add({ group: 'D', record: 'PO-KD-26-0008 / 0027 / 0058', field: '—', before: 'paid, never received (23–43 kg)', after: '?', reason: 'Transport / adjustment booked as coil?', status: 'WAITING', confirm: 'Storekeeper + accounts: what these POs were', apply: null });
add({ group: 'D', record: 'Storm Shield — October refund', field: '—', before: '—', after: '?', reason: 'Needs the bank line', status: 'WAITING', confirm: 'Accounts: the bank statement line', apply: null });

// E — list only ----------------------------------------------------------------------------------
for (const s of baseSales.accrual.exceptions.staleBalances) {
  add({ group: 'E', record: `customer ${s.customerID} ${s.customerName}`, field: 'balance', before: `₦${ngn(s.amountNgn).toLocaleString('en-NG')} (${s.note})`, after: '—', reason: 'Unchanged since before September', status: 'WAITING', confirm: 'Sales / branch manager: still owed? still held?', apply: null });
}
for (const r of baseSales.accrual.exceptions.refundsOverValue) {
  add({ group: 'E', record: `${r.quotationRef} ${r.customerName}`, field: 'refunds', before: `refunds ₦${r.valueReducingRefundsNgn.toLocaleString('en-NG')} vs quote ₦${r.quoteTotalNgn.toLocaleString('en-NG')}`, after: '—', reason: 'Refunds bigger than the quotation value', status: 'WAITING', confirm: 'Accounts: refund approval papers', apply: null });
}

// ---------------------------------------------------------------------------------------------
// Simulation: base, each group, all READY (order A → D → C → B)
// ---------------------------------------------------------------------------------------------
const clone = () => structuredClone(BASE);
const run = (groups) => {
  const fx = clone();
  for (const g of groups) for (const c of corrections) if (c.group === g && c.status === 'READY' && c.apply) c.apply(fx);
  return fx;
};
console.error('computing base…');
const base = headlines(BASE);
const scenarios = { base };
for (const g of ['A', 'D', 'C', 'B']) {
  console.error(`computing group ${g}…`);
  scenarios[g] = headlines(run([g]), { withSales: g === 'B' || g === 'C' });
}
console.error('computing all READY…');
scenarios.all = headlines(run(['A', 'D', 'C', 'B']));

// Per-correction effect (non-sales figures; sales moves only through group B, shown per group).
for (const c of corrections) {
  if (c.status !== 'READY' || !c.apply) {
    c.effect = c.status === 'READY' ? 'No September report figure moves (posted in the open period / text only)' : '';
    continue;
  }
  const fx = clone();
  c.apply(fx);
  const h = headlines(fx, { withSales: false });
  const moved = Object.keys(h).filter((k) => h[k] !== base[k]).map((k) => `${k}: ${fmt(base[k])} → ${fmt(h[k])}`);
  c.effect = moved.join('; ') || 'No headline figure moves';
}
function fmt(v) {
  return typeof v === 'number' ? v.toLocaleString('en-NG') : String(v ?? '—');
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
const out = process.argv[2] || path.join(BE, `exports/phase2-dry-run-${TODAY}.xlsx`);
const keys = [...new Set(Object.values(scenarios).flatMap((h) => Object.keys(h)))];
const effectRows = keys.map((k) => ({
  figure: k,
  before: scenarios.base[k] ?? '',
  afterGroupA: scenarios.A[k] ?? '',
  afterGroupD: scenarios.D[k] ?? '',
  afterGroupC: scenarios.C[k] ?? '',
  afterGroupB: scenarios.B[k] ?? '',
  afterAllReady: scenarios.all[k] ?? '',
  change: typeof scenarios.all[k] === 'number' && typeof scenarios.base[k] === 'number' ? scenarios.all[k] - scenarios.base[k] : '',
}));
const sheetRows = (list) => list.map(({ apply: _apply, ...c }) => ({ id: c.id, group: c.group, status: c.status, record: c.record, field: c.field, before: c.before, after: c.after, reason: c.reason, whoMustConfirm: c.confirm, effectOnSep2026: c.effect || '' }));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows(corrections)), 'All_corrections');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows(corrections.filter((c) => c.status === 'READY'))), 'READY');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows(corrections.filter((c) => c.status === 'WAITING'))), 'WAITING');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(effectRows), 'Effect_on_Sep2026');
fs.mkdirSync(path.dirname(out), { recursive: true });
XLSX.writeFile(wb, out);

// Machine-readable plan for scripts/phase2-apply.mjs: READY items with an exact operation, order A → D → C → B.
const grab = (re, text) => (String(text).match(re) || [])[1] || '';
function opsFor(c) {
  const f = c.field;
  if (f === 'coil_lots.unit_cost_ngn_per_kg' || f === 'coil_lots.gauge_label') {
    const col = f.split('.')[1];
    const before = c.before === '(none)' ? null : c.before;
    return [{ kind: 'update', table: 'coil_lots', keyCol: 'coil_no', key: grab(/coil (\S+)/, c.record), col, before, after: c.after }];
  }
  if (f === 'coil_lots.received_at_iso + STORE_GRN movement date') {
    const coilNo = grab(/coil (\S+)/, c.record);
    return [
      { kind: 'update', table: 'coil_lots', keyCol: 'coil_no', key: coilNo, col: 'received_at_iso', before: c.before, after: c.after, compare: 'day' },
      { kind: 'grnDate', coilNo, before: c.before, after: c.after },
    ];
  }
  if (f === 'STORE_GRN movement date') return [{ kind: 'grnDate', coilNo: grab(/coil (\S+)/, c.record), before: c.before, after: c.after }];
  if (f === 'production_jobs.status') {
    return [{ kind: 'update', table: 'production_jobs', keyCol: 'job_id', key: grab(/job (\S+)/, c.record), col: 'status', before: 'Completed', after: c.after }];
  }
  if (f.startsWith('new RECEIPT_REVERSAL_OUT linked to ')) return [{ kind: 'reverseTreasuryLine', movementId: grab(/linked to (\S+)/, f) }];
  if (f === 'sales_receipts.method (text)' || f === 'sales_receipts.status (text)') {
    return [{ kind: 'update', table: 'sales_receipts', keyCol: 'id', key: grab(/receipt (\S+)/, c.record), col: f.includes('method') ? 'method' : 'status', before: c.before, after: c.after }];
  }
  if (f === 'investigation_cases + investigation_links') {
    return [{
      kind: 'investigationCase',
      title: 'Yusuf — receipts LE-KD-26-1767 / LE-KD-26-1778 reversed in treasury (no bank receipt)',
      caseType: 'unbacked_receipt',
      customerId: 'CUS-KD-26-1069',
      amountAtRiskNgn: 2122000,
      branchId: 'BR-KD',
      links: [
        { entityType: 'receipt', entityId: 'LE-KD-26-1767', role: 'subject' },
        { entityType: 'receipt', entityId: 'LE-KD-26-1778', role: 'subject' },
      ],
    }];
  }
  if (f === 'expenses.category' || f === 'expenses.expense_type') {
    return [{
      kind: 'update', table: 'expenses', keyCol: 'expense_id', key: grab(/expense (\S+)/, c.record), col: f.split('.')[1], before: c.before, after: c.after,
      ...(c.after === 'Plant and machinery' ? { afterHook: 'capexSync' } : {}),
    }];
  }
  return [];
}
const ORDER = { A: 1, D: 2, C: 3, B: 4 };
const plan = corrections
  .filter((c) => c.status === 'READY')
  .map((c) => ({ id: c.id, group: c.group, record: c.record, field: c.field, before: c.before, after: c.after, reason: c.reason, ops: opsFor(c) }))
  .filter((c) => c.ops.length)
  .sort((a, b) => ORDER[a.group] - ORDER[b.group] || a.id.localeCompare(b.id));
const planOut = out.replace(/.xlsx$/, '.plan.json');
fs.writeFileSync(planOut, JSON.stringify({ createdAtISO: new Date().toISOString(), source: '13 Oct 2026 ERP export fixtures', items: plan }, null, 1));
console.log(`Wrote ${planOut}: ${plan.length} READY items with operations`);

const count = (g, s) => corrections.filter((c) => c.group === g && c.status === s).length;
console.log(`Wrote ${out}`);
for (const g of ['A', 'B', 'C', 'D', 'E']) console.log(`  ${g}: READY ${count(g, 'READY')}, WAITING ${count(g, 'WAITING')}`);
console.log('Moved headline figures (before → after all READY):');
for (const r of effectRows.filter((r) => r.change)) console.log(`  ${r.figure}: ${fmt(r.before)} → ${fmt(r.afterAllReady)} (${r.change > 0 ? '+' : ''}${fmt(r.change)})`);
