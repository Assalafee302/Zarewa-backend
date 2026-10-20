#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 2 — owner instruction 16 Oct 2026, rows of Moniepoint_tieout_2026-10-16_0944.xlsx.
 * Only rows whose ERP record and amount are settled are planned here; rows needing a decision are in the dry-run report.
 * No September dates. Bank times are Lagos (UTC+1). ERP amount = bank amount − its own transfer fee (fees are in the
 * Oct bank-charges expense EXP-KD-26-0471).
 *
 *   node scripts/moniepoint-oct-plan-r2.mjs  →  exports/phase2-moniepoint-oct/mp-round2-2026-10-16.plan.json
 *   node scripts/phase2-apply.mjs --live --per-item --database <schema> --plan <that file> --approver "Name" --progress <jsonl>
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const TAJ = 2;
const CASH = 3;
const BR = 'BR-KD';
/** '2026-10-05 12:52' (Lagos) → ISO UTC */
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const line = (row, lagos, amountNgn, note) => ({ treasuryAccountId: MP, amountNgn, postedAtISO: utc(lagos), reference: `BANK-MP-${lagos.replace(/[ :]/g, '').slice(0, 12)}`, note: `${row}: ${note}` });
const d = (mp, other = {}) => ({ [MP]: mp, [TAJ]: 0, [CASH]: 0, ...other });

const refund = (id, refundId, expectedPaidBeforeNgn, lines, reason) => ({
  id,
  group: 'A',
  record: refundId,
  field: 'refund payout (bank)',
  reason,
  ops: [{ kind: 'refundPay', refundId, expectedPaidBeforeNgn, lines, note: reason }],
  expectDeltaNgn: d(-lines.reduce((s, l) => s + l.amountNgn, 0)),
  expectTypes: ['REFUND_PAYOUT'],
});
const expense = (id, date, amountNgn, category, expenseType, reason, ref) => ({
  id,
  group: 'A',
  record: `Moniepoint ${date} ₦${amountNgn.toLocaleString('en-NG')}`,
  field: `new expense (${category})`,
  reason,
  ops: [{ kind: 'postExpense', date, amountNgn, category, expenseType, paymentMethod: 'Bank', reference: ref, treasuryAccountId: MP, branchId: BR }],
  expectDeltaNgn: d(-amountNgn),
  expectTypes: ['EXPENSE'],
});

const items = [
  refund('R2-R1', 'RF-KD-26-9753', 0, [
    line('A48', '2026-10-05 12:52', 117000, 'Jonathan Chukusa "refund"'),
    line('A100', '2026-10-08 12:24', 1176670, 'Yusuf Abubakar "refund"'),
    line('A101', '2026-10-08 12:33', 205740, 'Abubakar Yusuf "refund"'),
  ], 'Jonnatan Client overpayment refund paid in 3 bank transfers (owner: A48 + A100 + A101 = ₦1,499,410, closes)'),
  refund('R2-R2', 'RF-KD-26-9776', 0, [
    line('A137', '2026-10-10 20:00', 1147000, 'Gabdo Musa Adamu (customer part)'),
    line('A138', '2026-10-10 20:47', 605600, 'via OM account (customer part)'),
    line('A139', '2026-10-10 20:47', 128480, 'staff part via OM (80% of ₦160,600)'),
  ], 'Abbas Gabdo: customer ₦1,752,600 + staff ₦128,480; company cut ₦32,120 already in the retention ledger (RCR-KD-26-0134) — closes'),
  refund('R2-R4', 'RF-KD-26-9770', 1487120, [line('A122', '2026-10-10 16:55', 100000, 'Suleiman Zaria via OM')], 'Suleiman Zaria staff payout via OM (owner R4); company cut ₦37,900 already credited (RCR-KD-26-0127) — remainder reported, not force-closed'),
  refund('R2-R5a', 'RF-KD-26-9784', 0, [line('B16', '2026-10-14 17:17', 2400, 'via Bakari (80%)')], 'Auwal Idiris staff 80% payout via Bakari; cut ₦600 already credited (RCR-KD-26-0140)'),
  refund('R2-R5b', 'RF-KD-26-9783', 0, [line('B17', '2026-10-14 17:17', 18440, 'via Bakari (80%)')], 'Yahya Abdullahi staff 80% payout via Bakari; cut ₦4,610 already credited (RCR-KD-26-0141)'),
  refund('R2-R6', 'RF-KD-26-9735', 0, [line('A78', '2026-10-06 18:53', 900, 'Adamu Ibrahim via OM')], 'Adamu Ibrahim payout ₦900 (owner R6); net due ₦960 after the ₦240 cut — remainder reported'),
  {
    id: 'R2-T1',
    group: 'A',
    record: 'Moniepoint 14 Oct 16:49 ₦1,500,000 → Taj',
    field: 'internal transfer (both sides)',
    reason: 'Bank B11: TRANSFER TO ZAPS ALUMINIUM ENTERPRISE TAJ (₦1,500,000 + ₦20 fee)',
    ops: [{ kind: 'internalTransfer', fromId: MP, toId: TAJ, date: '2026-10-14', time: '15:49', amountNgn: 1500000, reference: 'Moniepoint → Taj sweep (BANK-MP-202610141649)', branchId: BR }],
    expectDeltaNgn: d(-1500000, { [TAJ]: 1500000 }),
    expectTypes: ['INTERNAL_TRANSFER_OUT', 'INTERNAL_TRANSFER_IN'],
  },
  expense('R2-E1', '2026-10-06', 30000, 'Carriage inward', 'Transport for rolls — Nuhu Mikiyan (POS transfer)', 'Bank A66: POS Transfer NUHU MIKIYAN 6 Oct 17:04 ₦30,000', 'BANK-MP-202610061704'),
  {
    id: 'R2-E3',
    group: 'A',
    record: 'PREQ-KD-26-0358 FORK LIFT ₦30,000 (approved, unpaid)',
    field: 'payment request payout (bank)',
    reason: 'Bank B4 + B7 + B10 to Emmanuel Godwin Obochi on 14 Oct: forklift repair ₦20,000, filter ₦7,000, labour ₦3,000',
    ops: [{ kind: 'preqPay', requestId: 'PREQ-KD-26-0358', expectedPaidBeforeNgn: 0, note: 'Forklift repair, filter and labour — Emmanuel Godwin Obochi', lines: [
      line('B4', '2026-10-14 13:28', 20000, 'forklift repair'),
      line('B7', '2026-10-14 15:05', 7000, 'forklift filter'),
      line('B10', '2026-10-14 16:38', 3000, 'forklift labour'),
    ] }],
    expectDeltaNgn: d(-30000),
    expectTypes: ['PAYMENT_REQUEST_OUT'],
  },
  {
    id: 'R2-E4',
    group: 'A',
    record: 'PREQ-KD-26-0359 PURE WATER ₦5,000 (approved, unpaid)',
    field: 'payment request payout (bank)',
    reason: 'Bank B27: Yusuf Ahmad "pure water" 15 Oct 16:13 (₦5,000 + ₦20 fee)',
    ops: [{ kind: 'preqPay', requestId: 'PREQ-KD-26-0359', expectedPaidBeforeNgn: 0, note: 'Pure water — Yusuf Ahmad', lines: [line('B27', '2026-10-15 16:13', 5000, 'pure water')] }],
    expectDeltaNgn: d(-5000),
    expectTypes: ['PAYMENT_REQUEST_OUT'],
  },
  expense('R2-E5', '2026-10-12', 15000, 'Staff loan', 'GM IOU — Bala Muazu Suleiman (12 Oct)', 'Bank A146: Bala Muazu Suleiman 12 Oct 13:59 (₦15,000 + ₦20 fee)', 'BANK-MP-202610121359'),
  expense('R2-B26', '2026-10-15', 150000, 'Staff loan', 'GM IOU — Bala Muazu Suleiman (staff advance, 15 Oct)', 'Bank B26: Bala Muazu Suleiman OPay 15 Oct 15:21 (₦150,000 + ₦20 fee); owner: GM IOU', 'BANK-MP-202610151521'),
  expense('R2-A106', '2026-10-09', 30000, 'Office expenses', 'Internet subscription — Paystack checkout', 'Bank A106: PAYSTACK CHECKOUT 9 Oct 10:00 (₦30,000 + ₦20 fee); owner: internet subscription', 'BANK-MP-202610091000'),
  {
    id: 'R2-C1',
    group: 'A',
    record: 'LE-KD-26-1968 Nuhu Shittu (QT-KD-26-1705), TM-KD-26-3026 ₦22,000',
    field: 'receipt amount + method',
    reason: 'Bank A26: Moniepoint 2 Oct 17:05 ₦42,000; ₦20,000 above the quotation balance becomes his credit; method was labelled Cash Office',
    ops: [
      { kind: 'receiptConfirmedAmount', receiptId: 'LE-KD-26-1968', movementId: 'TM-KD-26-3026', treasuryAccountId: MP, expectedNgn: 22000, amountNgn: 42000 },
      { kind: 'relabelReceiptMethod', receiptId: 'LE-KD-26-1968', movementId: 'TM-KD-26-3026', accountId: MP, beforeMethod: 'Cash — Cash Office', afterMethod: 'Bank — Zarewa Aluminum & Plastics Ltd', beforeRefToken: 'Cash:Cash Office', afterRefToken: 'Bank:Zarewa Aluminum & Plastics Ltd' },
    ],
    expectDeltaNgn: d(20000),
    expectTypes: [],
  },
  {
    id: 'R2-C2',
    group: 'A',
    record: 'LE-KD-26-2042 Hakimi (QT-KD-26-1763), TM-KD-26-3180 ₦942,700',
    field: 'receipt amount',
    reason: 'Bank A104: ₦965,000 from Jibril Abdulmalik for Hakimi 8 Oct 16:11; excess ₦22,300 becomes Hakimi’s credit',
    ops: [{ kind: 'receiptConfirmedAmount', receiptId: 'LE-KD-26-2042', movementId: 'TM-KD-26-3180', treasuryAccountId: MP, expectedNgn: 942700, amountNgn: 965000 }],
    expectDeltaNgn: d(22300),
    expectTypes: [],
  },
  {
    id: 'R2-C4',
    group: 'A',
    record: 'TM-KD-26-3250 Sani Haruna ₦2,240 (LE-KD-26-2120) on Cash Office',
    field: 'treasury account',
    reason: 'Bank B6: Moniepoint 14 Oct 14:46 "Transfer from SANI HARUNA" ₦2,240 — not cash',
    ops: [{ kind: 'moveTreasury', movementId: 'TM-KD-26-3250', fromAccountId: CASH, fromDate: '2026-10-14', toAccountId: MP, toDate: '2026-10-14', amountNgn: 2240, note: 'Bank: Moniepoint 14 Oct 14:46 ₦2,240 from Sani Haruna' }],
    expectDeltaNgn: d(2240, { [CASH]: -2240 }),
    expectTypes: [],
  },
  {
    id: 'R2-C5a',
    group: 'A',
    record: 'TM-KD-26-3296 Imran Ibraheem Jafar ₦49,540 (LE-KD-26-2135) posted 16 Oct',
    field: 'treasury posting date',
    reason: 'Bank B29: ₦49,540 "8.2 long 0.24 gauge ivory" credited 15 Oct 16:47',
    ops: [{ kind: 'redateTreasury', movementId: 'TM-KD-26-3296', before: '2026-10-16', after: '2026-10-15', note: 'Bank date 15 Oct 16:47 (Moniepoint B29)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round2-2026-10-16.plan.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-16', source: 'Owner 16 Oct 2026: Moniepoint round 2 (refunds, transfers, expenses, receipts) — settled rows only. --per-item.', items }, null, 1));
const net = items.reduce((s, i) => s + i.expectDeltaNgn[MP], 0);
console.log(`wrote ${out} — ${items.length} items; Moniepoint net ₦${net.toLocaleString('en-NG')}`);
