#!/usr/bin/env node
/**
 * Taj (treasury account 2, 0006047389) round 1 — OM instruction 19 Oct 2026. Plan only (no DB access). No September
 * dates (September stays locked). --per-item.
 *   T1-1  5 Oct ₦4,000,000 Chairman drawings (expense "Chairman withdrawal" → GL 3200 drawings).
 *   T1-3  7 Oct +₦5,920,240 Storm Shield refund of the 11 Sep duplicate (TM-KD-26-2570 / TM-KD-26-2997) on PO-KD-26-0079.
 *   T1-4  bank dates: TM-KD-26-3111 Samaila Aliyu 5 → 1 Oct; TM-KD-26-3151 Ibrahim Auwal Yahaya 7 → 5 Oct.
 *   T1-6  receipts with no open quotation → customer advances (Yunusa Ahmed ₦49,000 1 Oct + ₦9,800 19 Oct;
 *         Muhammad Haruna Abdullahi ₦35,000 9 Oct → HARUNA MOHD CUS-KD-26-0973, the same payer name as LE-KD-26-2023).
 *   T1-8  Taj October charges as daily BC lines (stamp duty ₦50 + NIP fee ₦53.75 per transfer, Sept SMS ₦979.20).
 * Report-only: 2 (BOI loan — no loan-repayment category), 5 (RF-KD-26-9752 ₦33,950 — no bank line anywhere),
 * 7 (HOLD: Twenty percent / Balance, Aluzinc LINK).
 *
 *   node scripts/taj-oct-plan-r1.mjs  →  exports/phase2-taj-oct/taj-round1-2026-10-19.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const TAJ = 2;
const BR = 'BR-KD';
const d = (taj) => ({ 2: taj, 3: 0, 4: 0 });
const TAJ_METHOD = 'Bank — Zaps Aluminum Enterprises';

const items = [
  {
    id: 'T1-1',
    group: 'A',
    record: 'Taj 2026-10-05 −₦4,000,053.75 "NIP Chairman zap INTER BANK TRANSFER"',
    field: 'new expense (Chairman withdrawal)',
    reason: 'OM 19 Oct: Chairman personal request — chairman drawings (fee ₦53.75 + stamp duty ₦50 in the 5 Oct BC line)',
    ops: [{
      kind: 'postExpense', date: '2026-10-05', amountNgn: 4000000, category: 'Chairman withdrawal',
      expenseType: 'Chairman drawings — payee Chairman — Chairman personal request — OM 19 Oct',
      paymentMethod: 'Bank', reference: 'BANK-TAJ-2026-10-05-CHAIRMAN', treasuryAccountId: TAJ, branchId: BR,
    }],
    expectDeltaNgn: d(-4000000),
    expectTypes: ['EXPENSE'],
  },
  {
    id: 'T1-3',
    group: 'A',
    record: 'Taj 2026-10-07 +₦5,920,240 "NIP FRM STORM SHIELD NIG LIMITED Refund"',
    field: 'supplier overpayment reversal (PO-KD-26-0079)',
    reason: 'OM 19 Oct: Storm Shield refunded the duplicate 11 Sep payment (TM-KD-26-2570 AP payment + TM-KD-26-2997 duplicate, each −₦5,920,240 on Taj)',
    ops: [{
      kind: 'supplierOverpaymentReversal', poId: 'PO-KD-26-0079', amountNgn: 5920240, expectedPaidBeforeNgn: 11620330,
      duplicateMovementIds: ['TM-KD-26-2570', 'TM-KD-26-2997'], date: '2026-10-07', treasuryAccountId: TAJ, branchId: BR,
      reference: 'BANK-TAJ-2026-10-07-STORM',
      note: 'Storm Shield refund of the duplicate 11 Sep payment (TM-KD-26-2997) — Taj 7 Oct, OM 19 Oct',
    }],
    expectDeltaNgn: d(5920240),
    expectTypes: ['SUPPLIER_OVERPAYMENT_REVERSAL'],
  },
  ...[
    ['T1-4a', 'TM-KD-26-3111', 'LE-KD-26-1989 jonnatan client ₦6,427,220', '2026-10-05', '2026-10-01', 'Taj 1 Oct "NIP FRM SAMAILA ALIYU MOBILE TRF TO TAJ" ₦6,427,220'],
    ['T1-4b', 'TM-KD-26-3151', 'LE-KD-26-2020 shuaibu roofer ₦715,000', '2026-10-07', '2026-10-05', 'Taj 5 Oct "NIP FRM IBRAHIM AUWAL YAHAYA" ₦715,000'],
  ].map(([id, movementId, rec, before, after, bank]) => ({
    id,
    group: 'A',
    record: `${movementId} (${rec})`,
    field: 'treasury posting date',
    reason: `Bank date: ${bank}`,
    ops: [{ kind: 'redateTreasury', movementId, before, after, note: `Bank date ${after} (${bank}) — OM 19 Oct` }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  })),
  ...[
    ['T1-6a', null, 'Yunusa Ahmed', 49000, '2026-10-01', 'NIP FRM YUNUSA AHMED MOBUTOZAPS ALUMINIU'],
    ['T1-6b', null, 'Yunusa Ahmed', 9800, '2026-10-19', 'NIP FRM YUNUSA AHMED Col'],
    ['T1-6c', 'CUS-KD-26-0973', 'HARUNA MOHD', 35000, '2026-10-09', 'NIP FRM MUHAMMAD HARUNA ABDULLAHI DGBNK2'],
  ].map(([id, customerId, customerName, amountNgn, date, narration]) => ({
    id,
    group: 'A',
    record: `Taj ${date} +₦${amountNgn.toLocaleString('en-NG')} "${narration}"`,
    field: 'customer advance (no open quotation)',
    reason: `OM 19 Oct: customer purchase; no open quotation for the payer → customer advance`,
    ops: [{
      kind: 'customerAdvance', ...(customerId ? { customerId } : {}), customerName, amountNgn, date, treasuryAccountId: TAJ, branchId: BR,
      paymentMethod: TAJ_METHOD, bankReference: `${narration} ₦${amountNgn.toLocaleString('en-NG')} Taj ${date}`,
      note: `Taj ${date} "${narration}" — no open quotation; advance raised by OM 19 Oct (handler Muhammad Ibrahim Bakari)`,
    }],
    expectDeltaNgn: d(amountNgn),
    expectTypes: ['ADVANCE_IN', 'RECEIPT_IN'],
  })),
];

// T1-8 — Taj October charges, one line per day (stamp duty ₦50 per debit, NIP fee ₦53.75 per outward transfer,
// SMS ₦979.20 on 9 Oct), rounded with carry. Fees of the held lines (Twenty percent, LINK) are on the bank → included.
const DAILY = [
  ['2026-10-02', 103.75, 'Nails payment: NIP fee ₦53.75 + stamp duty ₦50'],
  ['2026-10-05', 207.5, 'Aluminium EAS + Chairman zap: 2 × NIP fee ₦53.75 + 2 × stamp duty ₦50'],
  ['2026-10-06', 103.75, 'Loan repayment: NIP fee ₦53.75 + stamp duty ₦50'],
  ['2026-10-09', 979.2, 'SMS charges for September 2026 ₦979.20'],
  ['2026-10-12', 311.25, 'Aluzinc GCC + Aluminium E-Best + Twenty percent: 3 × NIP fee ₦53.75 + 3 × stamp duty ₦50'],
  ['2026-10-15', 207.5, 'Aluzinc LINK + Aluzinc CHIN: 2 × NIP fee ₦53.75 + 2 × stamp duty ₦50'],
];
let cum = 0;
let posted = 0;
for (const [date, kobo, what] of DAILY) {
  cum += kobo;
  const amountNgn = Math.round(cum) - posted;
  posted += amountNgn;
  items.push({
    id: `T1-8-${date.slice(5)}`,
    group: 'A',
    record: `Taj ${date} ₦${amountNgn}`,
    field: 'new expense (Bank charges)',
    reason: `Taj charges ${date} ₦${kobo.toLocaleString('en-NG')} (${what}); whole naira with rounding carried forward`,
    ops: [{ kind: 'postExpense', date, amountNgn, category: 'Bank charges', expenseType: 'Bank charges — Taj', paymentMethod: 'Bank', reference: `BC-TAJ-${date}`, treasuryAccountId: TAJ, branchId: BR }],
    expectDeltaNgn: d(-amountNgn),
    expectTypes: ['EXPENSE'],
  });
}
if (posted !== 1913) throw new Error(`Taj daily bank charges total ₦${posted}, expected ₦1,913`);

const dir = path.join(process.cwd(), 'exports/phase2-taj-oct');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'taj-round1-2026-10-19.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-19', source: 'OM 19 Oct 2026: Taj round 1 (items 1, 3, 4, 6, 8). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items; Taj net ₦${items.reduce((s, i) => s + i.expectDeltaNgn[TAJ], 0).toLocaleString('en-NG')}`);
