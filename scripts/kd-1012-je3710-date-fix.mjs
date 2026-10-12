#!/usr/bin/env node
/** JE-KD-26-3710 (CL-26-2205 GRN): entry date 2099-09-15 → 2026-09-15 only. OM-approved exception 12 Oct 2026. */
import fs from 'node:fs';
import path from 'node:path';
const map = {};
for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  map[m[1]] = v;
}
for (const k of Object.keys(map)) process.env[k] = map[k];
process.env.ZAREWA_MYSQL_PORT ||= '3306';
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';
const { createMysqlDatabase, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { appendAuditLog } = await import('../server/controlOps.js');
const db = createMysqlDatabase(mysqlConfigFromEnv(), { reset: false, bootstrap: false });
const ID = 'JE-KD-26-3710';
try {
  const before = db.prepare(`SELECT * FROM gl_journal_entries WHERE id = ?`).get(ID);
  if (!before || before.entry_date_iso !== '2099-09-15' || before.source_id !== 'CL-26-2205') throw new Error(`Unexpected state: ${JSON.stringify(before)}`);
  const lines = db.prepare(`SELECT account_id, debit_ngn, credit_ngn FROM gl_journal_lines WHERE journal_id = ?`).all(ID);
  db.transaction(() => {
    const r = db.prepare(`UPDATE gl_journal_entries SET entry_date_iso = '2026-09-15', period_key = '2026-09' WHERE id = ? AND entry_date_iso = '2099-09-15'`).run(ID);
    if (Number(r?.changes ?? 1) !== 1) throw new Error('update did not touch exactly one row');
    appendAuditLog(db, {
      actor: null,
      action: 'gl_journal.date_correction',
      entityKind: 'gl_journal_entry',
      entityId: ID,
      note: 'Year keying error; OM approved 12 Oct 2026',
      details: { previous: { entryDateISO: '2099-09-15', periodKey: '2099-09' }, next: { entryDateISO: '2026-09-15', periodKey: '2026-09' }, sourceId: 'CL-26-2205', linesUnchanged: lines },
    });
  })();
  const after = db.prepare(`SELECT id, entry_date_iso, period_key, source_kind, source_id FROM gl_journal_entries WHERE id = ?`).get(ID);
  const linesAfter = db.prepare(`SELECT account_id, debit_ngn, credit_ngn FROM gl_journal_lines WHERE journal_id = ?`).all(ID);
  const stray = db.prepare(`SELECT COUNT(*) n FROM gl_journal_entries WHERE entry_date_iso > '2027-01-01'`).get();
  const strayMv = db.prepare(`SELECT COUNT(*) n FROM stock_movements WHERE date_iso > '2027-01-01'`).get();
  const lock = db.prepare(`SELECT period_key, locked_at_iso FROM accounting_period_locks WHERE period_key = '2026-09'`).get();
  console.log(JSON.stringify({ before: { entry_date_iso: before.entry_date_iso, period_key: before.period_key }, after, linesBefore: lines, linesAfter, futureDatedJournals: stray.n, futureDatedMovements: strayMv.n, septLock: lock }, null, 1));
} catch (e) {
  console.error('FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
