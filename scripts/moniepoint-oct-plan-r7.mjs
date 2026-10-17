#!/usr/bin/env node
/**
 * Moniepoint round 7 — owner 17 Oct 2026. Plan only (no DB access). No September dates. Needs the refund-sums hotfix
 * (quotationActiveRefundedTotalNgn) in this worktree, else R7-1 is refused by the ERP's MySQL string-sum bug.
 *   R7-1  Gabdo QT-KD-26-1777 refund REQUEST "Accessory shortfall" 56 packs × ₦2,500 = ₦140,000 (Pending; approval by
 *         Suleiman Abdullahi Liman or the MD in the app). The label carries the quantity the ERP nets against the
 *         shortfall, so the other 4 packs stay open on the quote. Payout B21 (14 Oct, to ****6183 — exception, profile
 *         ****1830 unchanged) is a later item once approved.
 *   R7-2  PO-KD-26-0092 agreed haulage ₦100,000 → ₦140,000 (OM instruction, actual cost), audit like R5-4.
 *
 *   node scripts/moniepoint-oct-plan-r7.mjs  →  exports/phase2-moniepoint-oct/mp-round7-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();

const items = [
  {
    id: 'R7-1',
    group: 'A',
    record: 'QT-KD-26-1777 abbas gabdo — Drive screw nail: 95 quoted, 35 supplied, 60 short',
    field: 'refund request (Pending)',
    reason: 'Owner 17 Oct: nails not supplied, refund 56 packs × ₦2,500 = ₦140,000 (paid B21 14 Oct); 4 packs stay open on the quote',
    ops: [{ kind: 'refundRequestCreate', quotationRef: 'QT-KD-26-1777', amountNgn: 140000, category: 'Accessory shortfall', label: 'Accessory shortfall: Drive screw nail (56 × ₦2,500)', payeeName: 'abbas gabdo', requestedAtISO: utc('2026-10-14 09:00'), approverNote: 'Suleiman Abdullahi Liman or the MD (Mustapha Ibn Sali)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R7-2',
    group: 'A',
    record: 'PO-KD-26-0092 E-Best Aluminium Abuja — haulage Bashir Idris (paid ₦140,000, TM-KD-26-3384)',
    field: 'purchase_orders.transport_amount_ngn',
    reason: 'OM instruction 17 Oct — actual cost',
    ops: [{ kind: 'poHaulageFeeSet', poId: 'PO-KD-26-0092', before: 100000, after: 140000, expectedPaidNgn: 140000, note: 'OM instruction 17 Oct — actual cost' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round7-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: round 7 (Gabdo nails refund request, PO-92 haulage fee). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
