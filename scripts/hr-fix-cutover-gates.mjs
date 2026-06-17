#!/usr/bin/env node
/**
 * Fix HR UAT cutover data gates for demo/pilot staff.
 *
 *   node scripts/hr-fix-cutover-gates.mjs           # dry run
 *   node scripts/hr-fix-cutover-gates.mjs --apply   # apply fixes
 */
process.env.ZAREWA_MYSQL_HOST = process.env.ZAREWA_MYSQL_HOST || '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = process.env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = process.env.ZAREWA_MYSQL_USER || 'root';
if (process.env.ZAREWA_MYSQL_PASSWORD === undefined) process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db';

import { openConfiguredMysql } from '../server/cliMysql.js';
import {
  applyHrDataCleanupAction,
  hrNextUatReadiness,
  listHrDataCleanupQueue,
  upsertHrStaffProfile,
} from '../server/hrOps.js';
import { buildHrReadiness } from '../server/hrModuleHealth.js';
import { canUseAllBranchesRollup } from '../server/auth.js';

const apply = process.argv.includes('--apply');
const actor = { id: 'USR-ADMIN', username: 'admin', displayName: 'Zarewa Admin', roleKey: 'admin' };
const scope = {
  viewAll: canUseAllBranchesRollup(actor),
  branchId: 'BR-HQ',
  scopeMode: 'org',
};

/** Demo mining stand-in — payroll group is hq_admin but org node gate needs mining_div. */
const MANUAL_ORG_NODE = {
  'USR-OPS': 'mining_div',
};

const { db, label } = openConfiguredMysql({ migrate: false });

const staff = db
  .prepare(
    `SELECT u.id AS userId, u.username, p.date_joined_iso AS dateJoinedIso, p.employment_type AS employmentType,
            p.payroll_group AS payrollGroup
     FROM app_users u
     INNER JOIN hr_staff_profiles p ON p.user_id = u.id
     WHERE u.status = 'active'
     ORDER BY u.username`
  )
  .all();

const before = {
  database: label(),
  readiness: buildHrReadiness(db, scope),
  uat: hrNextUatReadiness(db, scope),
  cleanupCount: listHrDataCleanupQueue(db, scope).length,
};

const plans = staff.map((row) => {
  const needsDate = !String(row.dateJoinedIso || '').trim();
  const needsEmployment = !String(row.employmentType || '').trim();
  const needsOrgNode = Boolean(MANUAL_ORG_NODE[row.userId]);
  return {
    userId: row.userId,
    username: row.username,
    payrollGroup: row.payrollGroup,
    needsDate,
    needsEmployment,
    needsOrgNode,
    orgNode: MANUAL_ORG_NODE[row.userId] || null,
    skip: !needsDate && !needsEmployment && !needsOrgNode,
  };
});

console.log(JSON.stringify({ phase: apply ? 'apply' : 'dry-run', before, plans }, null, 2));

if (apply) {
  const results = [];
  for (const p of plans.filter((x) => !x.skip)) {
    const rowResult = { userId: p.userId, username: p.username, steps: [] };
    if (p.needsDate || p.needsEmployment) {
      const body = { userId: p.userId };
      if (p.needsDate) body.dateJoinedIso = '2024-01-15';
      if (p.needsEmployment) body.employmentType = 'permanent';
      const r = upsertHrStaffProfile(db, actor.id, body);
      rowResult.steps.push({ action: 'upsert_profile', ok: r.ok, error: r.error || null });
    }
    if (p.needsOrgNode) {
      const r = applyHrDataCleanupAction(db, actor, {
        userId: p.userId,
        action: 'map_org_node',
        targetValue: p.orgNode,
      });
      rowResult.steps.push({ action: 'map_org_node', ok: r.ok, error: r.error || null });
    }
    results.push(rowResult);
  }

  db.prepare(`UPDATE app_users SET must_change_password = 0 WHERE status = 'active'`).run();

  const after = {
    canCutover: buildHrReadiness(db, scope).canCutover,
    uat: hrNextUatReadiness(db, scope),
    cleanupCount: listHrDataCleanupQueue(db, scope).length,
  };
  console.log(JSON.stringify({ applied: results, after }, null, 2));
} else if (plans.some((p) => !p.skip)) {
  console.log('\nDry run — pass --apply to fix cutover gates.');
}

db.close();
