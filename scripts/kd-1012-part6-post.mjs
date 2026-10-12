#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — approved "go":
 * 1. Moniepoint (treasury 4) September statement → bank_reconciliation_lines from
 *    exports/MONIEPOINT-Sep2026-recon-import-preview.json (904 lines, 878 Matched / 26 Review).
 * 2. Close INV-KD-26-0009 as cleared (no suspense posted on this case, so no GL).
 * Usage: node scripts/kd-1012-part6-post.mjs [--dry]
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
const env = commentedMysql(path.join(process.cwd(), '.env.local'));
process.env.ZAREWA_MYSQL_HOST = env.ZAREWA_MYSQL_HOST;
process.env.ZAREWA_MYSQL_PORT = env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = env.ZAREWA_MYSQL_USER;
process.env.ZAREWA_MYSQL_PASSWORD = env.ZAREWA_MYSQL_PASSWORD || '';
process.env.ZAREWA_MYSQL_DATABASE = env.ZAREWA_MYSQL_DATABASE;
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';

const DRY = process.argv.includes('--dry');
const BRANCH = 'BR-KD';
const MONIEPOINT = 4;
const CASE_ID = 'INV-KD-26-0009';
const CASE_NOTE =
  'Cleared – ₦6,075,400 received from Ramatu Hussaini Jallo and returned same day (lines 94/129); net cost ₦20 fee';

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { insertBankReconciliationLine } = await import('../server/writeOps.js');
const { syncFinanceBankReconExceptionWorkItem } = await import('../server/financeWorkItems.js');
const { closeInvestigationCase } = await import('../server/office/investigationOps.js');

const preview = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'exports', 'MONIEPOINT-Sep2026-recon-import-preview.json'), 'utf8')
);
const lines = preview.lines;
const invActor = { id: 'USR-ADMIN', roleKey: 'admin', permissions: ['*'], displayName: 'ops-script' };

const cfg = mysqlConfigFromEnv();
console.log(`[part6] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const out = {};

try {
  const problems = [];
  const counts = {};
  for (const l of lines) counts[l.status] = (counts[l.status] || 0) + 1;
  if (lines.length !== 904 || counts.Matched !== 878 || counts.Review !== 26) problems.push(`preview counts ${JSON.stringify(counts)}`);
  // Resumable: lines already imported (same date, whole-naira amount, description) are skipped.
  const already = db
    .prepare(
      `SELECT bank_date_iso, amount_ngn, description FROM bank_reconciliation_lines WHERE treasury_account_id = ? AND bank_date_iso BETWEEN '2026-09-01' AND '2026-09-30'`
    )
    .all(MONIEPOINT);
  const doneCount = new Map();
  for (const r of already) {
    const k = `${r.bank_date_iso}|${Math.round(Number(r.amount_ngn))}|${r.description}`;
    doneCount.set(k, (doneCount.get(k) || 0) + 1);
  }
  for (const l of lines) {
    const k = `${l.bankDateISO}|${Math.round(Number(l.amountStatement))}|${l.description}`;
    const left = doneCount.get(k) || 0;
    if (left > 0) {
      l.skip = true;
      doneCount.set(k, left - 1);
    }
  }
  out.resumeSkipped = lines.filter((l) => l.skip).length;
  const c = db.prepare(`SELECT status, suspended_ngn, amount_recovered_ngn FROM investigation_cases WHERE id = ?`).get(CASE_ID);
  if (c?.status !== 'open' && c?.status !== 'cleared') problems.push(`${CASE_ID} ${JSON.stringify(c)}`);
  if (Number(c?.suspended_ngn) !== 0) problems.push(`${CASE_ID} has suspense`);
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part6] pre-checks OK', counts, `already imported: ${out.resumeSkipped}`);
  if (DRY) process.exit(0);

  const created = [];
  const todo = lines.filter((l) => !l.skip);
  const BATCH = 50;
  for (let i = 0; i < todo.length; i += BATCH) {
    db.transaction(() => {
    for (const l of todo.slice(i, i + BATCH)) {
      const r = insertBankReconciliationLine(
        db,
        {
          bankDateISO: l.bankDateISO,
          description: l.description,
          amountNgn: l.amountStatement,
          status: l.status,
          systemMatch: l.systemMatch ? String(l.systemMatch).slice(0, 250) : '',
          actor: null,
        },
        BRANCH
      );
      if (!r.ok) throw new Error(`line ${l.line}: ${r.error}`);
      db.prepare(`UPDATE bank_reconciliation_lines SET treasury_account_id = ? WHERE id = ?`).run(MONIEPOINT, r.id);
      created.push({ line: l.line, id: r.id, status: l.status });
    }
    })();
    console.log(`[1] batch ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)} committed (${created.length}/${todo.length})`);
  }
  try {
    syncFinanceBankReconExceptionWorkItem(db, BRANCH, null);
  } catch (e) {
    console.error('work item sync (non-fatal):', e?.message || e);
  }
  out.recon = { createdCount: created.length, first: created[0]?.id, last: created[created.length - 1]?.id };
  console.log(`[1] ${created.length} lines ${out.recon.first} … ${out.recon.last}`);

  const total = db
    .prepare(`SELECT COUNT(*) n FROM bank_reconciliation_lines WHERE treasury_account_id = ? AND bank_date_iso BETWEEN '2026-09-01' AND '2026-09-30'`)
    .get(MONIEPOINT).n;
  if (Number(total) !== 904) throw new Error(`Expected 904 Moniepoint lines, found ${total} — re-run to resume.`);
  const caseNow = db.prepare(`SELECT status FROM investigation_cases WHERE id = ?`).get(CASE_ID);
  const closed = caseNow?.status === 'cleared' ? { ok: true } : closeInvestigationCase(db, CASE_ID, { status: 'cleared', decisionNote: CASE_NOTE, treasuryAccountId: MONIEPOINT }, invActor);
  if (closed?.ok === false) throw new Error(`close: ${closed.error}`);
  out.case = db.prepare(`SELECT id, status, decision_note, closed_at_iso FROM investigation_cases WHERE id = ?`).get(CASE_ID);
  console.log(`[2] ${CASE_ID} → ${out.case.status}`);

  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part6-post-result.json'), JSON.stringify({ ...out, created }, null, 2));
} catch (e) {
  console.error('[part6] FAILED', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close?.();
}
