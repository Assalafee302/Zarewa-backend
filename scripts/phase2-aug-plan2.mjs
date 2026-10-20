#!/usr/bin/env node
/**
 * Phase 2 round 2b — owner decisions of 14 Oct on the August dry run. NO database access, no writes.
 *   node scripts/phase2-aug-plan2.mjs --payers <payers_differ.json> --out <dir>
 * A8c Moniepoint ₦20 transfer fees; B12d payee note on TM-KD-26-2162; B13d Chancellors Farms ₦15,000 excess as a
 * customer advance; P* "Paid by" bank-recon links for August receipts whose bank payer differs from the ERP customer.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
const payers = JSON.parse(fs.readFileSync(opt('payers'), 'utf8'));
const outDir = opt('out') || '.';
const today = new Date().toISOString().slice(0, 10);
/** Same person, different spelling (checked by eye): not a different payer. */
const SAME_PERSON = new Set(['TM-KD-26-1946', 'TM-KD-26-1918', 'TM-KD-26-2335', 'TM-KD-26-1900']);
const clean = (p) => p.replace(/^Fairmoney - FROM /i, '').replace(/ TO ZAREWA.*$/i, '').replace(/\s+FI$/, '').trim();

const items = [
  {
    id: 'A8c', group: 'A', record: 'Moniepoint Aug ₦20 transfer fees (137 × ₦20)', field: 'new expense (Bank charges)',
    reason: 'Moniepoint Aug 2026 transfer fees 137 x 20 (with EXP for stamp duty + VAT: 9,196)',
    ops: [{ kind: 'postExpense', date: '2026-08-31', amountNgn: 2740, category: 'Bank charges', expenseType: 'Moniepoint Aug 2026 transfer fees 137 x 20 (with EXP for stamp duty + VAT: 9,196)', paymentMethod: 'Bank', reference: 'BANK-MONIEPOINT-2026-08-31', treasuryAccountId: 4, branchId: 'BR-KD' }],
  },
  {
    id: 'B12d', group: 'B', record: 'TM-KD-26-2162 (RF-KD-26-9500, ₦15,350, Moniepoint 19 Aug)', field: 'treasury_movements.note',
    reason: 'Bank paid Abdulrahman Uthman Sali, not Tahir',
    ops: [{ kind: 'setNote', movementId: 'TM-KD-26-2162', before: '', after: 'Paid to Abdulrahman Uthman Sali on behalf of Tahir Isiya' }],
  },
  {
    id: 'B13d', group: 'B', record: 'Taj 4 Aug Chancellors Farms ₦1,062,080 − Oga Ali receipts ₦1,047,080', field: 'customer advance (unapplied credit)',
    reason: 'excess received 4 Aug — confirm with customer',
    ops: [{ kind: 'customerAdvance', customerName: 'Chancellors Farms Ltd', amountNgn: 15000, date: '2026-08-04', treasuryAccountId: 2, paymentMethod: 'Bank — Zaps Aluminum Enterprises', bankReference: 'NIP FRM CHANCELLORS FARMS LTD 4 Aug', note: 'excess received 4 Aug — confirm with customer', reconForMovementId: 'TM-KD-26-1904', branchId: 'BR-KD' }],
  },
];
const kept = payers.filter((p) => !SAME_PERSON.has(p.tm) && clean(p.payer) && !/^fairmoney$/i.test(clean(p.payer)));
kept.forEach((p, i) => items.push({
  id: `P${String(i + 1).padStart(2, '0')}`, group: 'B',
  record: `${p.acct === 'TAJ' ? 'Taj' : 'Moniepoint'} ${p.date} ₦${p.amount.toLocaleString('en-NG')} ${p.source} (${p.customer})`,
  field: 'bank reconciliation link + paid by', reason: `Bank payer ${clean(p.payer)} ≠ ERP customer ${p.customer}`,
  ops: [{ kind: 'reconLink', treasuryAccountId: p.acct === 'TAJ' ? 2 : 4, bankDateISO: p.date, amountNgn: Math.round(p.amount), description: `${p.narration} — Paid by: ${clean(p.payer)}`, movementIds: [p.tm], branchId: 'BR-KD' }],
}));
fs.mkdirSync(outDir, { recursive: true });
const planPath = path.join(outDir, `phase2-aug2b-${today}.plan.json`);
fs.writeFileSync(planPath, JSON.stringify({ createdAtISO: today, source: 'Owner decisions 14 Oct 2026 on the August dry run (round 2b).', items }, null, 1));
console.log(planPath, items.length, 'items,', kept.length, 'paid-by links');
