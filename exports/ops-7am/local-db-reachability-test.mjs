// Run on THIS PC (read-only: SELECT 1). Says whether the live MySQL server still accepts connections from here.
//   PASS = the server refuses this host (not allowed / no route / timeout).
//   FAIL = the server accepted the connection, or rejected only the password ("Access denied"): the host is
//          still allowed — a wrong password does not prove Remote MySQL is closed.
// Usage, from the backend folder: node exports/ops-7am/local-db-reachability-test.mjs
// Credentials: the commented ZAREWA_MYSQL_* lines in .env.local on this PC (same source as the Phase 2 scripts).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.argv[2] || process.cwd();
const envFile = path.join(BE, '.env.local');
const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
for (const line of lines) {
  const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
  if (!m || process.env[m[1]]) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}
process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';
const { mysqlConfigFromEnv, createMysqlDatabase } = await import(pathToFileURL(path.join(BE, 'server/mysqlDatabase.js')).href);
const t0 = Date.now();
try {
  const db = createMysqlDatabase({ ...mysqlConfigFromEnv(), database: 'u172282559_ZAREWA' }, { reset: false, bootstrap: false });
  const r = db.prepare('SELECT 1 AS ok, USER() AS seen_as, CURRENT_USER() AS matched_rule').get();
  console.log(`FAIL — connected: seen as ${r.seen_as}, allowed by ${r.matched_rule} (${Date.now() - t0} ms)`);
  db.close?.();
  process.exit(1);
} catch (e) {
  const msg = String(e?.message || e);
  const code = e?.code || '';
  if (code === 'ER_ACCESS_DENIED_ERROR' || /Access denied/i.test(msg)) {
    console.log(`FAIL — host still allowed; only the password was rejected (${code}): ${msg.slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`PASS — refused (${code || 'no code'}): ${msg.slice(0, 160)} (${Date.now() - t0} ms)`);
}
