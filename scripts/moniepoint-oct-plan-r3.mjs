#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 3 — owner instruction 17 Oct 2026. Plan only (no DB access). No September dates.
 * New refunds are created as REQUESTS by the owner; approval is by Suleiman Abdullahi Liman or the MD in the app, and
 * their payouts are a later round. RF-KD-26-9782 waits for a decision on its approved amount (see the dry-run report).
 *
 *   node scripts/moniepoint-oct-plan-r3.mjs  →  exports/phase2-moniepoint-oct/mp-round3-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const TAJ = 2;
const CASH = 3;
const BR = 'BR-KD';
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const line = (row, lagos, amountNgn, note) => ({ treasuryAccountId: MP, amountNgn, postedAtISO: utc(lagos), reference: `BANK-MP-${lagos.replace(/[ :-]/g, '').slice(0, 12)}`, note: `${row}: ${note}` });
const d = (mp, other = {}) => ({ [MP]: mp, [TAJ]: 0, [CASH]: 0, ...other });
const APPROVER = 'Approval by Suleiman Abdullahi Liman or the MD (Mustapha Ibn Sali) in the ERP — not self-approved';
const request = (id, quotationRef, category, label, amountNgn, payeeName, reason) => ({
  id,
  group: 'A',
  record: `${quotationRef} ${category} ₦${amountNgn.toLocaleString('en-NG')}`,
  field: 'refund request (Pending)',
  reason,
  ops: [{ kind: 'refundRequestCreate', quotationRef, category, label, amountNgn, payeeName, requestedAtISO: '2026-10-17T12:00:00.000Z', approverNote: APPROVER }],
  expectDeltaNgn: d(0),
  expectTypes: [],
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
  {
    id: 'R3-1',
    group: 'A',
    record: 'RF-KD-26-9786 Engr Attah Nicholas (QT-KD-26-1548), approved ₦4,659,453',
    field: 'refund payout (bank), partial',
    reason: 'Owner R3-1: B18 ₦2,801,000 to Attah Nicholas Ojah, B19 ₦200,000 Kofi Rockson, B20 ₦250,000 Giwa Ayuba (14 Oct) — customer, no 20%; balance stays open',
    ops: [{ kind: 'refundPay', refundId: 'RF-KD-26-9786', expectedPaidBeforeNgn: 0, note: 'Engr Attah refund, part payment (3 transfers)', lines: [
      line('B18', '2026-10-14 17:20', 2801000, 'Attah Nicholas Ojah (Zenith)'),
      line('B19', '2026-10-14 18:06', 200000, 'Kofi Rockson "attah"'),
      line('B20', '2026-10-14 18:07', 250000, 'Giwa Ayuba (OPay)'),
    ] }],
    expectDeltaNgn: d(-3251000),
    expectTypes: ['REFUND_PAYOUT'],
  },
  request('R3-2a', 'QT-KD-26-1394', 'Customer commission', 'Commission — QS Isa (paid to Abdullahi Isah, Moniepoint 1 Oct 09:58)', 1000000, 'Abdullahi Isah', 'Owner R3-2: bank A4 ₦1,000,000 to Abdullahi Isah = QS Isa commission'),
  request('R3-2b', 'QT-KD-26-1722', 'Customer commission', 'Commission on dark grey product — Jonathan Chukusa (Moniepoint 15 Oct 10:35)', 16600, 'Jonathan Chukusa', 'Owner R3-2: bank B24 ₦16,600 to Jonathan Chukusa = commission, full amount'),
  request('R3-3', 'QT-KD-26-1765', 'Overpayment', 'Overpayment on QT-KD-26-1765 — paid to Yusuf Aliyu (Moniepoint 9 Oct 12:55)', 886000, 'Yusuf Aliyu', 'Owner R3-3: bank A110 ₦886,000 to Yusuf Aliyu = refund of QT-1765 overpayment (credit ₦1,029,920), customer, full'),
  {
    id: 'R3-4',
    group: 'A',
    record: 'AP-PO-PO-KD-26-0093 Sectook Aluminium Abuja (invoice ₦4,409,800, paid ₦1,409,800)',
    field: 'supplier payment (bank)',
    reason: 'Owner R3-4: bank B30 ₦500,000 to Mustapha Ibn Sali 15 Oct 16:49 = coil payment to Sectook through the MD',
    ops: [{ kind: 'apPay', apId: 'AP-PO-PO-KD-26-0093', treasuryAccountId: MP, amountNgn: 500000, expectedPaidBeforeNgn: 1409800, postedAtISO: utc('2026-10-15 16:49'), reference: 'Paid through MD Mustapha Ibn Sali (BANK-MP-202610151649)', note: 'paid through MD Mustapha Ibn Sali' }],
    expectDeltaNgn: d(-500000),
    expectTypes: ['AP_PAYMENT'],
  },
  {
    id: 'R3-5',
    group: 'A',
    record: 'LE-KD-26-2044 Mohammed Haruna (QT-KD-26-1764), TM-KD-26-3181 ₦1,351,540',
    field: 'receipt amount (finance-confirmed)',
    reason: 'Owner R3-5: bank A107 + A112 = ₦1,001,540 (9 Oct); the other ₦350,000 is on no Kaduna account. Quotation QT-1764 (₦1,305,079) becomes part-paid',
    ops: [{ kind: 'receiptConfirmedAmount', receiptId: 'LE-KD-26-2044', movementId: 'TM-KD-26-3181', treasuryAccountId: MP, expectedNgn: 1351540, amountNgn: 1001540 }],
    expectDeltaNgn: d(-350000),
    expectTypes: [],
  },
  request('R3-6', 'QT-KD-26-1777', 'Accessory shortfall', 'Accessory shortfall (nails) — drive screw nails on QT-KD-26-1777 (Moniepoint 14 Oct 18:47 "nails refund")', 140000, 'Gabdo Musa Adamu', 'Owner R3-6: bank B21 ₦140,000 to Gabdo Musa Adamu "nails refund", customer, full'),
  {
    id: 'R3-7a',
    group: 'A',
    record: 'RF-KD-26-9782 Jibril Sule (QT-KD-26-1794): approved ₦139,095, stored Paid with no payout line',
    field: 'refund approved amount',
    reason: 'Owner decision 17 Oct: approved = credit applied ₦1,097,920 (to QT-KD-26-1795) + cash ₦139,095 = ₦1,237,015',
    ops: [{ kind: 'update', table: 'customer_refunds', keyCol: 'refund_id', key: 'RF-KD-26-9782', col: 'approved_amount_ngn', before: 139095, after: 1237015 }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R3-7b',
    group: 'A',
    record: 'RF-KD-26-9782 Jibril Sule',
    field: 'refund payout (bank)',
    reason: 'Owner R3-7: bank B15 ₦139,020 to Sule Jibrin 14 Oct 17:17 (₦139,000 + ₦20 fee) = cash part of RF-9782',
    ops: [{ kind: 'refundPay', refundId: 'RF-KD-26-9782', repairPaidFirst: true, approvedAfterNgn: 1237015, expectedPaidBeforeNgn: 1097920, note: 'Jibril Sule refund, cash part', lines: [line('B15', '2026-10-14 17:17', 139000, 'Sule Jibrin (GTB)')] }],
    expectDeltaNgn: d(-139000),
    expectTypes: ['REFUND_PAYOUT'],
  },
  { id: 'R3-7c', group: 'A', record: 'RF-KD-26-9782 Jibril Sule', field: 'refund remainder (rounding)', reason: 'Owner R3-7: close ₦95 as rounding (₦139,095 cash part − ₦139,000 paid)', ops: [{ kind: 'refundRoundingClose', refundId: 'RF-KD-26-9782', expectedRemainderNgn: 95, afterItem: 'R3-7b' }], expectDeltaNgn: d(0), expectTypes: [] },
  expense('R3-8a', '2026-10-14', 18000, 'Maintenance', 'Transformer mason/pole work — Muhammad Idris', 'Owner R3-8: bank B2 ₦18,020 "mason and pole work for transformer" 14 Oct 12:36 (₦18,000 + ₦20 fee)', 'BANK-MP-202610141236'),
  expense('R3-8b', '2026-10-05', 10000, 'Staff loan', 'GM IOU — Bala Muazu Suleiman (5 Oct)', 'Owner R3-8: bank A51 ₦10,020 to Bala Muazu "outstanding payout of PR" 5 Oct 17:17 (₦10,000 + ₦20 fee) = GM IOU', 'BANK-MP-202610051717'),
  {
    id: 'R3-9',
    group: 'A',
    record: 'LE-KD-26-2150 Adam Suleiman (QT-KD-26-1818), split ₦1,215,000 (TM-KD-26-3320) + ₦464,000 (TM-KD-26-3321)',
    field: 'receipt amount (finance-confirmed, split)',
    reason: 'Owner R3-9: bank B12 ₦1,250,000 (14 Oct 16:49) + B14 ₦464,000 → receipt ₦1,714,000; the ₦35,000 more becomes his credit',
    ops: [{ kind: 'receiptConfirmedSplit', receiptId: 'LE-KD-26-2150', movementId: 'TM-KD-26-3320', totalBeforeNgn: 1679000, totalAfterNgn: 1714000, lineBeforeNgn: 1215000, lineAfterNgn: 1250000 }],
    expectDeltaNgn: d(35000),
    expectTypes: [],
  },
  { id: 'R3-10a', group: 'A', record: 'RF-KD-26-9735 Adamu Ibrahim', field: 'refund remainder (rounding)', reason: 'Owner R3-10: close ₦60 as rounding (₦900 paid + ₦240 company cut of ₦1,200)', ops: [{ kind: 'refundRoundingClose', refundId: 'RF-KD-26-9735', expectedRemainderNgn: 60 }], expectDeltaNgn: d(0), expectTypes: [] },
  // R3-10b (RF-KD-26-9770 ₦240 write-off) dropped by the owner’s test (17 Oct): it closed the refund but left the ₦240 in the
  // customer’s overpayment credit and did not show in the refund report. The ₦240 stays owed to Suleiman Zaria.
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round3-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: Moniepoint round 3 (final). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items; Moniepoint net ₦${items.reduce((s, i) => s + i.expectDeltaNgn[MP], 0).toLocaleString('en-NG')}`);
