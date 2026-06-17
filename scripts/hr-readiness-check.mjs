#!/usr/bin/env node
/**
 * HR production readiness report (schema + UAT gates + operational checks).
 * Uses local XAMPP MySQL defaults unless ZAREWA_MYSQL_* already set in the shell.
 *
 *   node scripts/hr-readiness-check.mjs
 */
process.env.ZAREWA_MYSQL_HOST = process.env.ZAREWA_MYSQL_HOST || '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = process.env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = process.env.ZAREWA_MYSQL_USER || 'root';
if (process.env.ZAREWA_MYSQL_PASSWORD === undefined) process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db';

import { openConfiguredMysql } from '../server/cliMysql.js';
import { buildHrReadiness } from '../server/hrModuleHealth.js';
import { getHrOperationalReadiness } from '../server/hrOperationalReadiness.js';
import { listHrObservability, listHrStaff } from '../server/hrOps.js';
import { canUseAllBranchesRollup } from '../server/auth.js';

const { db, label } = openConfiguredMysql({ migrate: false });

const adminUser = {
  id: 'readiness-check',
  roleKey: 'admin',
  permissions: ['*'],
};
const scope = {
  viewAll: canUseAllBranchesRollup(adminUser),
  branchId: 'BR-HQ',
  scopeMode: 'org',
  actorUserId: adminUser.id,
};

const readiness = buildHrReadiness(db, scope);
const operational = getHrOperationalReadiness(db, scope);
const observability = listHrObservability(db, scope);
const staff = listHrStaff(db, scope, { includeInactive: false });

const report = {
  database: label(),
  staffActiveCount: staff.length,
  productionReady: readiness.productionReady,
  canCutover: readiness.canCutover,
  modules: readiness.modules,
  moduleBlockers: readiness.blockers.filter((b) => b.includes('migrate')),
  dataBlockers: readiness.blockers.filter((b) => !b.includes('migrate')),
  gates: readiness.gates,
  observabilitySummary: observability.summary || null,
  operationalReady: operational.readyForOperations,
  operationalTotalIssues: operational.totalIssues,
  operationalChecks: (operational.checks || [])
    .filter((c) => c.count > 0)
    .map((c) => ({ id: c.id, label: c.label, count: c.count, severity: c.severity, fixPath: c.fixPath })),
};

db.close();
console.log(JSON.stringify(report, null, 2));
