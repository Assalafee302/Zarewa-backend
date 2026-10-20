#!/usr/bin/env node
/**
 * Taj (treasury account 2, 0006047389) August–September round 1 — owner decisions 19 Oct 2026 on the Aug–Sep Taj
 * report. Plan only (no DB access): reads exports/phase2-taj-oct/taj-augsep-context-readonly.json (from
 * scripts/taj-augsep-context-readonly.mjs) and refuses when a fact differs from the report. --per-item.
 *   TA-1 (P1)  Reverse TM-KD-26-3021, the Taj leg (−₦13,804,390, 31 Aug) of the 2 Oct balancing plug PREQ-KD-26-0330 /
 *              EXP-KD-26-0404, on 31 Aug with the inverse journal (Dr Taj cash / Cr 6100 Depreciation); request and
 *              expense reduced by the Taj leg only. Audited August unlock → post → relock.
 *   TA-4 (P4)  Abdullahi Mohammed: bank 451,770 on 2 Aug, receipt LE-KD-26-1323 451,000 → ₦770 customer advance on 2 Aug,
 *              linked to the TM-KD-26-1888 bank-recon row. August unlock → post → relock.
 *   TA-5 (P5)  Yunusa Ahmed CUS-KD-26-1165 ("Col"): 3 × ₦49,000 on 18, 19, 26 Sep → customer advances on the bank dates
 *              (as Taj round 1 did for 1 Oct / 19 Oct), each linked to its Review bank row. September unlock → relock.
 * HOLD: P1b Moniepoint leg TM-KD-26-3022 (Moniepoint Aug recon), P1c Cash Office leg TM-KD-26-3023 (cash count),
 *       P2 LE-KD-26-1359 / P3 LE-KD-26-1329 (owner reviews who confirmed), P6 26 Sep ₦120,000 (owner checks TM-2778 "felt").
 *
 *   node scripts/taj-augsep-plan-r1.mjs  →  exports/phase2-taj-oct/taj-augsep-r1-2026-10-19.plan.json
 */
import fs from 'node:fs';
import path from 'node:path';

const TAJ = 2;
const BR = 'BR-KD';
const TAJ_METHOD = 'Bank — Zaps Aluminum Enterprises';
const d = (taj) => ({ 2: taj, 3: 0, 4: 0 });
const dir = path.join(process.cwd(), 'exports/phase2-taj-oct');
const ctx = JSON.parse(fs.readFileSync(path.join(dir, 'taj-augsep-context-readonly.json'), 'utf8'));
const stop = (why) => {
  console.error(`STOP: ${why}`);
  process.exit(1);
};
const one = (rows, what) => {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].error) stop(`${what}: expected one row, got ${JSON.stringify(rows)}`);
  return rows[0];
};
const n = (v) => Math.round(Number(v) || 0);

for (const k of ['2026-08', '2026-09']) if (!ctx.locks.some((l) => l.period_key === k)) stop(`${k} is not locked — check with the owner before unlocking anything`);

// ---- P1 facts
const line = one(ctx.p1Line, 'TM-KD-26-3021');
if (line.type !== 'PAYMENT_REQUEST_OUT' || n(line.treasury_account_id) !== TAJ || n(line.amount_ngn) !== -13804390 || line.source_id !== 'PREQ-KD-26-0330') stop(`TM-KD-26-3021 is not the planned Taj leg: ${JSON.stringify(line)}`);
if (String(line.posted_at_iso).slice(0, 7) !== '2026-08') stop(`TM-KD-26-3021 is dated ${line.posted_at_iso}`);
if (ctx.p1Reversal.length) stop(`TM-KD-26-3021 already reversed: ${JSON.stringify(ctx.p1Reversal)}`);
const exp = one(ctx.p1Expense, 'EXP-KD-26-0404');
const pr = one(ctx.p1Request, 'PREQ-KD-26-0330');
const liveLegs = ctx.p1Legs.filter((l) => l.type === 'PAYMENT_REQUEST_OUT' && !ctx.p1Legs.some((r) => r.reverses_movement_id === l.id));
const legsNgn = -liveLegs.reduce((s, l) => s + n(l.amount_ngn), 0);
const before = { expenseNgn: n(exp.amount_ngn), requestedNgn: n(pr.amount_requested_ngn), paidNgn: n(pr.paid_amount_ngn), liveLegsNgn: legsNgn };
if (before.expenseNgn !== 32811891 || before.paidNgn !== 32610491 || before.liveLegsNgn !== 32301084) stop(`EXP-0404 / PREQ-0330 figures differ from the report: ${JSON.stringify(before)}`);
const je = ctx.p1Journal;
if (je.length !== 2 || !je.some((l) => l.code === '6100' && n(l.debit_ngn) === 13804390)) stop(`TM-KD-26-3021 journal is not Dr 6100 ₦13,804,390: ${JSON.stringify(je)}`);
const after = { expenseNgn: before.expenseNgn - 13804390, requestedNgn: before.requestedNgn - 13804390, paidNgn: before.paidNgn - 13804390, liveLegsNgn: before.liveLegsNgn - 13804390 };
const fmt = (o) => `expense ₦${o.expenseNgn.toLocaleString('en-NG')} / request ₦${o.requestedNgn.toLocaleString('en-NG')} requested, ₦${o.paidNgn.toLocaleString('en-NG')} paid / live legs ₦${o.liveLegsNgn.toLocaleString('en-NG')}`;

// ---- P4 facts
const le = one(ctx.p4Ledger, 'LE-KD-26-1323');
const p4Line = one(ctx.p4Line, 'TM-KD-26-1888');
if (n(p4Line.amount_ngn) !== 451000 || n(p4Line.treasury_account_id) !== TAJ) stop(`TM-KD-26-1888 is not ₦451,000 on Taj: ${JSON.stringify(p4Line)}`);
const p4Cust = one(ctx.p4Customer, `customer of LE-KD-26-1323 (${le.customer_id})`);
if (ctx.p4Advances.some((a) => n(a.amount_ngn) === 770)) stop(`₦770 advance already posted: ${JSON.stringify(ctx.p4Advances)}`);
if (ctx.p4Recon.length !== 1) console.warn(`note: ${ctx.p4Recon.length} bank-recon rows name TM-KD-26-1888 — the advance is posted, the recon row is ${ctx.p4Recon.length ? 'the first' : 'not'} updated`);

// ---- P5 facts
// P5 on hold (OM 19 Oct: until we know who Yunusa Ahmed is) — facts are read, TA-5 is built but left out of the plan.
const yun = ctx.p5Customer?.[0] || { name: 'Yunusa Ahmed' };
const P5 = ['2026-09-18', '2026-09-19', '2026-09-26'];
for (const day of P5) if ((ctx.p5Advances || []).some((a) => String(a.at_iso).startsWith(day) && n(a.amount_ngn) === 49000)) console.warn(`note: Yunusa ₦49,000 advance already posted on ${day}`);
const reviewRows = (day) => (ctx.p5Recon || []).filter((r) => r.bank_date_iso === day && n(r.amount_ngn) === 49000 && r.status === 'Review');

const items = [
  {
    id: 'TA-1',
    group: 'A',
    record: 'TM-KD-26-3021 Taj −₦13,804,390 31 Aug (PREQ-KD-26-0330 / EXP-KD-26-0404 "Account balnceing", Taj leg)',
    field: 'payment-request leg reversal (PAYMENT_REQUEST_REVERSAL_IN + GL unwind), request / expense reduced by the leg',
    reason: 'OM 19 Oct: the 2 Oct balancing plug stands in for no Taj bank line (all 51 August bank lines are linked elsewhere) — reverse the Taj leg on its own date',
    ops: [{
      kind: 'withPeriodUnlocked', periodKey: '2026-08', relockReason: 'August 2026 closed',
      unlockReason: 'reverse TM-KD-26-3021 (Taj leg of the PREQ-KD-26-0330 balancing plug) on 31 Aug, owner 19 Oct; relocked straight after',
      ops: [{
        kind: 'paymentRequestLegReverse', movementId: 'TM-KD-26-3021', requestId: 'PREQ-KD-26-0330', expenseId: 'EXP-KD-26-0404',
        treasuryAccountId: TAJ, amountNgn: 13804390, expectDebitCode: '6100', expectBefore: before,
        reason: 'Taj leg of the 2 Oct balancing plug reversed — no Taj bank debit; Aug–Sep Taj report P1, OM 19 Oct',
        auditNote: `Before: ${fmt(before)} (three figures disagree). After: ${fmt(after)}. Moniepoint leg TM-KD-26-3022 and Cash Office leg TM-KD-26-3023 stay (Moniepoint Aug recon / cash count).`,
      }],
    }],
    expectDeltaNgn: d(13804390),
    expectTypes: ['PAYMENT_REQUEST_REVERSAL_IN'],
  },
  {
    id: 'TA-4',
    group: 'A',
    record: 'Taj 2026-08-02 +₦451,770 "NIP FRM ABDULLAHI MOHAMMED MOB2UTOTo ZAP" vs TM-KD-26-1888 ₦451,000 (LE-KD-26-1323)',
    field: 'customer advance ₦770 (excess on the bank)',
    reason: 'OM 19 Oct: the bank credit and the receipt text say ₦451,770; the confirmed receipt stays — the ₦770 excess becomes an advance',
    ops: [{
      kind: 'withPeriodUnlocked', periodKey: '2026-08', relockReason: 'August 2026 closed',
      unlockReason: 'post the ₦770 excess of the 2 Aug Abdullahi Mohammed bank credit as an advance on 2 Aug, owner 19 Oct; relocked straight after',
      ops: [{
        kind: 'customerAdvance', customerId: p4Cust.customer_id, customerName: p4Cust.name, amountNgn: 770, date: '2026-08-02', treasuryAccountId: TAJ, branchId: BR,
        paymentMethod: TAJ_METHOD, bankReference: 'NIP FRM ABDULLAHI MOHAMMED MOB2UTOTo ZAP ₦451,770 Taj 2026-08-02 (₦770 above LE-KD-26-1323)',
        note: 'Taj 2 Aug bank ₦451,770, receipt LE-KD-26-1323 ₦451,000 — ₦770 excess raised as an advance by OM 19 Oct (Aug–Sep Taj report P4)',
        reconForMovementId: 'TM-KD-26-1888',
      }],
    }],
    expectDeltaNgn: d(770),
    expectTypes: ['ADVANCE_IN', 'RECEIPT_IN'],
  },
  {
    id: 'TA-5',
    group: 'A',
    record: 'Taj 18, 19, 26 Sep 3 × +₦49,000 "NIP FRM YUNUSA AHMED Col" (not in ERP)',
    field: 'customer advances CUS-KD-26-1165 (no open quotation) + bank-recon links',
    reason: 'OM 19 Oct: same payer as the 1 Oct / 19 Oct advances of Taj round 1 — advances on the bank dates',
    ops: [{
      kind: 'withPeriodUnlocked', periodKey: '2026-09', relockReason: 'September 2026 closed',
      unlockReason: 'post Yunusa Ahmed 3 × ₦49,000 (18, 19, 26 Sep Taj bank credits) as advances on the bank dates, owner 19 Oct; relocked straight after',
      ops: [
        ...P5.map((date) => ({
          kind: 'customerAdvance', customerId: 'CUS-KD-26-1165', customerName: yun.name, amountNgn: 49000, date, treasuryAccountId: TAJ, branchId: BR,
          paymentMethod: TAJ_METHOD, bankReference: `NIP FRM YUNUSA AHMED Col ₦49,000 Taj ${date}`,
          note: `Taj ${date} "NIP FRM YUNUSA AHMED Col" ₦49,000 — no open quotation; advance raised by OM 19 Oct (Aug–Sep Taj report P5)`,
        })),
        ...P5.flatMap((day) => {
          const rows = reviewRows(day);
          if (rows.length !== 1) {
            console.warn(`note: ${rows.length} Review bank rows for Yunusa ₦49,000 on ${day} — no recon link planned for that day`);
            return [];
          }
          return [{ kind: 'reconMatchReviewRow', rowId: rows[0].id, treasuryAccountId: TAJ, afterItem: 'TA-5', note: 'Yunusa Ahmed advance (P5)', find: { day, type: 'ADVANCE_IN', amountNgn: 49000 } }];
        }),
      ],
    }],
    expectDeltaNgn: d(147000),
    expectTypes: ['ADVANCE_IN', 'RECEIPT_IN'],
  },
];

// Expected Taj gaps after (ERP ledger − bank), from the context ledger totals.
const BANK = { '2026-08-31': 132311.01, '2026-09-30': 1680619.29, '2026-10-19': 1279577.34 };
const HOLD = ['TA-5'];
const planned = items.filter((i) => !HOLD.includes(i.id));
const net = planned.reduce((s, i) => s + i.expectDeltaNgn[TAJ], 0);
if (net !== 13805160) stop(`plan moves Taj by ₦${net}, expected ₦13,805,160 (TA-1 + TA-4)`);
const MOVE = { '2026-08-31': net, '2026-09-30': net, '2026-10-19': net };
const opening = n(ctx.taj[0]?.opening_balance_ngn);
const gaps = Object.fromEntries(
  Object.keys(BANK).map((day) => {
    const ledger = opening + n(ctx.tajLedgerAt[day]?.s);
    const now = Math.round((ledger - BANK[day]) * 100) / 100;
    return [day, { bank: BANK[day], ledgerNow: ledger, gapNow: now, ledgerAfter: ledger + MOVE[day], gapAfter: Math.round((now + MOVE[day]) * 100) / 100 }];
  })
);

fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'taj-augsep-r1-2026-10-19.plan.json');
fs.writeFileSync(out, JSON.stringify({ createdAtISO: '2026-10-19', source: 'OM 19 Oct 2026: Aug–Sep Taj report — P1 (Taj leg), P4. P5 (TA-5) on hold. --per-item.', contextReadAtISO: ctx.readAtISO, expectedGaps: gaps, hold: HOLD, items: planned }, null, 1));
console.log(`wrote ${out} — ${planned.length} items (${planned.map((i) => i.id).join(', ')}; held ${HOLD.join(', ')}); Taj net ₦${net.toLocaleString('en-NG')}`);
console.table(gaps);
