#!/usr/bin/env node
/**
 * Phase 2 rounds 5–6 — finish the Moniepoint (treasury account 4) round 4 after the 16 Oct partial run. Plans only.
 *
 * Round 5 (September stays locked): every round-4 item except the alignment, in plan order — the 7 already posted
 * must come back "already …" (idempotency) — plus two repairs: A36's missing journal + audit, RF-KD-26-9730's
 * missing 4 Oct payout journal. Each item carries the change it must make per account (verified by --per-item).
 * Round 6 (alone, September unlocked): the 30 Sep alignment, recomputed at run time against the statement.
 *
 *   node scripts/moniepoint-oct-plan5.mjs
 *   node scripts/phase2-apply.mjs --live --per-item --database <schema> --plan exports/phase2-moniepoint-oct/round5-2026-10-16.plan.json \
 *        --approver "Name" --progress exports/phase2-moniepoint-oct/round5-progress.jsonl          (CHECK; add --apply to post)
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'exports/phase2-moniepoint-oct');
const r4 = JSON.parse(fs.readFileSync(path.join(dir, 'round4-2026-10-16.plan.json'), 'utf8'));
const MP = 4;
const TAJ = 2;
const CASH = 3;

/** Per-account change each item makes when it posts, and the movement types it creates. */
function expectations(item) {
  const d = {};
  const add = (a, n) => (d[a] = (d[a] || 0) + n);
  const types = new Set();
  for (const op of item.ops) {
    if (op.kind === 'postExpense') { add(op.treasuryAccountId, -op.amountNgn); types.add('EXPENSE'); }
    if (op.kind === 'internalTransfer') { add(op.fromId, -op.amountNgn); add(op.toId, op.amountNgn); types.add('INTERNAL_TRANSFER_OUT').add('INTERNAL_TRANSFER_IN'); }
    if (op.kind === 'moveTreasury') { add(op.fromAccountId, 1941); add(op.toAccountId, -1941); }
    if (op.kind === 'refundRepay') add(op.treasuryAccountId, op.expectedPaidNgn - op.amountNgn);
    if (op.kind === 'receiptConfirmedAmount') add(op.treasuryAccountId, op.amountNgn - op.expectedNgn);
  }
  for (const a of [MP, TAJ, CASH]) d[a] ||= 0;
  return { expectDeltaNgn: d, expectTypes: [...types] };
}

const repairs = [
  {
    id: 'R5-A36-REPAIR',
    group: 'A',
    record: 'EXP-KD-26-0466 / TM-KD-26-3299 Engr Walter ₦222,000 (3 Oct)',
    field: 'expense journal + audit (repair)',
    reason: 'R4-A36 was cut off on 16 Oct after the expense row and treasury line: add the expense-payment journal and the expense.create / phase2 audit rows',
    ops: [{ kind: 'expenseGlRepair', expenseId: 'EXP-KD-26-0466', movementId: 'TM-KD-26-3299', amountNgn: 222000, repairOf: 'R4-A36' }],
  },
  {
    id: 'R5-RF9730-GL',
    group: 'A',
    record: 'RF-KD-26-9730 Suleiman Zaria, TM-KD-26-3143 −₦1,753,000 (4 Oct)',
    field: 'refund payout journal (repair)',
    reason: 'R4-A38 reversed JE-KD-26-4533 (JE-KD-26-4874) but its 4 Oct payout journal was skipped as a duplicate of the reversed one (same key) — post it keyed on the correction',
    ops: [{ kind: 'refundPayoutGlRepair', refundId: 'RF-KD-26-9730', movementId: 'TM-KD-26-3143', amountNgn: 1753000, payDate: '2026-10-04', reversedJournalIds: ['JE-KD-26-4533'], correctionId: 'R4-A38', repairOf: 'R4-A38' }],
  },
];

const items = [];
for (const it of r4.items.filter((i) => i.id !== 'R4-ALIGN')) {
  items.push({ ...it, ...expectations(it) });
  if (it.id === 'R4-A38') items.push({ ...repairs[1], ...expectations(repairs[1]) });
  if (it.id === 'R4-A36') items.push({ ...repairs[0], ...expectations(repairs[0]) });
}
const align = r4.items.find((i) => i.id === 'R4-ALIGN');
const alignOp = { ...align.ops[0], targetBalanceNgn: 3411799, checkModePendingNgn: 0 };
delete alignOp.expectedBalanceBeforeNgn;
const round6 = [{ ...align, id: 'R6-ALIGN', ops: [alignOp], expectDeltaNgn: { [MP]: alignOp.amountNgn, [TAJ]: 0, [CASH]: 0 }, expectTypes: ['BANK_RECON_ADJUSTMENT'] }];

const write = (name, list, source) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ createdAtISO: '2026-10-16', source, items: list }, null, 1));
  console.log(`wrote ${file} — ${list.length} items`);
};
write('round5-2026-10-16.plan.json', items, 'Owner 16 Oct 2026: finish round 4 with September LOCKED — repairs (A36 journal + audit, RF-KD-26-9730 payout journal) + the 8 remaining items; the 7 posted items re-checked for idempotency. --per-item.');
write('round6-2026-10-16.plan.json', round6, 'Owner 16 Oct 2026: alone, September unlocked for this item only — 30 Sep alignment to the Moniepoint statement (₦3,411,799), recomputed at run time.');
