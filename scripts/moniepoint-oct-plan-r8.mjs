#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 8 — owner 17 Oct 2026. Plan only (no DB access). No September dates except
 * the prepared R8b-5a (held, needs the owner's answer).
 *   R8   (post on OK)  1  daily bank charges: 16 Oct +₦72 (16 Oct = ₦172), 17 Oct ₦171; the 17 Oct VAT / stamp-duty
 *                        bank rows (Review) are then matched to the 17 Oct BC line.
 *   R8b  (prepared, NOT for posting until the owner answers)
 *        5a  Mrido LE-KD-26-1597 ₦20,000 (2 Sep, on hold, on the bank): audited September unlock → release hold →
 *            confirm → relock (relock always runs).
 *        5b  reversal of Babalele LE-KD-26-2006 ₦57,750 and Bashir Cap LE-KD-26-2084 ₦15,400 (no bank line).
 *        5c  finance confirmation of LE-KD-26-2167 Mamman Cap, LE-KD-26-2166 Abba Magaji, LE-KD-26-2051 Suleman
 *            Bello against their Matched bank-recon rows, in the OM's name.
 *
 *   node scripts/moniepoint-oct-plan-r8.mjs  →  exports/phase2-moniepoint-oct/mp-round8-2026-10-17.plan.json
 *                                              exports/phase2-moniepoint-oct/mp-round8b-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();
const bc = (id, date, amountNgn, at, reference, reason) => ({
  id,
  group: 'A',
  record: `Moniepoint ${date} ₦${amountNgn}`,
  field: 'new expense (Bank charges)',
  reason,
  ops: [{ kind: 'postExpense', date, postedAtISO: utc(at), amountNgn, category: 'Bank charges', expenseType: 'Bank charges — Moniepoint', paymentMethod: 'Bank', reference, treasuryAccountId: MP, branchId: 'BR-KD' }],
  expectDeltaNgn: d(-amountNgn),
  expectTypes: ['EXPENSE'],
});

const r8 = [
  bc('R8-1a', '2026-10-16', 72, '2026-10-16 17:54', 'BC-MP-2026-10-16b', 'Moniepoint charges 16 Oct after 09:44: ₦20 transfer fee + ₦1.50 VAT + ₦50 stamp duty (17:53, Bashir Idris PO-92) = ₦71.50 → ₦72; 16 Oct total ₦172'),
  bc('R8-1b', '2026-10-17', 171, '2026-10-17 15:59', 'BC-MP-2026-10-17', 'Moniepoint charges 17 Oct to 16:00: ₦100 POS fee (Wakili) + ₦20 transfer fee + ₦1.50 VAT + ₦50 stamp duty (car park) = ₦171.50 → ₦171'),
  {
    id: 'R8-1c',
    group: 'A',
    record: '17 Oct VAT ₦1.50 + stamp duty ₦50 (bank-recon Review rows)',
    field: 'bank_reconciliation_lines (Review → Matched)',
    reason: 'The 17 Oct charge lines now have their BC line (R8-1b)',
    ops: [{ kind: 'reconMatchToExpense', afterItem: 'R8-1b', expenseReference: 'BC-MP-2026-10-17', treasuryAccountId: MP, bankIds: ['MP-TRF|2MPT2dqhf|2111449024856592384_DEBIT_1', 'MP-TRF|2MPT2dqhf|2111449024856592384_DEBIT_2'] }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

const r8b = [
  {
    id: 'R8b-5a',
    group: 'A',
    record: 'LE-KD-26-1597 Alhaji Mrido ₦20,000 (2 Sep 2026, QT-KD-26-1427)',
    field: 'September unlock → hold release → finance confirm → relock',
    reason: 'Owner: the ₦20,000 is on the bank (in the 30 Sep statement balance); receipt held "no bank receipt"',
    ops: [{ kind: 'septReceiptConfirm', receiptId: 'LE-KD-26-1597', periodKey: '2026-09', amountNgn: 20000, holdStatus: 'Suspended — no bank receipt, awaiting credit check', unlockReason: 'confirm LE-KD-26-1597 Mrido ₦20,000 (on the bank 2 Sep), owner 17 Oct; relocked straight after', relockReason: 'September 2026 closed', note: 'Bank received ₦20,000 on 2 Sep (in the 30 Sep statement balance). Hold cleared on the owner’s instruction 17 Oct 2026.' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  ...[
    ['R8b-5b1', 'LE-KD-26-2006', 'babalele', 57750, 'TM-KD-26-3125', '6 Oct', 11],
    ['R8b-5b2', 'LE-KD-26-2084', 'bashir cap', 15400, 'TM-KD-26-3221', '12 Oct', 5],
  ].map(([id, receiptId, name, amt, tm, day, days]) => ({
    id,
    group: 'A',
    record: `${receiptId} ${name} ₦${amt.toLocaleString('en-NG')} (${day}) — no bank line`,
    field: 'receipt reversal',
    reason: `Owner: no bank receipt after ${days} days; re-register if paid`,
    ops: [{ kind: 'receiptReverse', receiptId, expectedNgn: amt, expectedStatus: 'Pending clearance', expectedMovements: { [tm]: amt }, accountId: MP, requireNoBankLink: true, note: `No bank receipt after ${days} days; re-register if paid. Owner 17 Oct 2026.` }],
    expectDeltaNgn: d(-amt),
    expectTypes: ['RECEIPT_REVERSAL_OUT'],
  })),
  ...[
    ['R8b-5c1', 'LE-KD-26-2167', 'Mamman Cap Zaria (QT-KD-26-1828)', 1562900],
    ['R8b-5c2', 'LE-KD-26-2166', 'Abba Magaji', 195660],
    ['R8b-5c3', 'LE-KD-26-2051', 'Suleman Bello Zaria (QT-KD-26-1772)', 36500],
  ].map(([id, receiptId, name, amt]) => ({
    id,
    group: 'A',
    record: `${receiptId} ${name} ₦${amt.toLocaleString('en-NG')}`,
    field: 'finance confirmation (bank received)',
    reason: 'Owner: confirm against the bank-recon link (money on the Moniepoint statement), in the OM’s name',
    ops: [{ kind: 'receiptBankConfirm', receiptId, amountNgn: amt, expectedStatus: 'Pending clearance' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  })),
];

for (const [name, items, note] of [
  ['mp-round8-2026-10-17.plan.json', r8, 'Owner 17 Oct 2026: round 8 bank charges 16/17 Oct. --per-item.'],
  ['mp-round8b-2026-10-17.plan.json', r8b, 'Owner 17 Oct 2026: round 8 PREPARED ONLY (Mrido, reversals, confirmations) — not for posting until the owner answers. --per-item.'],
]) {
  const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct', name);
  fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: note, items }, null, 1));
  console.log(`wrote ${out} — ${items.length} items`);
}
