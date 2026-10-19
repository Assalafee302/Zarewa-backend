#!/usr/bin/env node
/**
 * OM 19 Oct 2026 (evening) — round 2. Plan only (no DB access). --per-item, one --only <id> per run.
 *   R2-1   RF-KD-26-9796 Adam Suleiman: the 11:44 approval (from a screen loaded before CF-10) wrote back ₦268,120 and
 *          the old lines; restore approved ₦303,120 + CF-10 lines, company cut ₦9,220 → ₦10,424 (RCR-KD-26-0150).
 *   R2-2a  RF-KD-26-9790 Gabdo ₦140,000 (nails): paid by the bank 14 Oct 18:47 Moniepoint B21 to GABDO MUSA ADAMU
 *          First Bank ****61830 (= profile account 3051161830) → payout record, so it cannot be paid again.
 *   R2-2b  bank row BKR-KD-26-1711 (Review) → Matched to that payout line.
 *   R2-4   Taj (2) stored balance = ledger: closes the ₦8,533,781 left by the 14 Oct opening change (B14).
 *
 *   node scripts/taj-oct-plan-r2.mjs  →  exports/phase2-taj-oct/taj-round2-2026-10-19.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const d = (o = {}) => ({ 2: 0, 3: 0, 4: 0, ...o });
const utc = (lagos) => new Date(`${lagos.replace(' ', 'T')}:00+01:00`).toISOString();

const items = [
  {
    id: 'R2-1',
    group: 'A',
    record: 'RF-KD-26-9796 Adam Suleiman (QT-KD-26-1818), Approved ₦268,120, unpaid',
    field: 'approved amount + calculation lines + company cut',
    reason:
      'OM 19 Oct: CF-10 (11:14 UTC) set the refund to ₦303,120 on the confirmed ₦1,714,000; the approval at 11:44 UTC by Suleiman Abdullahi Liman was made from a screen loaded before CF-10 and wrote back ₦268,120 and the old ₦239,960 overpayment line. Restore ₦303,120 (Pending-only review means it cannot be re-approved in the app).',
    ops: [{
      kind: 'refundApprovalRestore', refundId: 'RF-KD-26-9796', approvedBeforeNgn: 268120, approvedAfterNgn: 303120, cutBeforeNgn: 9220, cutAfterNgn: 10424,
      lines: [
        { label: 'Overpayment on QT-KD-26-1818', amountNgn: 274960, category: 'Overpayment' },
        { label: 'Price above floor (quoted ₦/m minus workbook floor ₦/m × produced metres at quoted gauge): ₦28,160', amountNgn: 28160, category: 'Customer commission' },
      ],
      reason: 'Approval restored to ₦303,120 (CF-10, confirmed ₦1,714,000); the 11:44 approval used a pre-CF-10 screen — OM 19 Oct',
    }],
    expectDeltaNgn: d(),
    expectTypes: [],
  },
  {
    id: 'R2-2a',
    group: 'A',
    record: 'RF-KD-26-9790 abbas gabdo ₦140,000 (QT-KD-26-1777, nails), Approved 19 Oct, unpaid',
    field: 'refund payout (Moniepoint, bank date 14 Oct 18:47)',
    reason: 'OM 19 Oct: the bank already paid it — Moniepoint B21 14 Oct 18:47 ₦140,020 "nails refund" to GABDO MUSA ADAMU First Bank ****61830 (₦140,000 + ₦20 fee, fee in BC-MP-2026-10-14)',
    ops: [{
      kind: 'refundPay', refundId: 'RF-KD-26-9790', expectedPaidBeforeNgn: 0,
      lines: [{ treasuryAccountId: 4, amountNgn: 140000, postedAtISO: utc('2026-10-14 18:47'), reference: 'BANK-MP-2026-10-14-1847', note: 'Moniepoint B21 14 Oct 18:47 to GABDO MUSA ADAMU First Bank ****61830 (profile account 3051161830)' }],
      note: 'Nails refund paid by the bank 14 Oct 18:47 (Moniepoint B21) to GABDO MUSA ADAMU First Bank ****61830 — the account on the customer profile (3051161830), paid before the 19 Oct approval.',
    }],
    expectDeltaNgn: d({ 4: -140000 }),
    expectTypes: ['REFUND_PAYOUT'],
  },
  {
    id: 'R2-2b',
    group: 'A',
    record: 'BKR-KD-26-1711 Moniepoint 14 Oct −₦140,020 "nails refund — to GABDO MUSA ADAMU" (Review)',
    field: 'bank_reconciliation_lines (Review → Matched)',
    reason: 'The payout line of R2-2a now exists',
    ops: [{ kind: 'reconMatchReviewRow', rowId: 'BKR-KD-26-1711', treasuryAccountId: 4, afterItem: 'R2-2a', note: 'fee 20', find: { day: '2026-10-14', type: 'REFUND_PAYOUT', amountNgn: -140000, sourceId: 'RF-KD-26-9790' } }],
    expectDeltaNgn: d(),
    expectTypes: [],
  },
  {
    id: 'R2-4',
    group: 'A',
    record: 'Taj (treasury account 2) stored balance ₦11,793,393 vs ledger ₦3,259,612',
    field: 'treasury_accounts.balance (stored = opening + movements)',
    reason:
      'OM 19 Oct: the 14 Oct opening change (B14, 21,401,720 → 12,867,939, −₦8,533,781) moved the opening only, so the stored balance kept the old opening; stored is set to the ledger so the account card shows the real figure.',
    ops: [{ kind: 'syncStoredBalance', treasuryAccountId: 2, expectedGapNgn: 8533781 }],
    expectDeltaNgn: d(),
    expectStoredGapChangeNgn: { 2: -8533781 },
    expectTypes: [],
  },
];

const dir = path.join(process.cwd(), 'exports/phase2-taj-oct');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'taj-round2-2026-10-19.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-19', source: 'OM 19 Oct 2026 evening: RF-9796 restore, RF-9790 payout record, Taj stored = ledger. --per-item, --only per run.', items }, null, 1));
console.log(`wrote ${out} — ${items.length} items`);
