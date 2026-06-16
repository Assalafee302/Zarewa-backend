import { createDatabase } from './db.js';
import { databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { createApp } from './app.js';
import { loadProjectEnv } from './loadProjectEnv.js';

loadProjectEnv();

// E2E database must include default sign-in users (admin, sales.staff, …).
process.env.ZAREWA_ALLOW_SEEDED_USERS = process.env.ZAREWA_ALLOW_SEEDED_USERS || '1';
process.env.NODE_ENV = 'test';
// Repo .env often sets COOKIE_SECURE=1 for production; Playwright uses plain http://127.0.0.1.
process.env.COOKIE_SECURE = '0';
process.env.ZAREWA_COOKIE_DOMAIN = '';

const e2eDb = String(process.env.ZAREWA_MYSQL_E2E_DATABASE || 'zarewa_e2e').trim() || 'zarewa_e2e';
const db = createDatabase({ reset: true, database: e2eDb });
const app = createApp(db);
const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  const cfg = mysqlConfigFromEnv();
  cfg.database = e2eDb;
  console.log(`Zarewa Playwright API listening on http://127.0.0.1:${port} (db: ${databaseLabel(cfg)})`);
});
