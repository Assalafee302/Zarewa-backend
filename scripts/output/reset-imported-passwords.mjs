import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.env.ZAREWA_DB_PATH || 'data/zarewa.sqlite';
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

const db = new Database(dbPath);
const rows = db
  .prepare(`SELECT id, username FROM app_users WHERE status = 'active'`)
  .all()
  .filter((r) => !seeded.has(String(r.username || '').trim().toLowerCase()));

const hash = createPasswordHash(nextPassword);

const upd = db.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`);
const tx = db.transaction(() => {
  for (const r of rows) upd.run(hash, r.id);
});
tx();

console.log(`Reset password for ${rows.length} active non-seeded users in ${dbPath}.`);
