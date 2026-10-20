#!/usr/bin/env node
/**
 * Phase 2 round 2 — August 2026 (Kaduna) plan + dry run. NO database access, no writes.
 *
 *   node scripts/phase2-aug-plan.mjs --erp <phase2-aug-read.json> --bank <bank_aug.json> --out <dir>
 *
 * Inputs: the live read (scripts/phase2-aug-read.mjs, SELECT only) and the August lines of both bank statements
 * (Taj PDF, Moniepoint account-statement.xlsx). Output: <dir>/phase2-aug-<date>.plan.json (for phase2-apply.mjs)
 * and <dir>/phase2-aug-<date>.dryrun.json (old vs new balances, line match before vs after, skipped items).
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : '';
};
const erp = JSON.parse(fs.readFileSync(opt('erp'), 'utf8'));
const bank = JSON.parse(fs.readFileSync(opt('bank'), 'utf8'));
const outDir = opt('out') || '.';
const today = new Date().toISOString().slice(0, 10);

const TAJ = 2;
const CASH = 3;
const MP = 4;
const BR = 'BR-KD';
const ACC = { [TAJ]: 'Taj', [MP]: 'Moniepoint', [CASH]: 'Cash Office' };
const BANK_CLOSE = { [TAJ]: 13231101, [MP]: 829714424, [CASH]: 99237000 }; // kobo
const TAJ_BANK_31_JUL_KOBO = 1292429256;
const day = (iso) => String(iso || '').slice(0, 10);
const mv = (id) => erp.movements.find((m) => m.id === id);

const items = [];
const skipped = [];
const exp = (id, record, account, date, amountNgn, category, expenseType, extra = {}) =>
  items.push({
    id,
    group: 'A',
    record,
    field: `new expense (${category})`,
    reason: expenseType,
    ops: [
      {
        kind: 'postExpense',
        date,
        amountNgn,
        category,
        expenseType,
        paymentMethod: 'Bank',
        reference: `BANK-${account === TAJ ? 'TAJ' : 'MONIEPOINT'}-${date}`,
        treasuryAccountId: account,
        branchId: BR,
        ...extra,
      },
    ],
  });

// ---- A. Missing August records -------------------------------------------------------------------------------
exp('A1a', 'Taj 24 Aug ₦1,620,000', TAJ, '2026-08-24', 1620000, 'Admin salary', 'Salaries Aug 2026 (bulk transfer)');
exp('A1b', 'Moniepoint 28 Aug ₦70,000 Shehu Yacham Joseph', MP, '2026-08-28', 70000, 'Admin salary', 'Salary Aug 2026 - Shehu Yacham Joseph');
skipped.push({
  id: 'A1c',
  record: 'Moniepoint 28 Aug ₦20,000 Mansur Matazu + ₦6,000 Gabriel Howsa Abbah',
  why: 'Already in the ERP: EXP-KD-26-0277 / PREQ-KD-26-0206 "SALARY" ₦26,000, Moniepoint 28 Aug (TM-KD-26-2308), lines MANSUR MATAZU ₦20,000 + ABBA HAUSAN ₦6,000, category Admin salary. Posting again would double it.',
});
items.push({
  id: 'A2',
  group: 'A',
  record: 'Moniepoint 25 Aug ₦6,800,000 Muhsin Best Engineering Services Ltd',
  field: 'new capex expense (Plant and machinery) + transformer asset cost',
  reason: 'Transformer, first payment',
  ops: [
    {
      kind: 'postExpense',
      date: '2026-08-25',
      amountNgn: 6800000,
      category: 'Plant and machinery',
      expenseType: 'Transformer, first payment - Muhsin Best Engineering Services Ltd',
      paymentMethod: 'Bank',
      reference: 'BANK-MONIEPOINT-2026-08-25',
      treasuryAccountId: MP,
      branchId: BR,
      addToAsset: {
        assetId: 'FA-1791991186487-6gzuen',
        expectedCostNgn: 2877950,
        name: 'Transformer (EXP-KD-26-0362 + 0397 + {expenseId})',
        notes: 'Transformer, paid in 3 parts: first payment 25 Aug 2026 (Moniepoint), then 10 Sep and 28 Sep',
      },
    },
  ],
});
exp('A3', 'Moniepoint 1 Aug ₦250,000 Rafiu Sunday Ismahil', MP, '2026-08-01', 250000, 'Accessories', 'Felt - Rafiu Sunday Ismahil');
exp('A4', 'Moniepoint 29 Aug ₦200,000 POS Transfer - Nuhu Mikiyan', MP, '2026-08-29', 200000, 'Carriage inward', 'POS Transfer - Nuhu Mikiyan (Kano transporter, Strong purchase)');
skipped.push({
  id: 'A5a',
  record: 'Moniepoint 22 Aug ₦20,000 Jamilu Alhassan',
  why: 'Already in the ERP: PREQ-KD-26-0185 "metral machines" (EXP-KD-26-0256, Maintenance), TM-KD-26-2221, Moniepoint 22 Aug. The 21 Aug ₦20,000 to Jamilu is PREQ-KD-26-0175 "MECHANIC FROM KANO" (TM-KD-26-2194).',
});
exp('A5b', 'Moniepoint 25 Aug ₦3,500 (+₦20 fee) Godwin Obochi Emmanuel', MP, '2026-08-25', 3500, 'Maintenance', 'Forklift - Godwin Obochi Emmanuel');
skipped.push({
  id: 'A6',
  record: 'Moniepoint 31 Aug ₦60,000 Abdulmalik Sali Uthman',
  why: 'Already in the ERP: PREQ-KD-26-0215 "Rice for chairman house" (EXP-KD-26-0286, Chairman withdrawal), TM-KD-26-2368, Moniepoint 31 Aug.',
});
const sep395 = erp.expenses.filter((x) => x.amount_ngn === 395900);
if (sep395.length) skipped.push({ id: 'A7', record: 'Matrix Energy ₦395,900', why: `Already in expenses: ${sep395.map((x) => `${x.expense_id} ${x.date}`).join(', ')}` });
else exp('A7', 'Moniepoint 31 Aug ₦395,900 Matrix Energy Ltd (no Sept expense of ₦395,900)', MP, '2026-08-31', 395900, 'Fuel & lubricant', 'Diesel - Matrix Energy Ltd');
exp('A7b', 'Moniepoint 31 Aug ₦3,000 Ibrahim Shaitu', MP, '2026-08-31', 3000, 'Fuel & lubricant', 'Transport to collect the Matrix diesel - Ibrahim Shaitu');
exp('A8a', 'Taj Aug bank charges ₦1,661.55', TAJ, '2026-08-31', 1662, 'Bank charges', 'Taj Aug 2026 bank charges: stamp duty 650, transfer fees 698.75, SMS 312.80 (1,661.55)');
exp('A8b', 'Moniepoint Aug bank charges ₦6,455.50', MP, '2026-08-31', 6456, 'Bank charges', 'Moniepoint Aug 2026 bank charges: stamp duty 6,250, VAT 205.50 (6,455.50)');
const mamia = erp.mamia.filter((m) => day(m.posted_at_iso).startsWith('2026-08'));
const mamiaExpenses = erp.expenses.filter((x) => /mamia/i.test(`${x.expense_type} ${x.reference}`));
skipped.push({
  id: 'A9',
  record: `Mamia Seed Oil settlements 13-14 Aug ₦${mamia.reduce((s, m) => s - m.amount_ngn, 0).toLocaleString('en-NG')}`,
  why: `No change. ${mamia.map((m) => `${m.id} ${m.source_id} ₦${(-m.amount_ngn).toLocaleString('en-NG')}`).join(', ')} are REGISTER_SETTLEMENT_OUT lines (register settlement, not expenses); ${mamiaExpenses.length} expense rows mention Mamia.`,
});

// ---- B. Corrections ------------------------------------------------------------------------------------------
items.push({
  id: 'B10',
  group: 'B',
  record: 'RF-KD-26-9250 (QT-KD-26-0783, Tahir, ₦809,400 recorded paid 11 Jul to "Abdulrahman", TM-KD-26-1427 Moniepoint)',
  field: 'refund payout',
  reason: 'Bank: ₦720,000 to Tahir Isiya on 9 Aug (Moniepoint); ₦89,400 difference to explain',
  ops: [
    {
      kind: 'refundRepay',
      refundId: 'RF-KD-26-9250',
      originalMovementId: 'TM-KD-26-1427',
      expectedPaidNgn: 809400,
      reverseDate: '2026-07-11',
      payDate: '2026-08-09',
      amountNgn: 720000,
      treasuryAccountId: MP,
      payeeName: 'Tahir Isiya',
      note: '₦89,400 difference to explain',
    },
  ],
});
const move = (id, record, movementId, from, fromDate, to, toDate, reason) =>
  items.push({ id, group: 'B', record, field: 'treasury account + date', reason, ops: [{ kind: 'moveTreasury', movementId, fromAccountId: from, fromDate, toAccountId: to, toDate, note: reason }] });
move('B11', 'EXP-KD-26-0241 Matrix gas ₦357,033 (TM-KD-26-2142)', 'TM-KD-26-2142', TAJ, '2026-08-17', MP, '2026-08-15', 'Bank: Moniepoint 15 Aug ₦357,033 to Matrix Energy "gas"; not on the Taj statement');
move('B12a', 'Security ₦10,000 (TM-KD-26-2327, PREQ-KD-26-0205)', 'TM-KD-26-2327', TAJ, '2026-08-29', MP, '2026-08-28', 'Bank: Moniepoint 28 Aug ₦10,000 to Abubakar Mohammed (OPay); not on the Taj statement');
move('B12b', 'Rafel transport ₦20,000 (TM-KD-26-2326, PREQ-KD-26-0210)', 'TM-KD-26-2326', TAJ, '2026-08-14', MP, '2026-08-14', 'Bank: Moniepoint 14 Aug ₦20,000 to Rapheal Ewanger Orpin (OPay); not on the Taj statement');
move('B12c', 'Tahir refund ₦15,350 (TM-KD-26-2162, RF-KD-26-9500)', 'TM-KD-26-2162', TAJ, '2026-08-19', MP, '2026-08-19', 'Bank: Moniepoint 19 Aug ₦15,350 to Abdulrahman Uthman Sali (OPay), not to Tahir; not on the Taj statement');
skipped.push({ id: 'B13a', record: 'Engr Abdulganiu ₦2,387,900 (LE-KD-26-1359, TM-KD-26-1955, Taj 6 Aug)', why: 'No credit of ₦2,387,900 (or two credits adding to it) on either statement in August. For the cashier.' });
skipped.push({ id: 'B13b', record: 'Ahmad JJ ₦219,200 (LE-KD-26-1329, TM-KD-26-1894, Taj 3 Aug)', why: 'No credit of ₦219,200 on either statement in August (nearest: Taj 6 Aug ₦219,000 Haruna Saifullahi, already matched to TM-KD-26-1968). For the cashier.' });
items.push({
  id: 'B13c',
  group: 'B',
  record: 'Oga Ali ₦599,400 (LE-KD-26-1339, TM-KD-26-1904) + ₦447,680 (LE-KD-26-1347, TM-KD-26-1942), both already on Taj',
  field: 'bank reconciliation link + paid by',
  reason: 'Taj 4 Aug credit NIP FRM CHANCELLORS FARMS LTD ₦1,062,080 (₦15,000 more than the two receipts)',
  ops: [
    {
      kind: 'reconLink',
      treasuryAccountId: TAJ,
      bankDateISO: '2026-08-04',
      amountNgn: 1062080,
      description: 'NIP FRM CHANCELLORS FARMS LTD 28 pcs of — Paid by: Chancellors Farms Ltd',
      movementIds: ['TM-KD-26-1904', 'TM-KD-26-1942'],
      branchId: BR,
    },
  ],
});
const tajOpening = erp.accounts.find((a) => a.id === TAJ).opening_balance_ngn;
const tajToJul = erp.movements.filter((m) => m.treasury_account_id === TAJ && day(m.posted_at_iso) <= '2026-07-31').reduce((s, m) => s + m.amount_ngn, 0);
const newTajOpening = Math.round(TAJ_BANK_31_JUL_KOBO / 100 - tajToJul);
items.push({
  id: 'B14',
  group: 'B',
  record: 'Taj (treasury account 2) opening balance',
  field: 'treasury_accounts.opening_balance_ngn',
  reason: `ERP Taj balance = bank ₦12,924,292.56 at 31 Jul 2026 (opening = 12,924,292.56 − ERP Taj movements to 31 Jul ₦${tajToJul.toLocaleString('en-NG')}; whole naira)`,
  ops: [{ kind: 'setOpening', treasuryAccountId: TAJ, before: tajOpening, after: newTajOpening }],
});

// ---- Simulation (in memory) -----------------------------------------------------------------------------------
const opening = Object.fromEntries(erp.accounts.map((a) => [a.id, a.opening_balance_ngn]));
let sim = erp.movements.map((m) => ({ ...m }));
const simOpening = { ...opening };
const reconLinks = [];
let n = 0;
for (const it of items)
  for (const op of it.ops) {
    if (op.kind === 'postExpense')
      sim.push({ id: `NEW-${it.id}`, posted_at_iso: `${op.date}T12:00:00.000Z`, type: 'EXPENSE', treasury_account_id: op.treasuryAccountId, amount_ngn: -op.amountNgn, counterparty_name: op.category, note: op.expenseType });
    if (op.kind === 'refundRepay') {
      const o = mv(op.originalMovementId);
      sim.push({ id: `REV-${it.id}`, posted_at_iso: `${op.reverseDate}T12:00:00.000Z`, type: 'REFUND_PAYOUT_REVERSAL_IN', treasury_account_id: o.treasury_account_id, amount_ngn: -o.amount_ngn, reverses_movement_id: o.id });
      sim.push({ id: `NEW-${it.id}`, posted_at_iso: `${op.payDate}T12:00:00.000Z`, type: 'REFUND_PAYOUT', treasury_account_id: op.treasuryAccountId, amount_ngn: -op.amountNgn });
    }
    if (op.kind === 'moveTreasury') sim = sim.map((m) => (m.id === op.movementId ? { ...m, treasury_account_id: op.toAccountId, posted_at_iso: `${op.toDate}${m.posted_at_iso.slice(10)}` } : m));
    if (op.kind === 'setOpening') simOpening[op.treasuryAccountId] = op.after;
    if (op.kind === 'reconLink') reconLinks.push(op);
    n++;
  }
const balance = (movs, open, id, d) => open[id] + movs.filter((m) => m.treasury_account_id === id && day(m.posted_at_iso) <= d).reduce((s, m) => s + m.amount_ngn, 0);

// ---- Line match: same account, amount, ±3 days (nearest first); then pairs of bank lines = one ERP line ---------
const isCharge = (l) => (l.acct === 'MP' && /^(Stamp duty|Value Added Tax)$/i.test(String(l.narration).trim())) || (l.acct === 'TAJ' && /stamp duty|sms charges/i.test(l.narration));
const dd = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
const acctOf = { TAJ, MP };
function match(movs, links) {
  const erpAug = movs.filter((m) => [TAJ, MP].includes(m.treasury_account_id) && day(m.posted_at_iso).startsWith('2026-08'));
  const reversed = new Set(erpAug.filter((m) => m.reverses_movement_id).flatMap((m) => [m.id, m.reverses_movement_id]));
  const pool = erpAug.filter((m) => !reversed.has(m.id));
  const used = new Set();
  const lines = [...bank.taj, ...bank.mp].filter((l) => !isCharge(l)).map((l) => ({ ...l, match: null }));
  const wants = (l) => {
    const w = new Set([Math.round(l.amount)]);
    if (l.acct === 'TAJ' && l.amount < 0) w.add(Math.round(l.amount + 53.75));
    if (l.acct === 'MP' && l.amount > 0 && l.fee) w.add(Math.round(l.amount + l.fee));
    return w;
  };
  for (const lk of links) {
    const l = lines.find((x) => !x.match && acctOf[x.acct] === lk.treasuryAccountId && x.date === lk.bankDateISO && Math.round(x.amount) === lk.amountNgn);
    if (l) {
      l.match = lk.movementIds.join(' + ') + ' (recon link)';
      lk.movementIds.forEach((id) => used.add(id));
    }
  }
  for (const pass of [0, 1, 2, 3])
    for (const l of lines) {
      if (l.match) continue;
      const w = wants(l);
      const c = pool.find((m) => !used.has(m.id) && m.treasury_account_id === acctOf[l.acct] && w.has(m.amount_ngn) && dd(day(m.posted_at_iso), l.date) <= pass);
      if (c) {
        used.add(c.id);
        l.match = c.id;
      }
    }
  for (const m of pool.filter((x) => !used.has(x.id))) {
    const cand = lines.filter((l) => !l.match && acctOf[l.acct] === m.treasury_account_id && dd(l.date, day(m.posted_at_iso)) <= 1 && Math.sign(l.amount) === Math.sign(m.amount_ngn));
    outer: for (let i = 0; i < cand.length; i++)
      for (let j = i + 1; j < cand.length; j++)
        if (Math.round(cand[i].amount + cand[j].amount) === m.amount_ngn) {
          cand[i].match = cand[j].match = `${m.id} (pair)`;
          used.add(m.id);
          break outer;
        }
  }
  const chargesBooked = (id) => pool.some((m) => m.treasury_account_id === id && m.counterparty_name === 'Bank charges');
  const charges = [...bank.taj, ...bank.mp].filter(isCharge);
  const per = (acct) => {
    const x = lines.filter((l) => l.acct === acct);
    const ch = charges.filter((c) => c.acct === acct);
    const booked = chargesBooked(acctOf[acct]);
    return { lines: x.length + ch.length, matched: x.filter((l) => l.match).length + (booked ? ch.length : 0), chargeLines: ch.length, chargesBooked: booked };
  };
  return {
    TAJ: per('TAJ'),
    MP: per('MP'),
    unmatchedBank: lines.filter((l) => !l.match).map((l) => ({ account: l.acct === 'TAJ' ? 'Taj' : 'Moniepoint', date: l.date, amount: l.amount, narration: `${l.beneficiary ? `${l.beneficiary} | ` : ''}${l.narration}`.slice(0, 90) })),
    unmatchedErp: pool.filter((m) => !used.has(m.id)).map((m) => ({ account: ACC[m.treasury_account_id], id: m.id, date: day(m.posted_at_iso), amount: m.amount_ngn, type: m.type, name: m.counterparty_name, source: m.source_id })),
  };
}
const before = match(erp.movements, []);
const after = match(sim, reconLinks);

const balances = [TAJ, MP, CASH].map((id) => {
  const b31 = balance(erp.movements, opening, id, '2026-08-31');
  const a31 = balance(sim, simOpening, id, '2026-08-31');
  const bank31 = BANK_CLOSE[id] / 100;
  const plugLine = erp.movements.find((m) => m.source_id === 'PREQ-KD-26-0330' && m.treasury_account_id === id);
  const gap = Math.round((a31 - bank31) * 100) / 100;
  return {
    account: ACC[id],
    erp31JulBefore: balance(erp.movements, opening, id, '2026-07-31'),
    erp31JulAfter: balance(sim, simOpening, id, '2026-07-31'),
    erp31AugBefore: b31,
    erp31AugAfter: a31,
    bank31Aug: bank31,
    gapAfter: gap,
    plugLineNgn: plugLine?.amount_ngn ?? 0,
    plugLineIfBalanced: plugLine ? Math.round(plugLine.amount_ngn - gap) : null,
  };
});

fs.mkdirSync(outDir, { recursive: true });
const plan = {
  createdAtISO: today,
  source:
    'Owner instruction 14 Oct 2026: Phase 2 round 2 — August 2026 Kaduna records complete and correct (A missing bank lines, B corrections). Correction 14 Oct: Ibrahim Shaitu ₦3,000 31 Aug is Fuel & lubricant (transport to collect the Matrix diesel), not a refund.',
  items,
};
const planPath = path.join(outDir, `phase2-aug-${today}.plan.json`);
fs.writeFileSync(planPath, JSON.stringify(plan, null, 1));
const dry = { createdAtISO: today, opsInPlan: n, skipped, tajOpening: { before: tajOpening, after: newTajOpening, tajMovementsTo31Jul: tajToJul }, balances, matchBefore: before, matchAfter: after };
const dryPath = path.join(outDir, `phase2-aug-${today}.dryrun.json`);
fs.writeFileSync(dryPath, JSON.stringify(dry, null, 1));
console.log(planPath);
console.log(dryPath);
console.log('items', items.length, 'skipped', skipped.length);
console.log('Taj opening', tajOpening, '→', newTajOpening, '(movements to 31 Jul', tajToJul, ')');
console.table(balances);
console.log('match before', { TAJ: before.TAJ, MP: before.MP }, 'after', { TAJ: after.TAJ, MP: after.MP });
