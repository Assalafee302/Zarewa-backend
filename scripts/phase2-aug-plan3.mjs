#!/usr/bin/env node
/**
 * Phase 2 round 3 — August 2026 Kaduna: bank links, phantom credit inflows, dates / labels. NO database access.
 *   node scripts/phase2-aug-plan3.mjs --links <links.json> --read <phase2-aug-read3.json> --erp <phase2-aug-read.json> --out <plan.json>
 * links.json = the owner's "Aug2026_bank_to_ERP_links.xlsx" (every Moniepoint / Taj / ERP line, parsed as data).
 * read = scripts/phase2-aug-read3.mjs (SELECT only); erp = scripts/phase2-aug-read.mjs (for the 31 Aug simulation).
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
const L = JSON.parse(fs.readFileSync(opt('links'), 'utf8'));
const R = JSON.parse(fs.readFileSync(opt('read'), 'utf8'));
const E = JSON.parse(fs.readFileSync(opt('erp'), 'utf8'));
const TAJ = 2, CASH = 3, MP = 4, BR = 'BR-KD';
const ACC = { [TAJ]: 'Taj', [MP]: 'Moniepoint', [CASH]: 'Cash Office' };
const BANK_31_AUG = { [TAJ]: 132311.01, [MP]: 8297144.24, [CASH]: 992370 };
const ngn = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const items = [];
const held = [];

// ---- A. Bank links ---------------------------------------------------------------------------------------------
/** ERP lines a Sept/Oct bank-recon row already links: linking them to an August bank line too would count them twice. */
const conflictIds = new Set();
for (const r of R.linkedElsewhere) for (const m of String(r.system_match).matchAll(/TM-KD-26-\d+/g)) conflictIds.add(m[0]);
const chargeTm = Object.fromEntries(R.chargeTm.map((t) => [t.source_id, t.id]));
const bankLines = [...L.taj.map((b) => ({ ...b, acct: TAJ })), ...L.mp.map((b) => ({ ...b, acct: MP }))];
const linked = bankLines.filter((b) => b.status === 'Linked');
let fullyConflicted = 0;
for (const b of linked) {
  const ids = String(b.erp_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const keep = ids.filter((i) => !conflictIds.has(i));
  const dropped = ids.filter((i) => conflictIds.has(i));
  if (dropped.length) {
    const other = R.linkedElsewhere.filter((r) => dropped.some((d) => String(r.system_match).includes(d))).map((r) => `${r.id} (${r.bank_date_iso})`);
    held.push({ id: `L-${b.bank_id}`, record: `${b.bank_id} ${b.date} ${ngn(b['amount (ex fee)'])} → ${dropped.join(', ')}`, why: `already linked to a later bank line on ${other.join(', ')}; not linked twice` });
  }
  if (!keep.length) { fullyConflicted++; continue; }
  const amt = Number(b['amount (ex fee)']);
  const fee = Number(b.fee) || 0;
  const feeTo = !fee ? '' : b.acct === TAJ ? ' → EXP-KD-26-0459' : amt < 0 ? ' → EXP-KD-26-0461' : ' → POS/card charges expense (31 Aug)';
  const erpSum = keep.reduce((s, id) => s + Number((E.movements.find((m) => m.id === id) || R.movements.find((m) => m.id === id) || {}).amount_ngn || 0), 0);
  const gross = amt < 0 ? amt : amt + fee; // ERP books transfers ex fee and POS credits gross
  const diff = Math.round((gross - erpSum) * 100) / 100;
  items.push({
    id: `L-${b.bank_id}`, group: 'A', record: `${b.bank_id} ${ACC[b.acct]} ${b.date} ${ngn(amt)}`, field: 'bank reconciliation link',
    reason: `${b.how || '1:1'} bank → ERP (owner links file)`,
    ops: [{
      kind: 'reconLinkUpsert', bankId: b.bank_id, treasuryAccountId: b.acct, bankDateISO: b.date, amountNgn: Math.round(amt),
      settledAmountNgn: Math.round(amt), varianceNgn: Math.round(fee), movementIds: keep, branchId: BR,
      description: [b.party, b.text].filter((s) => s && s !== b.text ? true : s).filter((v, i, a) => a.indexOf(v) === i).join(' | ').slice(0, 900),
      systemMatch: [keep.join(' + '), b.bank_id, b.how || '1:1', fee ? `fee ${ngn(fee)}${feeTo}` : '', diff && Math.abs(diff) >= 0.01 ? `bank − ERP ${ngn(diff)}` : '', Math.round(amt) !== amt ? `bank ${ngn(amt)}` : '']
        .filter(Boolean).join(' · '),
    }],
  });
}
// Charge rows as three groups (one row each): the ERP has one bank-charges expense per account for August.
const chargeRows = bankLines.filter((b) => /Bank charge/i.test(b.status));
const tajCharges = chargeRows.filter((b) => b.acct === TAJ);
const mpCharges = chargeRows.filter((b) => b.acct === MP);
const tajFees = L.taj.reduce((s, b) => s + (Number(b.fee) || 0), 0);
const mpTransferFees = L.mp.filter((b) => b['amount (ex fee)'] < 0).reduce((s, b) => s + (Number(b.fee) || 0), 0);
const sum = (rows) => Math.round(rows.reduce((s, b) => s + Number(b['amount (ex fee)']), 0) * 100) / 100;
const group = (id, acct, tm, rows, amount, text) => items.push({
  id, group: 'A', record: `${ACC[acct]} Aug charges (${rows} lines)`, field: 'bank reconciliation link (group)', reason: text,
  ops: [{ kind: 'reconLinkUpsert', bankId: id, treasuryAccountId: acct, bankDateISO: '2026-08-31', amountNgn: Math.round(amount), settledAmountNgn: Math.round(amount),
    varianceNgn: 0, movementIds: [tm], branchId: BR, description: text, systemMatch: `${tm} · ${id} · group: ${text}` }],
});
group('CHG-TAJ-AUG', TAJ, chargeTm['EXP-KD-26-0459'], tajCharges.length,
  sum(tajCharges) - tajFees, `Taj Aug 2026 charges ${ngn(-(sum(tajCharges) - tajFees))}: ${tajCharges.length} charge rows (${tajCharges.map((b) => b.bank_id).join(',')}) ${ngn(-sum(tajCharges))} + transfer fees in ${L.taj.filter((b) => b.fee).length} transfer lines ${ngn(tajFees)} = EXP-KD-26-0459`);
group('CHG-MP-AUG', MP, chargeTm['EXP-KD-26-0460'], mpCharges.length,
  sum(mpCharges), `Moniepoint Aug 2026 stamp duty + VAT ${ngn(-sum(mpCharges))}: ${mpCharges.length} rows (${mpCharges[0]?.bank_id}…${mpCharges.at(-1)?.bank_id}) = EXP-KD-26-0460`);
group('FEE-MP-AUG', MP, chargeTm['EXP-KD-26-0461'], L.mp.filter((b) => b['amount (ex fee)'] < 0 && b.fee).length,
  -mpTransferFees, `Moniepoint Aug 2026 transfer fees ${ngn(mpTransferFees)}: ₦20 on ${L.mp.filter((b) => b['amount (ex fee)'] < 0 && b.fee).length} transfer lines (variance on each link) = EXP-KD-26-0461`);

// POS / card merchant charges netted off card receipts: one Bank charges expense (owner, 15 Oct) + its group link.
const posLines = L.mp.filter((b) => b['amount (ex fee)'] > 0 && Number(b.fee) > 0);
const posFees = Math.round(posLines.reduce((s, b) => s + Number(b.fee), 0));
const POS_TEXT = `Moniepoint Aug 2026 POS/card merchant charges netted off ${posLines.length} card receipts (${posFees.toLocaleString('en-NG')})`;
const posExpense = { date: '2026-08-31', amountNgn: posFees, category: 'Bank charges', expenseType: POS_TEXT };
items.push({
  id: 'A-POS', group: 'A', record: `Moniepoint Aug POS/card charges ${ngn(posFees)} (${posLines.length} card credits)`, field: 'new expense (Bank charges)', reason: POS_TEXT,
  ops: [{ kind: 'postExpense', ...posExpense, paymentMethod: 'Bank', reference: 'BANK-MONIEPOINT-2026-08-31', treasuryAccountId: MP, branchId: BR }],
});
items.push({
  id: 'POS-MP-AUG', group: 'A', record: `Moniepoint Aug POS/card charges (${posLines.length} lines)`, field: 'bank reconciliation link (group)', reason: POS_TEXT,
  ops: [{ kind: 'reconLinkUpsert', bankId: 'POS-MP-AUG', treasuryAccountId: MP, bankDateISO: '2026-08-31', amountNgn: -posFees, settledAmountNgn: -posFees, varianceNgn: 0,
    movementIds: [], expenseRef: posExpense, branchId: BR, description: POS_TEXT,
    systemMatch: `POS-MP-AUG · group: card charges on ${posLines.map((b) => b.bank_id).join(',')}` }],
});

// ---- B. Phantom credit inflows ---------------------------------------------------------------------------------
const NOTE_B = 'Phase 2 round 3: credit application posted as bank inflow (bug b50d502) — reversed';
const bankCredit = (p) => L.mp.find((b) => b.date === String(p.posted_at_iso).slice(0, 10) && Math.round(b['amount (ex fee)']) === p.amount_ngn && b.status !== 'Linked');
for (const p of R.phantom) {
  const settle = R.phantomSettle.filter((a) => a.entity_id === p.source_id).map((a) => { try { return Number(JSON.parse(a.details_json).refundCreditAppliedNgn) || 0; } catch { return 0; } });
  const credit = Math.max(0, ...settle);
  const hit = p.treasury_account_id === MP ? bankCredit(p) : null;
  const rec = `${p.id} ${ACC[p.treasury_account_id]} ${String(p.posted_at_iso).slice(0, 10)} ${ngn(p.amount_ngn)} ${p.source_id} ${p.counterparty_name} (credit ${ngn(credit)})`;
  if (hit) { held.push({ id: `B-${p.id}`, record: rec, why: `a bank credit of the same amount the same day exists (${hit.bank_id} "${hit.text}") — may be real money; not reversed` }); continue; }
  if (!(credit > 0)) { held.push({ id: `B-${p.id}`, record: rec, why: 'no refund-credit confirmation; not reversed' }); continue; }
  items.push({
    id: `B-${p.id}`, group: 'B', record: rec, field: 'treasury reversal (same day)',
    reason: credit !== p.amount_ngn ? `${NOTE_B}. Inflow ${ngn(p.amount_ngn)} vs credit ${ngn(credit)}: ${ngn(p.amount_ngn - credit)} has no bank credit either` : NOTE_B,
    ops: [{ kind: 'reversePhantomInflow', movementId: p.id, sourceId: p.source_id, accountId: p.treasury_account_id, date: String(p.posted_at_iso).slice(0, 10), amountNgn: p.amount_ngn, note: NOTE_B, relabelMethod: 'Refund fund' }],
  });
}

// ---- C. Dates / labels ----------------------------------------------------------------------------------------
items.push({
  id: 'C1', group: 'C', record: 'TM-KD-26-2113 Eastchese Coating Abuja ₦26,221,440 (AP-PO-PO-KD-26-0062), Taj', field: 'treasury_movements.posted_at_iso',
  reason: 'Bank: Taj 7 Aug ₦26,221,493.75 (= ₦26,221,440 + ₦53.75 fee)',
  ops: [{ kind: 'redateTreasury', movementId: 'TM-KD-26-2113', before: '2026-08-15', after: '2026-08-07', note: 'Phase 2 round 3: bank date 7 Aug (Taj statement)' }],
});
const acct = Object.fromEntries(R.accounts.map((a) => [a.id, a]));
const label = (a) => `${a.type} — ${a.name}`;
const token = (a) => `${a.type}:${a.name}`;
for (const x of R.labels.filter((l) => l.method !== `${l.acct_type} — ${l.acct_name}`)) {
  const from = R.accounts.find((a) => label(a) === x.method);
  const to = acct[x.treasury_account_id];
  items.push({
    id: `C-${x.id}`, group: 'C', record: `${x.id} (${x.tm})`, field: 'payment method / reference text',
    reason: `Method "${x.method}" but the treasury line is on ${label(to)}; text only, no money moves`,
    ops: [{ kind: 'relabelReceiptMethod', receiptId: x.id, movementId: x.tm, accountId: to.id, beforeMethod: x.method, afterMethod: label(to), beforeRefToken: from ? token(from) : x.method, afterRefToken: token(to) }],
  });
}

// ---- D. Simulation: 31 Aug balances, matched counts -----------------------------------------------------------------
const opening = Object.fromEntries(E.accounts.map((a) => [a.id, a.opening_balance_ngn]));
let sim = E.movements.map((m) => ({ ...m }));
for (const it of items) for (const op of it.ops) {
  if (op.kind === 'reversePhantomInflow') sim.push({ id: `REV-${op.movementId}`, posted_at_iso: `${op.date}T12:00:00.000Z`, treasury_account_id: op.accountId, amount_ngn: -op.amountNgn });
  if (op.kind === 'postExpense') sim.push({ id: `NEW-${it.id}`, posted_at_iso: `${op.date}T12:00:00.000Z`, treasury_account_id: op.treasuryAccountId, amount_ngn: -op.amountNgn });
  if (op.kind === 'redateTreasury') sim = sim.map((m) => (m.id === op.movementId ? { ...m, posted_at_iso: `${op.after}${m.posted_at_iso.slice(10)}` } : m));
}
const bal = (movs, id, d) => opening[id] + movs.filter((m) => m.treasury_account_id === id && String(m.posted_at_iso).slice(0, 10) <= d).reduce((s, m) => s + m.amount_ngn, 0);
const balances = [TAJ, MP, CASH].map((id) => {
  const before = bal(E.movements, id, '2026-08-31');
  const after = bal(sim, id, '2026-08-31');
  const plug = E.movements.find((m) => m.source_id === 'PREQ-KD-26-0330' && m.treasury_account_id === id);
  const gap = Math.round((after - BANK_31_AUG[id]) * 100) / 100;
  return { account: ACC[id], erpBefore: before, erpAfter: after, bank: BANK_31_AUG[id], gapAfter: gap, plugLine: plug?.amount_ngn, plugIfBalanced: plug ? Math.round(plug.amount_ngn - gap) : null };
});
const linkedLines = (acctId) => items.filter((i) => i.id.startsWith('L-') && i.ops[0].treasuryAccountId === acctId).length;
const matched = {
  Taj: { lines: L.taj.length, matched: linkedLines(TAJ) + tajCharges.length },
  Moniepoint: { lines: L.mp.length, matched: linkedLines(MP) + mpCharges.length },
};
const plan = { createdAtISO: '2026-10-15', source: 'Owner instruction 15 Oct 2026: Phase 2 round 3 (dry run) from Aug2026_bank_to_ERP_links.xlsx — A bank links, B phantom credit inflows, C dates / labels.', items };
fs.writeFileSync(opt('out'), JSON.stringify(plan, null, 1));
const lineLinks = items.filter((i) => i.id.startsWith('L-'));
const half = Math.ceil(lineLinks.length / 2);
const parts = [lineLinks.slice(0, half), [...lineLinks.slice(half), ...items.filter((i) => i.group === 'A' && !i.id.startsWith('L-'))], items.filter((i) => i.group !== 'A')];
parts.forEach((p, k) => fs.writeFileSync(opt('out').replace(/.plan.json$/, `.part${k + 1}.plan.json`), JSON.stringify({ ...plan, part: k + 1, items: p }, null, 1)));
console.log('parts', parts.map((p) => p.length));
fs.writeFileSync(opt('out').replace(/\.plan\.json$/, '.dryrun.json'), JSON.stringify({ held, balances, matched, fullyConflicted }, null, 1));
const byGroup = items.reduce((m, i) => ((m[i.group] = (m[i.group] || 0) + 1), m), {});
console.log(opt('out'), byGroup, 'held', held.length, 'bank lines with every link conflicted', fullyConflicted);
console.log('B total', items.filter((i) => i.group === 'B').reduce((s, i) => s + i.ops[0].amountNgn, 0));
console.table(balances);
console.log(matched);
held.forEach((h) => console.log('HELD', h.id, '|', h.record, '|', h.why));
