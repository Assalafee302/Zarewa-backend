#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 4 additions — owner 17 Oct 2026. Plan only (no DB access). No September dates.
 * F10 ERP dates = bank dates (RC-1968, EX-355 split, PO-89 transport, RF-9752, RF-9729 part 2); RF-9726 stays as it is
 * (owner, from the bank statement: ₦899,000 + ₦34,952 on 6 Oct both match the ERP). F12 rounding-close of the refund
 * remainders ≤ ₦200 left by B5 ("bank fee/rounding"); RF-KD-26-9734 ₦216 and RF-KD-26-9770 ₦260 are listed, not closed.
 *
 *   node scripts/moniepoint-oct-plan-r4b.mjs  →  exports/phase2-moniepoint-oct/mp-round4b-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();

const items = [
  {
    id: 'R4-F10a',
    group: 'A',
    record: 'TM-KD-26-3026 RC-1968 Nuhu Shittu ₦42,000',
    field: 'treasury posting date',
    reason: 'Bank A26: credited 2 Oct 17:05',
    ops: [{ kind: 'redateTreasury', movementId: 'TM-KD-26-3026', before: '2026-10-03', after: '2026-10-02', note: 'Bank date 2 Oct 17:05 (Moniepoint A26)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  // R4-F10b1/b2 (EX-355 split) left out: correcting a PAYMENT_REQUEST payout line does not update paid_amount_ngn or the
  // expense journal amount, so the ₦50,000 second payout would be refused and the GL would stay at ₦170,000.
  {
    id: 'R4-F10c',
    group: 'A',
    record: 'TM-KD-26-3184 PO-89 transport Bashir Idris ₦120,000 (9 Oct)',
    field: 'payout bank date',
    reason: 'Bank A94: ₦120,000 to Bashir Idris 8 Oct 01:15 (confirmed: the only ₦120,000 to Bashir that week besides EX-355 on 5 Oct)',
    ops: [{ kind: 'payoutLineCorrect', movementId: 'TM-KD-26-3184', expectedNgn: 120000, expectedDay: '2026-10-09', postedAtISO: utc('2026-10-08 01:15'), note: 'Bank date 8 Oct 01:15 (Moniepoint A94)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R4-F10d1',
    group: 'A',
    record: 'TM-KD-26-3190 RF-KD-26-9752 Ibrahim Zaria ₦342,000 (8 Oct)',
    field: 'payout bank date',
    reason: 'Bank A89 + A90 + A92: ₦203,000 + ₦40,000 + ₦99,000 on 7 Oct 19:28–19:52',
    ops: [{ kind: 'payoutLineCorrect', movementId: 'TM-KD-26-3190', expectedNgn: 342000, expectedDay: '2026-10-08', postedAtISO: utc('2026-10-07 19:52'), note: 'Bank 7 Oct: ₦203,000 + ₦40,000 + ₦99,000 (Moniepoint A89, A90, A92)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R4-F10d2',
    group: 'A',
    record: 'TM-KD-26-3187 RF-KD-26-9752 Ibrahim Zaria ₦84,840 (8 Oct)',
    field: 'payout bank date',
    reason: 'Bank A93: ₦84,840 via OM 7 Oct 19:53',
    ops: [{ kind: 'payoutLineCorrect', movementId: 'TM-KD-26-3187', expectedNgn: 84840, expectedDay: '2026-10-08', postedAtISO: utc('2026-10-07 19:53'), note: 'Bank 7 Oct 19:53 ₦84,840 via OM (Moniepoint A93)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R4-F10e',
    group: 'A',
    record: 'TM-KD-26-3146 RF-KD-26-9729 Ramaran Garkuwa part 2 ₦35,000 (6 Oct)',
    field: 'payout bank date',
    reason: 'Bank A91: ₦35,000 on 7 Oct 19:31 to IBRAHIM AHMED, GTB ****83237 — NOT the payout account on the refund / profile (OPay ****73153): exception reported, payee unchanged',
    ops: [{ kind: 'payoutLineCorrect', movementId: 'TM-KD-26-3146', expectedNgn: 35000, expectedDay: '2026-10-06', postedAtISO: utc('2026-10-07 19:31'), note: 'Bank date 7 Oct 19:31 (Moniepoint A91). Paid to IBRAHIM AHMED GTB ****83237, not the refund payout account OPay ****73153 — exception reported to the OM' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
];

// F12 — remainders ≤ ₦200 left by B5 (bank amount < amount recorded) closed as rounding.
const F12 = [
  ['RF-KD-26-9728', 40], ['RF-KD-26-9736', 76], ['RF-KD-26-9771', 70], ['RF-KD-26-9772', 16], ['RF-KD-26-9766', 20], ['RF-KD-26-9764', 80],
  ['RF-KD-26-9755', 8], ['RF-KD-26-9778', 80], ['RF-KD-26-9777', 100], ['RF-KD-26-9780', 140], ['RF-KD-26-9781', 56],
];
for (const [refundId, rem] of F12) {
  items.push({
    id: `R4-F12-${refundId.slice(-4)}`,
    group: 'A',
    record: refundId,
    field: 'refund remainder (rounding)',
    reason: `Owner F12: remainder ₦${rem} after the payout was set to the bank amount (B5) — bank fee/rounding`,
    ops: [{ kind: 'refundRoundingClose', refundId, expectedRemainderNgn: rem, reasonNote: 'bank fee/rounding' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  });
}

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round4b-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: round 4 additions F10 (bank dates) and F12 (rounding). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
