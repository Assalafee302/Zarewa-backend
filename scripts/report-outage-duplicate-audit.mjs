/**
 * Read-only outage duplicate audit (receipt twins / multi CL / multi production).
 *
 * Usage:
 *   node scripts/report-outage-duplicate-audit.mjs
 *   node scripts/report-outage-duplicate-audit.mjs --from 2026-09-08 --to 2026-09-15
 *   node scripts/report-outage-duplicate-audit.mjs --days 14 --branch BR-KD
 *   node scripts/report-outage-duplicate-audit.mjs --summary
 */
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import { buildOutageDuplicateAuditReport } from '../server/sales/outageDuplicateAuditOps.js';

loadProjectEnv();

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  return String(args[i + 1] || '').trim();
}

const branch = argValue('--branch') || 'ALL';
const fromDate = argValue('--from') || undefined;
const toDate = argValue('--to') || undefined;
const days = Number(argValue('--days')) || undefined;
const limit = Number(argValue('--limit')) || undefined;
const summaryOnly = args.includes('--summary');

const db = createDatabase({ seed: false });

try {
  const report = buildOutageDuplicateAuditReport(db, {
    branchScope: branch,
    fromDate,
    toDate,
    days,
    limit,
  });
  if (summaryOnly) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          fromDate: report.fromDate,
          toDate: report.toDate,
          branchScope: report.branchScope,
          summary: report.summary,
          topQuotations: (report.quotations || []).slice(0, 25).map((q) => ({
            quotationRef: q.quotationRef,
            customerName: q.customerName,
            severity: q.severity,
            flags: q.flags,
            guidance: q.guidance,
          })),
        },
        null,
        2
      )
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exitCode = 1;
} finally {
  db.close();
}
