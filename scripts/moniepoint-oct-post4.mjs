#!/usr/bin/env node
/**
 * Phase 2 round 4 — post the Moniepoint plan with September 2026 unlocked for the run only (owner, 16 Oct 2026).
 *
 *   ZAREWA_PHASE2_LIVE_CONFIRM=<schema> node scripts/moniepoint-oct-post4.mjs --database <schema> --approver "Name"
 *
 * 1. Unlock 2026-09 with the ERP's audited unlockAccountingPeriod (reason REC-MP-2026-09).
 * 2. Run scripts/phase2-apply.mjs --apply --live on the round-4 plan (all items in group A → one transaction).
 * 3. Always relock 2026-09 with lockAccountingPeriod and the original reason — also when step 2 fails.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : '';
};
const database = opt('database');
const approver = opt('approver');
if (!database || !approver) {
  console.error('Usage: node scripts/moniepoint-oct-post4.mjs --database <schema> --approver "Name"');
  process.exit(2);
}
const PERIOD = '2026-09';
const UNLOCK_REASON = 'Moniepoint alignment REC-MP-2026-09';
const LOCK_REASON = 'Sales phase 1 September 2026. Later changes post as October adjustments.';
// --plan <file> (default round 4); --progress <jsonl> passes --per-item to the apply.
const PLAN = opt('plan') || 'exports/phase2-moniepoint-oct/round4-2026-10-16.plan.json';
const PROGRESS = opt('progress');

const { loadLiveMysqlEnv } = await imp('scripts/lib/phase2LiveEnv.mjs');
loadLiveMysqlEnv(process.env.ZAREWA_PHASE2_ENV_ROOT || BE, database);
const { mysqlConfigFromEnv, createMysqlDatabase } = await imp('server/mysqlDatabase.js');
const { unlockAccountingPeriod, lockAccountingPeriod } = await imp('server/controlOps.js');
const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database }, { reset: false, bootstrap: false });
const actor = { id: null, displayName: approver, name: approver, jobTitle: 'Operations Manager' };
const lockRow = () => db.prepare(`SELECT * FROM accounting_period_locks WHERE period_key = ?`).get(PERIOD);

let applyStatus = null;
let unlocked = false;
try {
  const before = lockRow();
  if (!before) throw new Error(`${PERIOD} is not locked — refusing to run (expected the Sales phase 1 lock)`);
  if (before.reason !== LOCK_REASON) throw new Error(`${PERIOD} lock reason is "${before.reason}", expected the Sales phase 1 note`);
  const u = unlockAccountingPeriod(db, PERIOD, actor, `${UNLOCK_REASON}. Approved by ${approver}.`);
  if (!u.ok) throw new Error(`unlock failed: ${u.error}`);
  unlocked = true;
  console.log(`unlocked ${PERIOD} at ${new Date().toISOString()}`);
  const r = spawnSync(
    process.execPath,
    [path.join(BE, 'scripts/phase2-apply.mjs'), '--live', '--apply', '--database', database, '--plan', PLAN, '--approver', approver, ...(PROGRESS ? ['--per-item', '--progress', PROGRESS] : [])],
    { cwd: BE, stdio: 'inherit', env: process.env }
  );
  applyStatus = r.status;
  if (r.error) console.error(`apply could not start: ${r.error.message}`);
} catch (e) {
  console.error(`STOPPED: ${e.message}`);
} finally {
  if (unlocked || !lockRow()) {
    const l = lockAccountingPeriod(db, { periodKey: PERIOD, reason: LOCK_REASON }, actor);
    console.log(l.ok ? `relocked ${PERIOD} at ${new Date().toISOString()}` : `RELOCK FAILED: ${l.error} — lock ${PERIOD} by hand now`);
  }
  const after = lockRow();
  console.log(`lock now: ${after ? `${after.period_key} "${after.reason}" by ${after.locked_by_name} at ${after.locked_at_iso}` : 'NONE — September is UNLOCKED'}`);
  db.close?.();
}
console.log(`apply exit status: ${applyStatus}`);
process.exit(applyStatus === 0 ? 0 : 1);
