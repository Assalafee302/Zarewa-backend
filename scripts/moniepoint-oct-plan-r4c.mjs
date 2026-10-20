#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) — owner 17 Oct 2026: RC-2168 Mamman Cap Zaria is a double entry of RC-2167 (bank has
 * ONE payment ₦1,000,000 + ₦562,900 at 15:59 / 16:00). Cancel the later one with the ERP's own receipt reversal
 * (reverseReceiptEntry: ledger RECEIPT_REVERSAL, receipt → Reversed, both treasury lines reversed, GL reversal, quotation
 * paid re-synced). RC-2167 is not touched and not confirmed. Plan only (no DB access).
 *
 *   node scripts/moniepoint-oct-plan-r4c.mjs  →  exports/phase2-moniepoint-oct/mp-round4c-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const items = [
  {
    id: 'R4-G1',
    group: 'A',
    record: 'LE-KD-26-2168 RC-2168 Mamman Cap Zaria ₦1,562,900 (QT-KD-26-1828), double entry of RC-2167',
    field: 'receipt reversal',
    reason: 'Owner 17 Oct: bank has one Mamman Cap payment (₦1,000,000 15:59 + ₦562,900 16:00); RC-2168 is the double entry',
    ops: [
      {
        kind: 'receiptReverse',
        receiptId: 'LE-KD-26-2168',
        twinReceiptId: 'LE-KD-26-2167',
        expectedNgn: 1562900,
        expectedStatus: 'Pending clearance',
        expectedMovements: { 'TM-KD-26-3357': 1000000, 'TM-KD-26-3358': 562900 },
        accountId: 4,
        note: 'Double entry of RC-2167 (bank: one payment ₦1,000,000 + ₦562,900, 17 Oct 15:59/16:00). Cancelled on the owner’s instruction 17 Oct 2026.',
      },
    ],
    expectDeltaNgn: { 4: -1562900, 2: 0, 3: 0 },
    expectTypes: ['RECEIPT_REVERSAL_OUT'],
  },
];

const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-round4c-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: cancel duplicate RC-2168. --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
