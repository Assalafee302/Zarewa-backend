#!/usr/bin/env node
/**
 * Phase 2 round 4 — Moniepoint (treasury account 4, Kaduna) alignment, Oct 2026. Writes the plan only (no DB access).
 * Owner approval 16 Oct 2026: TM-KD-26-3253 redate, 30 Sep alignment, READY rows of "Bank 1-13 Oct", bank charges.
 * CHECK→PROPOSE items are held (not in this plan). Every item is in group A (meant as one transaction — but the
 * MySQL wrapper commits nested ERP transactions, so the 16 Oct run was partly applied; rounds 5–6 use --per-item).
 * Source: Moniepoint_ERP_fix_Oct2026.xlsx + dry run
 * Moniepoint_ERP_fix_Oct2026_DRYRUN.xlsx.
 *
 *   node scripts/moniepoint-oct-plan4.mjs  →  exports/phase2-moniepoint-oct/round4-2026-10-16.plan.json
 *   node scripts/phase2-apply.mjs --live --database <schema> --plan <that file> --approver "Name"   (CHECK, no writes)
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const TAJ = 2;
const CASH = 3;
const BR = 'BR-KD';
const ref = (date, time) => `BANK-MP-${date}-${time.replace(':', '')}`;
const expense = (id, date, time, amountNgn, category, expenseType, reason) => ({
  id,
  group: 'A',
  record: `Moniepoint ${date} ${time} ₦${amountNgn.toLocaleString('en-NG')}`,
  field: `new expense (${category})`,
  reason,
  ops: [{ kind: 'postExpense', date, amountNgn, category, expenseType, paymentMethod: 'Bank', reference: ref(date, time), treasuryAccountId: MP, branchId: BR }],
});
const transfer = (id, date, time, toId, amountNgn, reason) => ({
  id,
  group: 'A',
  record: `Moniepoint ${date} ${time} ₦${amountNgn.toLocaleString('en-NG')} → ${toId === TAJ ? 'Taj' : 'Cash Office'}`,
  field: 'internal transfer (both sides)',
  reason,
  ops: [{ kind: 'internalTransfer', fromId: MP, toId, date, time: `${String(Number(time.slice(0, 2)) - 1).padStart(2, '0')}${time.slice(2)}`, amountNgn, reference: `${reason} (${ref(date, time)})`, branchId: BR }],
});

const items = [
  {
    id: 'R4-3253',
    group: 'A',
    record: 'TM-KD-26-3253 RECEIPT_REVERSAL_OUT −₦1,500,000 (Mal Sani Abdulrahman Zaria, LE-KD-26-1154)',
    field: 'treasury posting date',
    reason: 'Reverses TM-KD-26-1499 dated 16 Jul 2026 (Phase 2 C46) — a pre-October correction, belongs in the pre-October anchor',
    ops: [{ kind: 'redateTreasury', movementId: 'TM-KD-26-3253', before: '2026-10-14', after: '2026-07-16', note: 'Redated to the 16 Jul receipt it reverses (TM-KD-26-1499); owner 16 Oct 2026, schedule REC-MP-2026-09' }],
  },
  {
    id: 'R4-A38',
    group: 'A',
    record: 'RF-KD-26-9730 Suleiman Zaria (QT-KD-26-1715), TM-KD-26-3143 −₦1,753,330 on 5 Oct',
    field: 'refund amount + payout date',
    reason: 'Bank: Moniepoint 4 Oct ₦1,290,000 to Suleiman Adamu (09:46) + ₦463,000 via the OM account (16:05), book EX-1715 — refund corrected to ₦1,753,000',
    ops: [
      { kind: 'update', table: 'customer_refunds', keyCol: 'refund_id', key: 'RF-KD-26-9730', col: 'approved_amount_ngn', before: 1753330, after: 1753000 },
      { kind: 'update', table: 'customer_refunds', keyCol: 'refund_id', key: 'RF-KD-26-9730', col: 'amount_ngn', before: 1753330, after: 1753000 },
      {
        kind: 'refundRepay',
        refundId: 'RF-KD-26-9730',
        originalMovementId: 'TM-KD-26-3143',
        expectedPaidNgn: 1753330,
        reverseDate: '2026-10-05',
        payDate: '2026-10-04',
        amountNgn: 1753000,
        treasuryAccountId: MP,
        payeeName: 'Suleiman Adamu',
        note: 'Bank 4 Oct: ₦1,290,000 to Suleiman Adamu + ₦463,000 via Abdulrahman Uthman Sali (book EX-1715)',
      },
    ],
  },
  {
    id: 'R4-A103',
    group: 'A',
    record: 'RF-KD-26-9724 Abu Cap, TM-KD-26-3182 −₦1,941 on Taj 8 Oct',
    field: 'treasury account',
    reason: 'Bank: Moniepoint 8 Oct 14:40 ₦1,961 to Dahiru Jibrin (₦1,941 + ₦20 fee), book EX-1694; not on Taj',
    ops: [{ kind: 'moveTreasury', movementId: 'TM-KD-26-3182', fromAccountId: TAJ, fromDate: '2026-10-08', toAccountId: MP, toDate: '2026-10-08', note: 'Bank: Moniepoint 8 Oct ₦1,961 (Abu Cap refund, book EX-1694)' }],
  },
  {
    id: 'R4-A149',
    group: 'A',
    record: 'LE-KD-26-2094 Ibrahim Welder (QT-KD-26-1793), TM-KD-26-3230 ₦142,550',
    field: 'receipt amount (finance-confirmed)',
    reason: 'Bank and book RC-2094: ₦146,250 Moniepoint 13 Oct 08:45; ₦3,700 above the quotation balance becomes his overpayment credit',
    ops: [{ kind: 'receiptConfirmedAmount', receiptId: 'LE-KD-26-2094', movementId: 'TM-KD-26-3230', treasuryAccountId: MP, expectedNgn: 142550, amountNgn: 146250 }],
  },
  transfer('R4-A5', '2026-10-01', '11:54', TAJ, 2411727, 'Moniepoint → Taj sweep, September book closing'),
  expense('R4-A14', '2026-10-01', '18:20', 15000, 'Maintenance', 'Bricklayer labour — Adamu Hayatu (book EX-312; no PREQ-KD-26-0312 in the ERP)', 'Bank: Moniepoint 1 Oct 18:20 ₦15,000 to Adamu Hayatu "Briclayer"'),
  expense('R4-A36', '2026-10-03', '20:30', 222000, 'Maintenance', 'Accommodation & transport — Engr Walter (Anietie Walter Umoh)', 'Bank: Moniepoint 3 Oct 20:30 ₦222,020 (₦222,000 + ₦20 fee); book line 5 Oct'),
  transfer('R4-A49', '2026-10-05', '13:41', CASH, 100000, 'Moniepoint → Cash Office (book: Transfer to cash office)'),
  expense('R4-A86', '2026-10-07', '16:21', 20000, 'Staff loan', 'GM IOU — Bala Muazu Suleiman', 'Bank: Moniepoint 7 Oct 16:21 ₦20,020 "GM I O U" (₦20,000 + ₦20 fee)'),
  expense('R4-A105', '2026-10-09', '09:46', 417236, 'Fuel & lubricant', 'Diesel — Matrix Energy Ltd (bank ₦417,235.80)', 'Bank: Moniepoint 9 Oct 09:46 ₦417,235.80 to Matrix Energy; book label "EX-355 Transport" is wrong (PREQ-0355 is the ₦170,000 transport)'),
  transfer('R4-A109', '2026-10-09', '12:44', TAJ, 10000000, 'Moniepoint → Taj (book: Transfer to Taj bank)'),
  transfer('R4-A153', '2026-10-13', '12:05', TAJ, 4000000, 'Moniepoint → Taj (book line 13 Oct)'),
  expense('R4-A158', '2026-10-13', '17:25', 550000, 'Carriage inward', 'Transport — Bashir Idris', 'Bank: Moniepoint 13 Oct 17:25 ₦550,020 (₦550,000 + ₦20 fee); Bashir is always transport'),
  expense('R4-A164', '2026-10-13', '17:50', 22500, 'Maintenance', 'NEPA work — Haruna Yusuf', 'Bank: Moniepoint 13 Oct 17:50 ₦22,520 "NEPA work" (₦22,500 + ₦20 fee)'),
  expense('R4-FEES', '2026-10-15', '23:59', 8340, 'Bank charges', 'Bank charges — Moniepoint, Oct 2026', 'Sheet Fees 1–16 Oct 09:44: stamp duty ₦4,200 + VAT ₦139.50 + transfer/POS fees ₦4,000 = ₦8,339.50 → ₦8,340'),
  {
    id: 'R4-ALIGN',
    group: 'A',
    record: 'Moniepoint (treasury account 4) at 30 Sep 2026',
    field: 'statement alignment (BANK_RECON_ADJUSTMENT)',
    reason: 'Statement closing 30 Sep ₦3,411,799.04; ERP −₦10,753,432 after the TM-KD-26-3253 redate',
    ops: [
      {
        kind: 'bankAdjustment',
        treasuryAccountId: MP,
        date: '2026-09-30',
        amountNgn: 14165231,
        scheduleRef: 'REC-MP-2026-09',
        label: 'Pre-October alignment to Moniepoint statement (schedule REC-MP-2026-09)',
        balanceCutISO: '2026-09-30T23:00:00.000Z',
        expectedBalanceBeforeNgn: -10753432,
        checkModePendingNgn: -1500000,
        branchId: BR,
      },
    ],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/round4-2026-10-16.plan.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      createdAtISO: '2026-10-16',
      source: 'Owner approval 16 Oct 2026: TM-KD-26-3253 redate, 30 Sep alignment +14,165,231, READY rows of Bank 1-13 Oct, bank charges ₦8,340. CHECK→PROPOSE and NEED ANSWER rows held.',
      items,
    },
    null,
    1
  )
);
const net = items.flatMap((i) => i.ops).reduce((s, o) => {
  if (o.kind === 'postExpense') return s - o.amountNgn;
  if (o.kind === 'internalTransfer') return s - o.amountNgn;
  if (o.kind === 'bankAdjustment') return s + o.amountNgn;
  return s;
}, 0);
console.log(`wrote ${out} — ${items.length} items; Moniepoint net of new lines ₦${net.toLocaleString('en-NG')} (plus corrections +330, −1,941, +3,700)`);
