#!/usr/bin/env node
/**
 * Moniepoint (treasury account 4) — owner 17 Oct 2026: re-point four bank-recon links. Plan only (no DB access).
 * Round-3 September recon linked four early-October payouts to late-September bank lines; each payout's own bank
 * line is in October (narration / payee, request raised the day of the October line). The September row goes to
 * Review (it then has no ERP line of its amount), the October row becomes Matched. Recon links are metadata: no
 * money moves, no posting date changes.
 *
 *   node scripts/moniepoint-oct-plan-repoint.mjs  →  exports/phase2-moniepoint-oct/mp-oct-repoint-2026-10-17.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const P = [
  ['TM-KD-26-2946', 'BKR-KD-26-0868', 'BKR-KD-26-1381', 'PREQ-0313 Khalifa school registration ₦35,000 (requested and paid 1 Oct); bank 1 Oct to MUSTAPHA USMAN SALI "khalifah school registration"', ''],
  ['TM-KD-26-3014', 'BKR-KD-26-0989', 'BKR-KD-26-1394', 'PREQ-0326 tax clearance certificate ₦20,000 (requested and paid 2 Oct); bank 2 Oct to Bala Muazu Suleiman "Gm request through Abdulrahman"', 'fee 20'],
  ['TM-KD-26-3042', 'BKR-KD-26-0905', 'BKR-KD-26-1398', 'PREQ-0318 pure water ₦6,000 (requested and paid 2 Oct); bank 2 Oct to SHAIBU ABDULLAHI "pure water and delievery of cement"', 'fee 20'],
  ['TM-KD-26-3044', 'BKR-KD-26-0898', 'BKR-KD-26-1410', 'PREQ-0333 Metral machine ₦16,000 (requested and paid 3 Oct); bank 3 Oct to SULEIMAN HAMMED "Metral machine"', 'fee 20'],
];
const items = P.map(([movementId, fromId, toId, reason, toNote], i) => ({
  id: `R9-repoint-${i + 1}`,
  group: 'A',
  record: `${movementId}: ${fromId} (Sep) → ${toId} (Oct)`,
  field: 'bank_reconciliation_lines.system_match / status',
  reason: `Owner 17 Oct: link re-pointed to the October bank line. ${reason}`,
  ops: [{ kind: 'reconRepoint', movementId, fromId, toId, toNote, reason: 'owner 17 Oct: the payout is the October bank line; this September line has no ERP line of its amount' }],
  expectDeltaNgn: { 4: 0, 2: 0, 3: 0 },
  expectTypes: [],
}));
const out = path.join(process.cwd(), 'exports/phase2-moniepoint-oct/mp-oct-repoint-2026-10-17.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-17', source: 'Owner 17 Oct 2026: re-point four Sep→Oct recon links. --per-item.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
