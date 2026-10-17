#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) round 6 — owner 17 Oct 2026. Plan only (no DB access). No September dates.
 *   1  Gabdo QT-KD-26-1777: refund REQUEST "Accessory shortfall (nails)" ₦140,000 (Pending; approval by Suleiman Abdullahi
 *      Liman or the MD in the app). The payout (B21, 14 Oct, to …6183) is a later item once approved.
 *   2  PO-KD-26-0092 Bashir Idris haulage paid from Moniepoint 16 Oct 17:53 ₦140,000 (the agreed fee on the PO is not
 *      raised: the ERP refuses a higher agreed haulage on a received PO).
 *
 *   node scripts/moniepoint-oct-plan-r6.mjs  →  exports/phase2-moniepoint-oct/mp-round6-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MP = 4;
const d = (mp) => ({ 4: mp, 2: 0, 3: 0 });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();

const items = [
  {
    id: 'R6-1a',
    group: 'A',
    record: 'QT-KD-26-1777 abbas gabdo — nails not supplied (95 quoted, 35 supplied)',
    field: 'refund request (Pending)',
    reason: 'Owner 17 Oct: OM edited production for the nails not supplied; refund ₦140,000 (56 packs × ₦2,500), paid B21 14 Oct',
    ops: [{ kind: 'refundRequestCreate', quotationRef: 'QT-KD-26-1777', amountNgn: 140000, category: 'Accessory shortfall', label: 'Accessory shortfall (nails): Drive screw nail 56 × ₦2,500', payeeName: 'abbas gabdo', requestedAtISO: utc('2026-10-14 09:00'), approverNote: 'Suleiman Abdullahi Liman or the MD (Mustapha Ibn Sali)' }],
    expectDeltaNgn: d(0),
    expectTypes: [],
  },
  {
    id: 'R6-2',
    group: 'A',
    record: 'PO-KD-26-0092 E-Best Aluminium Abuja — haulage Bashir Idris (fee on PO ₦100,000)',
    field: 'PO transport payout (bank)',
    reason: 'Bank 16 Oct 17:53: ₦140,000 to BASHIR IDRIS (OPay) + ₦20 fee; OM: actual haulage cost',
    ops: [{ kind: 'poTransportPay', poId: 'PO-KD-26-0092', agentName: 'Bashir Idris', amountNgn: 140000, treasuryAccountId: MP, postedAtISO: utc('2026-10-16 17:53'), reference: 'BANK-MP-202610161753', expectedLinesBefore: 0, note: 'Haulage PO-92 paid 16 Oct 17:53 to Bashir Idris (OPay), actual cost ₦140,000 on OM instruction.' }],
    expectDeltaNgn: d(-140000),
    expectTypes: ['TRANSPORT_PAYMENT'],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round6-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: round 6 (Gabdo nails refund request, PO-92 haulage). --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
