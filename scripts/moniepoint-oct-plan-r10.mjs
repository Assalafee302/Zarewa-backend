#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 10 — owner 19 Oct 2026. Plan only (no DB access).
 *   R10-1  RF-KD-26-9790 Gabdo nails (Accessory shortfall 56 × ₦2,500 = ₦140,000), approved by Suleiman Abdullahi
 *          Liman 19 Oct: payout B21 already made 14 Oct 18:47 from Moniepoint, ₦140,000 + ₦20 fee, to GABDO MUSA ADAMU
 *          First Bank ****6183 — NOT the profile account ****1830 (exception reported; profile unchanged).
 *   R10-2  bank row BKR-KD-26-1711 (14 Oct −₦140,020, Review) matched to the payout line.
 *
 *   node scripts/moniepoint-oct-plan-r10.mjs  →  exports/phase2-moniepoint-oct/mp-round10-2026-10-19.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });

const items = [
  {
    id: 'R10-1',
    group: 'A',
    record: 'RF-KD-26-9790 abbas gabdo (QT-KD-26-1777), Accessory shortfall 56 nails packs, approved ₦140,000',
    field: 'refund payout (bank)',
    reason: 'B21: bank 14 Oct 18:47 ₦140,000 (+₦20 fee) to GABDO MUSA ADAMU First Bank ****6183 — non-profile account (profile ****1830 unchanged), exception',
    ops: [
      {
        kind: 'refundPay',
        refundId: 'RF-KD-26-9790',
        expectedPaidBeforeNgn: 0,
        note: 'B21 nails refund paid 14 Oct to GABDO MUSA ADAMU First Bank ****6183 — EXCEPTION: not the profile account (****1830); profile unchanged.',
        lines: [{ treasuryAccountId: MP, amountNgn: 140000, postedAtISO: '2026-10-14T17:47:30.000Z', reference: 'BANK-MP-202610141847', note: 'B21: GABDO MUSA ADAMU First Bank ****6183 (non-profile account, exception)' }],
      },
    ],
    expectDeltaNgn: d(-140000),
    expectTypes: ['REFUND_PAYOUT'],
  },
  {
    id: 'R10-2',
    group: 'A',
    record: 'BKR-KD-26-1711 (14 Oct −₦140,020, Review)',
    field: 'bank_reconciliation_lines (Review → Matched)',
    reason: 'Bank line now has its ERP line (R10-1)',
    ops: [{ kind: 'reconMatchReviewRow', rowId: 'BKR-KD-26-1711', treasuryAccountId: MP, find: { type: 'REFUND_PAYOUT', amountNgn: -140000, day: '2026-10-14', sourceId: 'RF-KD-26-9790' }, afterItem: 'R10-1', note: 'fee 20; non-profile account ****6183 (exception)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round10-2026-10-19.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-19', source: 'Owner 19 Oct 2026: RF-KD-26-9790 approved (Suleiman) — record payout B21. --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
