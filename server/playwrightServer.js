import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, defaultDbPath } from './db.js';
import { createApp } from './app.js';

const dbPath = process.env.ZAREWA_DB || defaultDbPath();

/**
 * Remove SQLite main + sidecar files so a fresh seed never inherits a half-deleted WAL (Windows).
 */
function wipePlaywrightSqliteBundle(mainPath) {
  if (mainPath === ':memory:') return;
  const abs = path.resolve(mainPath);
  const paths = [abs, `${abs}-wal`, `${abs}-shm`];
  for (let round = 0; round < 10; round += 1) {
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          try {
            const db = new Database(p);
            try {
              db.pragma('journal_mode = DELETE');
            } catch {
              /* ignore */
            }
            db.close();
          } catch {
            /* locked or not a db */
          }
          fs.rmSync(p, {
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        }
      } catch {
        /* retry round */
      }
    }
    if (paths.every((p) => !fs.existsSync(p))) return;
    const t0 = Date.now();
    while (Date.now() - t0 < 120) {
      /* brief spin for Windows handle release */
    }
  }
}

if (dbPath !== ':memory:') {
  wipePlaywrightSqliteBundle(dbPath);
}

const db = createDatabase(dbPath);
const app = createApp(db);
const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  console.log(`Zarewa Playwright API listening on http://127.0.0.1:${port} (db: ${dbPath})`);
});
