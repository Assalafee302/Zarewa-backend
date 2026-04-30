import { createDatabase } from './db.js';
import { databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { createApp } from './app.js';
import { loadProjectEnv } from './loadProjectEnv.js';

loadProjectEnv();

const e2eDb = String(process.env.ZAREWA_MYSQL_E2E_DATABASE || 'zarewa_e2e').trim() || 'zarewa_e2e';
const db = createDatabase({ reset: true, database: e2eDb });
const app = createApp(db);
const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  const cfg = mysqlConfigFromEnv();
  cfg.database = e2eDb;
  console.log(`Zarewa Playwright API listening on http://127.0.0.1:${port} (db: ${databaseLabel(cfg)})`);
});
