#!/usr/bin/env node
/**
 * Phase 2 round 2 — D. Verification: August line match of both bank statements against ERP treasury, and the
 * 31 Aug balances vs bank. NO database access: reads a fresh live read (scripts/phase2-aug-read.mjs).
 *   node scripts/phase2-aug-verify.mjs --erp <phase2-aug-read.json> --bank <bank_aug.json> --out <file.json>
 * Match rule: same account and amount (Taj debits may carry the ₦53.75 fee, Moniepoint POS credits the card
 * charge), within ±3 days, nearest first; bank-recon rows link a bank line to the ERP lines they name; two bank
 * lines may make one ERP line. Charge lines count as matched once that account has an August bank-charges expense.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
const erp = JSON.parse(fs.readFileSync(opt('erp'), 'utf8'));
const bank = JSON.parse(fs.readFileSync(opt('bank'), 'utf8'));
const TAJ = 2, CASH = 3, MP = 4;
const ACC = { [TAJ]: 'Taj', [MP]: 'Moniepoint', [CASH]: 'Cash Office' };
const acctOf = { TAJ, MP };
const BANK_31_AUG = { [TAJ]: 132311.01, [MP]: 8297144.24, [CASH]: 992370 };
const day = (iso) => String(iso || '').slice(0, 10);
const dd = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
const isCharge = (l) => (l.acct === 'MP' && /^(Stamp duty|Value Added Tax)$/i.test(String(l.narration).trim())) || (l.acct === 'TAJ' && /stamp duty|sms charges/i.test(l.narration));

const erpAug = erp.movements.filter((m) => [TAJ, MP].includes(m.treasury_account_id) && day(m.posted_at_iso).startsWith('2026-08'));
const reversed = new Set(erpAug.filter((m) => m.reverses_movement_id).flatMap((m) => [m.id, m.reverses_movement_id]));
const pool = erpAug.filter((m) => !reversed.has(m.id));
const used = new Set();
const lines = [...bank.taj, ...bank.mp].filter((l) => !isCharge(l)).map((l) => ({ ...l, match: null }));
for (const r of erp.reconAug || []) {
  const ids = [...String(r.system_match || '').matchAll(/TM-[A-Z]{2}-\d{2}-\d+/g)].map((x) => x[0]).filter((id) => pool.some((m) => m.id === id));
  if (!ids.length) continue;
  const l = lines.find((x) => !x.match && acctOf[x.acct] === Number(r.treasury_account_id) && x.date === day(r.bank_date_iso) && Math.round(x.amount) === Number(r.amount_ngn));
  if (!l) continue;
  l.match = `${ids.join(' + ')} (${r.id})`;
  ids.forEach((id) => used.add(id));
}
const wants = (l) => {
  const w = new Set([Math.round(l.amount)]);
  if (l.acct === 'TAJ' && l.amount < 0) w.add(Math.round(l.amount + 53.75));
  if (l.acct === 'MP' && l.amount > 0 && l.fee) w.add(Math.round(l.amount + l.fee));
  return w;
};
for (const pass of [0, 1, 2, 3])
  for (const l of lines) {
    if (l.match) continue;
    const w = wants(l);
    const c = pool.find((m) => !used.has(m.id) && m.treasury_account_id === acctOf[l.acct] && w.has(m.amount_ngn) && dd(day(m.posted_at_iso), l.date) <= pass);
    if (c) { used.add(c.id); l.match = c.id; }
  }
for (const m of pool.filter((x) => !used.has(x.id))) {
  const cand = lines.filter((l) => !l.match && acctOf[l.acct] === m.treasury_account_id && dd(l.date, day(m.posted_at_iso)) <= 1 && Math.sign(l.amount) === Math.sign(m.amount_ngn));
  outer: for (let i = 0; i < cand.length; i++)
    for (let j = i + 1; j < cand.length; j++)
      if (Math.round(cand[i].amount + cand[j].amount) === m.amount_ngn) {
        cand[i].match = cand[j].match = `${m.id} (pair)`;
        used.add(m.id);
        break outer;
      }
}
const charges = [...bank.taj, ...bank.mp].filter(isCharge);
const per = (acct) => {
  const x = lines.filter((l) => l.acct === acct);
  const ch = charges.filter((c) => c.acct === acct);
  const booked = pool.some((m) => m.treasury_account_id === acctOf[acct] && m.counterparty_name === 'Bank charges');
  return { lines: x.length + ch.length, matched: x.filter((l) => l.match).length + (booked ? ch.length : 0), chargeLines: ch.length, chargesBooked: booked };
};
const opening = Object.fromEntries(erp.accounts.map((a) => [a.id, a.opening_balance_ngn]));
const bal = (id, d) => opening[id] + erp.movements.filter((m) => m.treasury_account_id === id && day(m.posted_at_iso) <= d).reduce((s, m) => s + m.amount_ngn, 0);
const balances = [TAJ, MP, CASH].map((id) => {
  const a = bal(id, '2026-08-31');
  const gap = Math.round((a - BANK_31_AUG[id]) * 100) / 100;
  const plug = erp.movements.find((m) => m.source_id === 'PREQ-KD-26-0330' && m.treasury_account_id === id);
  return { account: ACC[id], erp31Jul: bal(id, '2026-07-31'), erp31Aug: a, bank31Aug: BANK_31_AUG[id], gap, plugLineNgn: plug?.amount_ngn ?? 0, plugLineIfBalanced: plug ? Math.round(plug.amount_ngn - gap) : null };
});
const out = {
  TAJ: per('TAJ'),
  MP: per('MP'),
  balances,
  unmatchedBank: lines.filter((l) => !l.match).map((l) => ({ account: l.acct === 'TAJ' ? 'Taj' : 'Moniepoint', date: l.date, amount: l.amount, narration: `${l.beneficiary ? `${l.beneficiary} | ` : ''}${l.narration}`.slice(0, 90) })),
  unmatchedErp: pool.filter((m) => !used.has(m.id)).map((m) => ({ account: ACC[m.treasury_account_id], id: m.id, date: day(m.posted_at_iso), amount: m.amount_ngn, type: m.type, name: m.counterparty_name, source: m.source_id })),
};
fs.writeFileSync(opt('out'), JSON.stringify(out, null, 1));
console.log({ TAJ: out.TAJ, MP: out.MP, unmatchedBank: out.unmatchedBank.length, unmatchedErp: out.unmatchedErp.length });
console.table(balances);
