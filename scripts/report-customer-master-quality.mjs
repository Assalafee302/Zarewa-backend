/**
 * Read-only customer master quality report (suspicious names + duplicate phones).
 *
 * Usage:
 *   node scripts/report-customer-master-quality.mjs
 *   node scripts/report-customer-master-quality.mjs --branch BR-KD
 */
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { createDatabase } from '../server/db.js';
import { listCustomerMasterQualityIssues } from '../server/sales/customerMasterQualityOps.js';

loadProjectEnv();

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  return String(args[i + 1] || '').trim();
}

const branch = argValue('--branch') || 'ALL';
const db = createDatabase({ seed: false });

try {
  const report = listCustomerMasterQualityIssues(db, branch);
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exitCode = 1;
} finally {
  db.close();
}
