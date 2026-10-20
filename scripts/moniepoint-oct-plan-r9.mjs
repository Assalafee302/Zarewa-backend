#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 9 — owner 17 Oct 2026. Plan only (no DB access). No September dates.
 *   R9-1  Shafiu Abdullahi ₦4,000: PREQ-KD-26-0360 (grass spraying, approved) paid from Moniepoint 16 Oct 15:08 —
 *         paid before Pay was recorded; bank row BKR-KD-26-1735 then matched.
 *   R9-2  money received with no quotation yet → customer advance (the ERP's place for it), raised by the OM, handler
 *         Bakari, "advance — quotation to follow": Hamza Garba ₦351,875 (17 Oct 12:13, BKR-KD-26-1742, CUS-KD-26-1160)
 *         and Fifth Chukker Polo ₦81,600 (15 Oct, BKR-KD-26-1730, new customer). Bank rows then matched.
 *   (Yusuf Aliyu: held until the owner confirms his account.)
 *
 *   node scripts/moniepoint-oct-plan-r9.mjs  →  exports/phase2-moniepoint-oct/mp-round9-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const match = (id, rowId, find, afterItem, note) => ({
  id,
  group: 'A',
  record: `${rowId} (bank-recon Review row)`,
  field: 'bank_reconciliation_lines (Review → Matched)',
  reason: `Bank line now has its ERP line (${afterItem})`,
  ops: [{ kind: 'reconMatchReviewRow', rowId, treasuryAccountId: MP, find, afterItem, note }],
  expectDeltaNgn: d(0),
  expectTypes: [],
});
const advance = (id, customerId, customerName, amountNgn, date, rowId, bankText) => ({
  id,
  group: 'A',
  record: `${customerName} ₦${amountNgn.toLocaleString('en-NG')} (${date}, ${rowId})`,
  field: 'customer advance (cash received, quotation to follow)',
  reason: `Owner 17 Oct: money on the bank with no quotation yet — ${bankText}`,
  ops: [
    {
      kind: 'customerAdvance',
      ...(customerId ? { customerId } : {}),
      customerName,
      amountNgn,
      date,
      branchId: 'BR-KD',
      treasuryAccountId: MP,
      paymentMethod: 'Bank — Zarewa Aluminum & Plastics Ltd',
      bankReference: `${customerName} ₦${amountNgn} (Moniepoint ${date}, ${rowId})`,
      note: `advance — quotation to follow. Raised by the OM, handler Bakari (Muhammad Ibrahim Bakari). Bank: ${bankText}. Owner 17 Oct 2026.`,
    },
  ],
  expectDeltaNgn: d(amountNgn),
  expectTypes: ['ADVANCE_IN'],
});

const items = [
  {
    id: 'R9-1a',
    group: 'A',
    record: 'PREQ-KD-26-0360 spraying of grass factory ₦4,000 (approved, unpaid)',
    field: 'payment request payout (bank)',
    reason: 'Bank 16 Oct 15:08: ₦4,000 to SHAFIU ABDULLAHI (Moniepoint, no fee), BKR-KD-26-1735 — paid before Pay was recorded; OM instruction 17 Oct',
    ops: [{ kind: 'preqPay', requestId: 'PREQ-KD-26-0360', expectedPaidBeforeNgn: 0, payeeName: 'Shafiu Abdullahi', note: 'Paid before Pay was recorded; OM instruction 17 Oct. Payee Shafiu Abdullahi.', lines: [{ treasuryAccountId: MP, amountNgn: 4000, postedAtISO: utc('2026-10-16 15:08'), reference: 'BANK-MP-202610161508', note: 'Shafiu Abdullahi — grass spraying (BKR-KD-26-1735)' }] }],
    expectDeltaNgn: d(-4000),
    expectTypes: ['PAYMENT_REQUEST_OUT'],
  },
  match('R9-1b', 'BKR-KD-26-1735', { type: 'PAYMENT_REQUEST_OUT', amountNgn: -4000, day: '2026-10-16', sourceId: 'PREQ-KD-26-0360' }, 'R9-1a', ''),
  advance('R9-2a', 'CUS-KD-26-1160', 'hamza garba', 351875, '2026-10-17', 'BKR-KD-26-1742', 'NIP from HAMZA GARBA (Taj Bank) 17 Oct 12:13'),
  match('R9-2b', 'BKR-KD-26-1742', { type: 'ADVANCE_IN', amountNgn: 351875, day: '2026-10-17' }, 'R9-2a', 'customer advance'),
  advance('R9-2c', null, 'Fifth Chukker Polo', 81600, '2026-10-15', 'BKR-KD-26-1730', 'NIP from FIFTH CHUKKER POLO & COUNTRY CLUB (Access Bank) 15 Oct, "Ridge Cap for Temp Stables"'),
  match('R9-2d', 'BKR-KD-26-1730', { type: 'ADVANCE_IN', amountNgn: 81600, day: '2026-10-15' }, 'R9-2c', 'customer advance'),
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round9-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: round 9 (Shafiu payout, Hamza / Fifth Chukker advances). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
