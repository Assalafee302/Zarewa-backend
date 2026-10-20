/**
 * Live (production) connection for the Phase 2 scripts — only with --live.
 * Reads the commented ZAREWA_MYSQL_* lines from .env.local (Hostinger remote MySQL, as the read-only ops scripts
 * do) unless the variables are already set, and requires ZAREWA_PHASE2_LIVE_CONFIRM to equal the target schema.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadLiveMysqlEnv(repoRoot, database) {
  const file = path.join(repoRoot, '.env.local');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*#\s*(ZAREWA_MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE))=(.*)$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
  process.env.ZAREWA_ALLOW_PROD_MYSQL_SCRIPT = '1';
  if (process.env.ZAREWA_PHASE2_LIVE_CONFIRM !== database) {
    throw new Error(`--live needs ZAREWA_PHASE2_LIVE_CONFIRM=${database}`);
  }
  if (process.env.ZAREWA_MYSQL_DATABASE && process.env.ZAREWA_MYSQL_DATABASE !== database) {
    throw new Error(`--database ${database} does not match the live settings (${process.env.ZAREWA_MYSQL_DATABASE})`);
  }
}
