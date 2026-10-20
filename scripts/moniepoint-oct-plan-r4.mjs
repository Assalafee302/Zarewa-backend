#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 4 — owner instruction 17 Oct 2026. Plan only (no DB access). No September dates.
 * A1 commissions as expenses ("Sales commission", MD-approved exception); B5 the 18 ERP≠bank amounts set to the bank
 * transaction amount (cash book Moniepoint_Cash_Book_Oct2026.xlsx); C7 the October bank-charges expense replaced by one
 * line per day. A2 (Gabdo nails), A3 (Yusuf Aliyu), B4, B6 are report-only this round.
 *
 *   node scripts/moniepoint-oct-plan-r4.mjs  →  exports/phase2-moniepoint-oct/mp-round4-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const TAJ = 2;
const CASH = 3;
const BR = 'BR-KD';
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const d = (mp) => ({ [MP]: mp, [TAJ]: 0, [CASH]: 0 });
const MD = 'Approved by the MD, Mustapha Ibn Sali (exception to the commission cap)';
const expense = (id, date, amountNgn, category, expenseType, reason, ref, postedAtISO) => ({
  id,
  group: 'A',
  record: `Moniepoint ${date} ₦${amountNgn.toLocaleString('en-NG')}`,
  field: `new expense (${category})`,
  reason,
  ops: [{ kind: 'postExpense', date, amountNgn, category, expenseType, paymentMethod: 'Bank', reference: ref, treasuryAccountId: MP, branchId: BR, ...(postedAtISO ? { postedAtISO } : {}) }],
  expectDeltaNgn: d(-amountNgn),
  expectTypes: ['EXPENSE'],
});

const items = [
  expense('R4-A1a', '2026-10-01', 1000000, 'Sales commission', 'Commission – QS Isa, FGGC project (QT-KD-26-1394), MD-approved exception',
    `Bank A4: ₦1,000,020 to Abdullahi Isah 1 Oct 09:58 (₦1,000,000 + ₦20 fee). ${MD}.`, 'BANK-MP-202610010958', utc('2026-10-01 09:58')),
  expense('R4-A1b', '2026-10-15', 16600, 'Sales commission', 'Commission – Jonathan, dark grey 0.70 (QT-KD-26-1722), MD-approved exception',
    `Bank B24: ₦16,620 to Jonathan Chukusa 15 Oct 10:35 (₦16,600 + ₦20 fee). ${MD}.`, 'BANK-MP-202610151035', utc('2026-10-15 10:35')),
];

// B5 — ERP amount = bank transaction amount (cash book). [id, movement, kind, ERP before, bank, note]
const B5 = [
  ['A41', 'TM-KD-26-3107', 'receipt', 'LE-KD-26-1986', 204880, 204980, 'Aliyu Mohd POS ₦204,980 (bank credit ₦204,880 net of ₦100 card fee)'],
  ['A84', 'TM-KD-26-3165', 'receipt', 'LE-KD-26-2026', 43428, 43450, 'Shamsuddeen ₦43,450'],
  ['A148', 'TM-KD-26-3228', 'receipt', 'LE-KD-26-2092', 4000, 4015, 'Hakimi POS ₦4,015 (bank ₦3,990 net of ₦25 fee)'],
  ['A2', 'TM-KD-26-3229', 'receipt', 'LE-KD-26-2093', 353184, 353000, 'Engr Attah Nicholas ₦353,000 (paid through Bakari)'],
  ['A71', 'TM-KD-26-3142', 'payout', 'RF-KD-26-9728', 1840, 1800, 'Hussaini Adam refund (QT-1716) via Bakari ₦1,800'],
  ['A76', 'TM-KD-26-3149', 'payout', 'RF-KD-26-9734', 72216, 72000, 'Alh Mahadi Turunku refund (QT-1697) ₦72,000'],
  ['A77', 'TM-KD-26-3150', 'payout', 'RF-KD-26-9736', 976, 900, 'Yakubu Muktar refund (QT-1693) staff share via OM ₦900'],
  ['A119', 'TM-KD-26-3201', 'payout', 'RF-KD-26-9770', 1070020, 1070000, 'Suleiman Zaria refund (QT-1778) ₦1,070,000 (the ₦20 is the transfer fee, in bank charges)'],
  ['A126', 'TM-KD-26-3207', 'payout', 'RF-KD-26-9771', 190670, 190600, 'Mohammed Alhassan refund (QT-1738) via BM Sulaiman ₦190,600'],
  ['A130', 'TM-KD-26-3211', 'payout', 'RF-KD-26-9772', 1316, 1300, 'Sangir Dahiru refund (QT-1776) via Bakari ₦1,300'],
  ['A131', 'TM-KD-26-3212', 'payout', 'RF-KD-26-9766', 2520, 2500, 'Jamilu Baba refund (QT-1707) via Bakari ₦2,500 (the ₦20 is the transfer fee)'],
  ['A132', 'TM-KD-26-3213', 'payout', 'RF-KD-26-9764', 5080, 5000, 'Ibrahim Shuaibu refund (QT-1714) via BM Sulaiman ₦5,000'],
  ['A134', 'TM-KD-26-3215', 'payout', 'RF-KD-26-9755', 39808, 39800, 'Shuaibu Roofer refund (QT-1749) via BM Sulaiman ₦39,800'],
  ['A150', 'TM-KD-26-3232', 'payout', 'RF-KD-26-9778', 17680, 17600, 'Suleman Ibrahim refund (QT-1773) via Bakari ₦17,600'],
  ['A151', 'TM-KD-26-3233', 'payout', 'RF-KD-26-9777', 23360, 23260, 'Adamu refund (QT-1787) via BM Sulaiman ₦23,260'],
  ['A160', 'TM-KD-26-3241', 'payout', 'RF-KD-26-9780', 29100, 29000, 'Qs Abdullahi Tj refund (QT-1796) ₦29,000'],
  ['A161', 'TM-KD-26-3242', 'payout', 'RF-KD-26-9780', 20640, 20600, 'Qs Abdullahi Tj refund (QT-1796) via OM ₦20,600'],
  ['A163', 'TM-KD-26-3244', 'payout', 'RF-KD-26-9781', 112056, 112000, 'Nasiru Salisu refund (QT-1781) via OM ₦112,000'],
];
for (const [row, mv, kind, src, before, bank, note] of B5) {
  items.push(
    kind === 'receipt'
      ? { id: `R4-B5-${row}`, group: 'A', record: `${src} / ${mv}`, field: 'receipt amount (finance-confirmed)', reason: `Bank ${row}: ${note}`, ops: [{ kind: 'receiptConfirmedAmount', receiptId: src, movementId: mv, treasuryAccountId: MP, expectedNgn: before, amountNgn: bank }], expectDeltaNgn: d(bank - before), expectTypes: [] }
      : { id: `R4-B5-${row}`, group: 'A', record: `${src} / ${mv}`, field: 'refund payout line amount', reason: `Bank ${row}: ${note}`, ops: [{ kind: 'payoutLineCorrect', movementId: mv, expectedNgn: before, amountNgn: bank, note: `Bank transaction amount (Moniepoint ${row}): ${note}` }], expectDeltaNgn: d(before - bank), expectTypes: [] }
  );
}

// C7 — bank charges: reverse the single October line, then one line per day (rounded with carry, total ₦8,340).
items.push({
  id: 'R4-C7-REV',
  group: 'A',
  record: 'EXP-KD-26-0471 Bank charges — Moniepoint, Oct 2026 ₦8,340 (TM-KD-26-3311)',
  field: 'expense reversal',
  reason: 'replaced by daily lines',
  ops: [{ kind: 'expenseReverse', expenseId: 'EXP-KD-26-0471', expectedNgn: 8340, reason: 'replaced by daily lines' }],
  expectDeltaNgn: d(8340),
  expectTypes: ['EXPENSE_REVERSAL_IN'],
});
const DAILY = [['2026-10-01', 514.5], ['2026-10-02', 564.5], ['2026-10-03', 286], ['2026-10-04', 143], ['2026-10-05', 552.5], ['2026-10-06', 929.5], ['2026-10-07', 622], ['2026-10-08', 716], ['2026-10-09', 336], ['2026-10-10', 1280], ['2026-10-12', 343], ['2026-10-13', 815], ['2026-10-14', 786.5], ['2026-10-15', 351], ['2026-10-16', 100]];
let cum = 0;
let posted = 0;
for (const [date, kobo] of DAILY) {
  cum += kobo;
  const amount = Math.round(cum) - posted; // round half up on the running total → carry the rounding forward
  posted += amount;
  items.push(expense(`R4-C7-${date.slice(5)}`, date, amount, 'Bank charges', 'Bank charges — Moniepoint',
    `Moniepoint charges ${date} ₦${kobo.toLocaleString('en-NG')} (stamp duty, VAT, transfer & POS fees); whole naira with rounding carried forward`, `BC-MP-${date}`,
    date === '2026-10-16' ? utc('2026-10-16 09:44') : undefined));
}
if (posted !== 8340) throw new Error(`daily bank charges total ₦${posted}, expected ₦8,340`);

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round4-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: Moniepoint round 4 (A1, B5, C7). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items; Moniepoint net ₦${items.reduce((s, i) => s + i.expectDeltaNgn[MP], 0).toLocaleString('en-NG')}`);
console.log('daily bank charges:', items.filter((i) => i.id.startsWith('R4-C7-') && i.id !== 'R4-C7-REV').map((i) => `${i.id.slice(6)} ₦${i.ops[0].amountNgn}`).join(', '));
