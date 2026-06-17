process.env.ZAREWA_MYSQL_PASSWORD = process.env.ZAREWA_MYSQL_PASSWORD ?? '';
import { openConfiguredMysql } from '../server/cliMysql.js';
import { listHrStaff, listHrDataCleanupQueue, hrNextUatReadiness } from '../server/hrOps.js';
import { canUseAllBranchesRollup } from '../server/auth.js';

const { db } = openConfiguredMysql({ migrate: false });
const scope = { viewAll: true, branchId: 'BR-HQ', scopeMode: 'org' };
const staff = listHrStaff(db, scope);
const queue = listHrDataCleanupQueue(db, scope);
const uat = hrNextUatReadiness(db, scope);

console.log(JSON.stringify({
  canCutover: uat.canCutover,
  blockers: uat.blockers,
  gates: uat.gates,
  orgNodes: staff.map((s) => ({
    username: s.displayName,
    department: s.department,
    payrollGroup: s.payrollGroup,
    orgNode: s.normalized?.orgNode,
    qualityFlags: s.qualityFlags,
    dataQualityScore: s.dataQualityScore,
  })),
  cleanupQueue: queue,
}, null, 2));
db.close();
