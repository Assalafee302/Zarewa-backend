#!/usr/bin/env node
/**
 * BR-KD 12 Oct 2026 — approved:
 * 1. October GRNI clearing journals (Dr 2100 / Cr 5000): PO-0078 ₦263,160, PO-0079 ₦86,000, PO-0030 ₦816,000.
 * 2. Taj (treasury 2) September statement → bank_reconciliation_lines, from
 *    exports/TAJ-Sep2026-recon-import-preview.json, with line 25 note and lines 44+46 matched to TM-KD-26-2568.
 * Usage: node scripts/kd-1012-part3-post.mjs [--dry]
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
const DATE = '2026-10-12';
const TAJ = 2;

const { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } = await import('../server/mysqlDatabase.js');
const { assertPeriodOpen, appendAuditLog } = await import('../server/controlOps.js');
const { postBalancedJournalTx } = await import('../server/glOps.js');
const { insertBankReconciliationLine } = await import('../server/writeOps.js');
const { syncFinanceBankReconExceptionWorkItem } = await import('../server/financeWorkItems.js');

const JOURNALS = [
  { poId: 'PO-KD-26-0078', amountNgn: 263160, memo: 'PO-KD-26-0078 overweight +153 kg received at no charge (invoiced on ordered kg)' },
  { poId: 'PO-KD-26-0079', amountNgn: 86000, memo: 'PO-KD-26-0079 overweight +50 kg received at no charge (invoiced 3,314 kg)' },
  { poId: 'PO-KD-26-0030', amountNgn: 816000, memo: 'PO-KD-26-0030 GRN valued 160 kg at per-metre price (JE-KD-26-1234); invoice ₦1,104,000' },
];
const LINE25_NOTE = 'Hairan Engineering paid on behalf of Engr Attah Nicholas – bank date 11 Sep';

const preview = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'exports', 'TAJ-Sep2026-recon-import-preview.json'), 'utf8')
);
const lines = preview.lines.map((l) => {
  if (l.line === 25) return { ...l, status: 'Review', systemMatch: `TM-KD-26-2565 · ${LINE25_NOTE}` };
  if (l.line === 44 || l.line === 46) return { ...l, status: 'Matched', systemMatch: 'TM-KD-26-2568 · split payment (2 bank debits)' };
  return { ...l, systemMatch: l.systemMatch ? `${l.systemMatch}${l.note ? ` · ${l.note}` : ''}` : l.note || null };
});

const cfg = mysqlConfigFromEnv();
console.log(`[part3] ${DRY ? 'DRY-RUN ' : ''}${databaseLabel(cfg)} date=${DATE}`);
const db = createMysqlDatabase(cfg, { reset: false, bootstrap: false });
const out = { date: DATE, journals: [], recon: null };

try {
  assertPeriodOpen(db, DATE, '12 Oct corrections');
  const problems = [];
  for (const j of JOURNALS) {
    const dup = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'GRNI_VARIANCE_GL' AND source_id = ?`)
      .get(`${j.poId}:weight`);
    if (dup) problems.push(`${j.poId} journal exists ${dup.id}`);
  }
  const existing = db
    .prepare(`SELECT COUNT(*) n FROM bank_reconciliation_lines WHERE branch_id = ? AND bank_date_iso BETWEEN '2026-09-01' AND '2026-09-30'`)
    .get(BRANCH).n;
  if (Number(existing) > 0) problems.push(`${existing} Sept BR-KD recon lines already exist`);
  if (lines.length !== 86) problems.push(`expected 86 lines, have ${lines.length}`);
  const counts = { Matched: 0, Review: 0 };
  for (const l of lines) counts[l.status] = (counts[l.status] || 0) + 1;
  console.log('[part3] lines', counts);
  if (problems.length) throw new Error(`Pre-check failed:\n - ${problems.join('\n - ')}`);
  console.log('[part3] pre-checks OK');
  if (DRY) process.exit(0);

  for (const j of JOURNALS) {
    const id = db.transaction(() => {
      const r = postBalancedJournalTx(db, {
        entryDateISO: DATE,
        memo: j.memo,
        sourceKind: 'GRNI_VARIANCE_GL',
        sourceId: `${j.poId}:weight`,
        branchId: BRANCH,
        createdByUserId: null,
        lines: [
          { accountCode: '2100', debitNgn: j.amountNgn, memo: j.poId },
          { accountCode: '5000', creditNgn: j.amountNgn, memo: j.poId },
        ],
      });
      if (!r.ok || r.skipped) throw new Error(r.error || 'GL skipped');
      appendAuditLog(db, {
        actor: null,
        action: 'purchase_order.grni_variance_clear',
        entityKind: 'purchase_order',
        entityId: j.poId,
        note: j.memo,
        details: { journalId: r.journalId, amountNgn: j.amountNgn, debit: '2100', credit: '5000' },
      });
      return r.journalId;
    })();
    out.journals.push({ poId: j.poId, amountNgn: j.amountNgn, journalId: id });
    console.log(`[1] ${j.poId} ₦${j.amountNgn} → ${id}`);
  }

  const created = [];
  db.transaction(() => {
    for (const l of lines) {
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
      db.prepare(`UPDATE bank_reconciliation_lines SET treasury_account_id = ? WHERE id = ?`).run(TAJ, r.id);
      created.push({ line: l.line, id: r.id, status: l.status });
    }
  })();
  try {
    syncFinanceBankReconExceptionWorkItem(db, BRANCH, null);
  } catch (e) {
    console.error('work item sync (non-fatal):', e?.message || e);
  }
  out.recon = { createdCount: created.length, first: created[0]?.id, last: created[created.length - 1]?.id, created };
  console.log(`[2] ${created.length} recon lines ${created[0]?.id} … ${created[created.length - 1]?.id}`);

  const outPath = path.join(process.cwd(), 'exports', 'KD-1012-part3-post-result.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
} catch (e) {
  console.error('[part3] FAILED', e?.message || e);
  fs.writeFileSync(path.join(process.cwd(), 'exports', 'KD-1012-part3-post-partial.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  db.close?.();
}
