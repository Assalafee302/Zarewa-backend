#!/usr/bin/env node
/**
 * READ-ONLY: match a bank-statement CSV (bankDateISO,description,amountNgn) to one treasury account.
 * Writes a line-by-line preview JSON; posts nothing.
 *
 * Lines and movements linked to a Locked explained-items record are skipped and reported once
 * as "Explained (locked): … – see register".
 *
 * Usage:
 *   node scripts/bank-recon-match-preview.mjs --csv <file> --account <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out <json>]
 */
import fs from 'node:fs';
import path from 'node:path';

function commentedMysql(envPath) {
  const map = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const CSV = arg('csv');
const ACCT = Number(arg('account'));
const FROM = arg('from');
const TO = arg('to');
const OUT = arg('out', path.join(process.cwd(), 'exports', `bank-recon-preview-acct${ACCT}-${FROM}.json`));
if (!CSV || !ACCT || !/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
  console.error('Usage: --csv <file> --account <id> --from YYYY-MM-DD --to YYYY-MM-DD [--out <json>]');
  process.exit(2);
}

const env = commentedMysql(path.join(process.cwd(), '.env.local'));
for (const k of Object.keys(env)) process.env[k] = env[k];
process.env.ZAREWA_MYSQL_PORT ||= '3306';
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const { createMysqlDatabase, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { bankLineFingerprint, loadExplainedIndex, lockedItemFor, explainedLabel } = await import(
  '../server/finance/explainedItemsOps.js'
);
const db = createMysqlDatabase(mysqlConfigFromEnv(), { reset: false, bootstrap: false });

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const DAY = 86400000;
const dd = (a, b) => Math.abs((new Date(a.slice(0, 10)) - new Date(b.slice(0, 10))) / DAY);
const r2 = (x) => Math.round(x * 100) / 100;
/** Transfer fees banks fold into a debit (₦): Moniepoint 10/20/25/50, NIP 53.75. */
const DEBIT_FEES = [0, 10, 20, 25, 26.875, 50, 53.75];
const debitFee = (bankAbs, erpAbs) => {
  const d = Math.round((bankAbs - erpAbs) * 1000) / 1000;
  for (const f of DEBIT_FEES) if (Math.abs(d - f) < 0.6) return f;
  return null;
};
/** Card credits arrive net of a merchant fee (~0.5%, capped at ₦100). */
const cardFee = (r, erpAbs, bankAbs) => {
  const fee = erpAbs - bankAbs;
  return /PURCHASE FOR/i.test(r.desc) && fee > 0 && fee <= 100.5 && fee <= erpAbs * 0.0056 + 0.6 ? r2(fee) : null;
};
const isCharge = (r) => /^(Value Added Tax|Stamp duty|Stamp duty charge|sms charges.*)$/i.test(r.desc.trim());
const isLump = (t) => /Transfer\/POS fees|Bank charges|Stamp duty/i.test(t.note || '');

try {
  const explained = loadExplainedIndex(db);
  const reconByFp = new Map(
    db
      .prepare(
        `SELECT id, bank_date_iso, amount_ngn, description FROM bank_reconciliation_lines WHERE treasury_account_id = ? AND bank_date_iso BETWEEN ? AND ?`
      )
      .all(ACCT, FROM, TO)
      .map((l) => [bankLineFingerprint(l.bank_date_iso, l.amount_ngn, l.description), l.id])
  );

  const raw = fs
    .readFileSync(CSV, 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l, i) => {
      const p = splitCsv(l);
      const r = { n: i + 1, date: p[0], desc: p.slice(1, -1).join(','), amt: Number(p[p.length - 1]) };
      const fp = bankLineFingerprint(r.date, r.amt, r.desc);
      r.explained = lockedItemFor(explained, 'bank_recon_line', reconByFp.get(fp), fp);
      return r;
    });

  const winFrom = new Date(new Date(FROM).getTime() - 7 * DAY).toISOString().slice(0, 10);
  const winTo = new Date(new Date(TO).getTime() + 8 * DAY).toISOString().slice(0, 10);
  const tms = db
    .prepare(
      `SELECT id, posted_at_iso, type, amount_ngn, reference, counterparty_name, LEFT(note,80) note, created_by, reverses_movement_id
       FROM treasury_movements WHERE treasury_account_id = ? AND posted_at_iso >= ? AND posted_at_iso < ? ORDER BY posted_at_iso, id`
    )
    .all(ACCT, winFrom, winTo)
    .filter((t) => !lockedItemFor(explained, 'treasury_movement', t.id));

  const used = new Set();
  const live = raw.filter((r) => !r.explained && !isCharge(r));
  for (const win of [0, 1, 3, 7]) {
    for (const exactOnly of [true, false]) {
      for (const r of live) {
        if (r.match) continue;
        let best = null;
        for (const t of tms) {
          if (used.has(t.id) || isLump(t) || Number(t.amount_ngn) === 0) continue;
          if (Math.sign(Number(t.amount_ngn)) !== Math.sign(r.amt) || dd(t.posted_at_iso, r.date) > win) continue;
          const a = Math.abs(Number(t.amount_ngn));
          const b = Math.abs(r.amt);
          const f = r.amt < 0 ? debitFee(b, a) : Math.abs(a - b) < 0.6 ? 0 : cardFee(r, a, b);
          if (f == null || (exactOnly && f !== 0)) continue;
          const score = dd(t.posted_at_iso, r.date) * 10 + f;
          if (!best || score < best.score) best = { t, f, score };
        }
        if (best) {
          used.add(best.t.id);
          r.match = { ids: [best.t.id], how: best.f ? `fee ${best.f}` : 'exact', tmDate: best.t.posted_at_iso.slice(0, 10) };
        }
      }
    }
  }

  const unmatched = live.filter((r) => !r.match);
  const inPeriod = (t) => t.posted_at_iso.slice(0, 10) >= FROM && t.posted_at_iso.slice(0, 10) <= TO;
  const erpOnly = tms.filter((t) => !used.has(t.id) && !isLump(t) && inPeriod(t) && Number(t.amount_ngn) !== 0);
  const explainedOnce = new Map();
  for (const r of raw.filter((x) => x.explained)) {
    const e = explainedOnce.get(r.explained.id) || { itemId: r.explained.id, label: explainedLabel(r.explained), lines: [] };
    e.lines.push(r.n);
    explainedOnce.set(r.explained.id, e);
  }

  const out = {
    previewOnly: true,
    account: ACCT,
    period: { from: FROM, to: TO },
    lines: raw.length,
    chargeLines: raw.filter(isCharge).length,
    matched: live.filter((r) => r.match).length,
    unmatchedCount: unmatched.length,
    explained: [...explainedOnce.values()],
    unmatchedOver10k: unmatched.filter((r) => Math.abs(r.amt) > 10000).map((r) => ({ n: r.n, date: r.date, amt: r.amt, desc: r.desc })),
    erpOnly: erpOnly.map((t) => ({ id: t.id, date: t.posted_at_iso.slice(0, 10), type: t.type, amt: Number(t.amount_ngn), who: t.counterparty_name })),
    lineMatches: raw.map((r) => ({ n: r.n, date: r.date, desc: r.desc, amt: r.amt, charge: isCharge(r), explained: r.explained?.id || null, match: r.match || null })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(
    JSON.stringify({ ...out, lineMatches: undefined, erpOnly: out.erpOnly.length, unmatchedOver10k: out.unmatchedOver10k.length }, null, 1)
  );
  for (const e of out.explained) console.log(`${e.label} (lines ${e.lines.join(', ')})`);
  console.log('Wrote', OUT);
} finally {
  db.close?.();
}
