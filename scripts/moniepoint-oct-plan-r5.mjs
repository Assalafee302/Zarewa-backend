#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 5 — owner 17 Oct 2026. Plan only (no DB access). No September dates.
 *   1  EX-355 transport ₦170,000 split as the bank paid it: ₦120,000 5 Oct 19:11 (Bashir Idris, A52) + ₦50,000 9 Oct 16:19
 *      (via GM Bala Muazu, A113). Line TM-KD-26-3192 → ₦120,000 on 5 Oct, request paid and payout journal JE-KD-26-4670
 *      follow; then the ERP's own payout for the ₦50,000 (new line + journal).
 *   2  B4 Anas / Sanusi / Surajo: the quote was settled from overpay credit AND the customer paid the bank; the cash was
 *      reversed. The cash is posted back as a customer advance on the bank day (credit stays applied; quote unchanged).
 *   4  LE-KD-26-2051 Suleman Bello ₦36,500: hold released (money is on the bank, TM-KD-26-3185 9 Oct).
 *   (3  RF-KD-26-9734 / 9770: no item — the ERP cannot carry them as credit; see the report.)
 *
 *   node scripts/moniepoint-oct-plan-r5.mjs  →  exports/phase2-moniepoint-oct/mp-round5-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();

const advance = (id, customerId, customerName, amountNgn, date, receipt, bankNote) => ({
  id,
  group: 'A',
  record: `${receipt} ${customerName} ₦${amountNgn.toLocaleString('en-NG')} (cash reversed as "refund fund")`,
  field: 'customer advance (cash received)',
  reason: `Owner B4: bank received ₦${amountNgn.toLocaleString('en-NG')} on ${date} (${bankNote}); the quote was already paid from overpay credit, so the cash is the customer's advance`,
  ops: [{
    kind: 'customerAdvance', customerId, customerName, amountNgn, date, branchId: 'BR-KD', treasuryAccountId: MP,
    paymentMethod: 'Bank — Zarewa Aluminum & Plastics Ltd', bankReference: `${customerName} ₦${amountNgn} (bank ${date}; was ${receipt})`,
    note: `Cash received ${date} on ${receipt}; the quotation was settled from overpay credit and the cash was reversed as refund fund. Owner 17 Oct: cash kept as customer advance.`,
  }],
  expectDeltaNgn: d(amountNgn),
  expectTypes: ['ADVANCE_IN'],
});

const items = [
  {
    id: 'R5-1a',
    group: 'A',
    record: 'TM-KD-26-3192 EX-355 PREQ-KD-26-0355 transport ₦170,000 (6 Oct) + JE-KD-26-4670',
    field: 'payout line amount + bank date; request paid; payout journal',
    reason: 'Bank A52: ₦120,000 to Bashir Idris 5 Oct 19:11 (first part of EX-355)',
    ops: [{ kind: 'payoutLineCorrect', movementId: 'TM-KD-26-3192', expectedNgn: 170000, expectedDay: '2026-10-06', amountNgn: 120000, expectedPaidBeforeNgn: 170000, postedAtISO: utc('2026-10-05 19:11'), note: 'EX-355 part 1: bank 5 Oct 19:11 ₦120,000 to Bashir Idris (Moniepoint A52)' }],
    expectDeltaNgn: d(50000),
    expectTypes: [],
  },
  {
    id: 'R5-1b',
    group: 'A',
    record: 'PREQ-KD-26-0355 transport (₦50,000 left after R5-1a)',
    field: 'payment request payout (bank)',
    reason: 'Bank A113: ₦50,000 through GM Bala Muazu 9 Oct 16:19 (second part of EX-355)',
    ops: [{ kind: 'preqPay', requestId: 'PREQ-KD-26-0355', expectedPaidBeforeNgn: 120000, afterItem: 'R5-1a', note: 'EX-355 part 2, paid through GM Bala Muazu', lines: [{ treasuryAccountId: MP, amountNgn: 50000, postedAtISO: utc('2026-10-09 16:19'), reference: 'BANK-MP-202610091619', note: 'A113: EX-355 part 2 via GM Bala Muazu' }] }],
    expectDeltaNgn: d(-50000),
    expectTypes: ['PAYMENT_REQUEST_OUT'],
  },
  advance('R5-2a', 'CUS-KD-26-0036', 'Anas Cap Zaria', 4700, '2026-10-01', 'LE-KD-26-1926 (QT-KD-26-1685)', 'anas hamisu'),
  advance('R5-2b', 'CUS-KD-26-1103', 'Sanusi Dangiwa', 4000, '2026-10-05', 'LE-KD-26-1981 (QT-KD-26-1717)', 'sanusi dangiwa'),
  advance('R5-2c', 'CUS-KD-26-0700', 'SURAJO', 34650, '2026-10-06', 'LE-KD-26-2005 (QT-KD-26-1734)', 'surajo'),
  {
    id: 'R5-4',
    group: 'A',
    record: 'LE-KD-26-2051 Suleman Bello Zaria ₦36,500 (QT-KD-26-1772)',
    field: 'receipt status',
    reason: 'Owner: the money is on the bank (TM-KD-26-3185, 9 Oct); the "no bank receipt" hold is cleared',
    ops: [{ kind: 'receiptHoldRelease', receiptId: 'LE-KD-26-2051', movementId: 'TM-KD-26-3185', amountNgn: 36500, accountId: MP, before: 'Suspended — no bank receipt, awaiting credit check', after: 'Pending clearance', note: 'Bank received ₦36,500 on 9 Oct (TM-KD-26-3185). Hold cleared on the owner’s instruction 17 Oct 2026.' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round5-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: round 5 (EX-355 split, B4 advances, LE-2051 hold). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
