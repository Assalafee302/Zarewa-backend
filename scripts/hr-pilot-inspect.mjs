process.env.ZAREWA_MYSQL_PASSWORD = process.env.ZAREWA_MYSQL_PASSWORD ?? '';
import { openConfiguredMysql } from '../server/cliMysql.js';
import { listHrStaff } from '../server/hrOps.js';
import { canUseAllBranchesRollup } from '../server/auth.js';

const { db } = openConfiguredMysql({ migrate: false });
const scope = {
  viewAll: canUseAllBranchesRollup({ roleKey: 'admin' }),
  branchId: 'BR-HQ',
  scopeMode: 'org',
};
const rows = db
  .prepare(
    `SELECT u.id, u.username, u.role_key AS roleKey, p.department, p.payroll_group AS payrollGroup,
            p.salary_level AS salaryLevel, p.bank_name AS bankName
     FROM app_users u LEFT JOIN hr_staff_profiles p ON p.user_id = u.id WHERE u.status = 'active'`
  )
  .all();
const runs = db.prepare(`SELECT id, period_yyyymm, status FROM hr_payroll_runs ORDER BY created_at_iso DESC LIMIT 3`).all();
const lineCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_payroll_lines`).get()?.c;
console.log(
  JSON.stringify(
    {
      rawStaffCount: rows.length,
      listHrStaffCount: listHrStaff(db, scope).length,
      staff: rows,
      runs,
      lineCount,
    },
    null,
    2
  )
);
db.close();
