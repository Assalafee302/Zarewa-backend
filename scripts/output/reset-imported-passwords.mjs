import crypto from 'node:crypto';
import { openConfiguredMysql } from '../../server/cliMysql.js';

const nextPassword = process.env.ZAREWA_RESET_PASSWORD || '';

if (!nextPassword || nextPassword.length < 12) {
  console.error('Set ZAREWA_RESET_PASSWORD to the desired new password (min 12 chars).');
  process.exit(1);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

const seeded = new Set([
  'admin',
  'finance.manager',
  'sales.manager',
  'sales.staff',
  'procurement',
  'operations',
  'viewer',
  'hr.admin',
  'md',
  'ceo',
]);

const { db, label } = openConfiguredMysql({ migrate: false });
const rows = db
  .prepare(`SELECT id, username FROM app_users WHERE status = 'active'`)
  .all()
  .filter((r) => !seeded.has(String(r.username || '').trim().toLowerCase()));

const hash = createPasswordHash(nextPassword);

const upd = db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`);
db.transaction(() => {
  for (const r of rows) upd.run(hash, r.id);
})();

db.close();
console.log(`Reset password for ${rows.length} active non-seeded users in ${label()}.`);
